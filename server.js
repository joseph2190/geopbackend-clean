require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const admin = require("firebase-admin");

const app = express();
app.use(cors());

// -----------------------------
// FIREBASE ADMIN INIT
// -----------------------------
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const db = admin.firestore();

// -----------------------------
// BASIC HEALTH ROUTE
// -----------------------------
app.get("/", (req, res) => {
  res.send("Backend running");
});

// -----------------------------
// CREATE CHECKOUT SESSION
// -----------------------------
app.use(express.json());

app.post("/create-checkout-session", async (req, res) => {
  try {
    console.log("=== CREATE CHECKOUT SESSION CALLED ===");

    const { firebaseUid, productId } = req.body;

    if (!firebaseUid || !productId) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    const userRef = db.collection("users").doc(firebaseUid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const userEmail = userSnap.data().email;

    console.log("Creating Dodo session for:", userEmail);

    const response = await fetch("https://api.dodopayments.com/checkout_sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.DODO_SECRET_KEY}`,
      },
      body: JSON.stringify({
        product_cart: [
          {
            product_id: productId,
            quantity: 1,
          },
        ],
        customer: {
          email: userEmail,
        },
        metadata: {
          firebaseUid: firebaseUid,
          productId: productId,
        },
        return_url: "https://ais-dev-nkyqsdho3kbs2ciwpt7hyn-59374719483.europe-west2.run.app/payment-success",
      }),
    });

    const data = await response.json();

    if (!data.checkout_url) {
      console.error("Dodo error:", data);
      return res.status(500).json({ error: "Failed to create checkout session" });
    }

    res.json({ checkoutUrl: data.checkout_url });

  } catch (err) {
    console.error("Checkout session error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// -----------------------------
// DODO WEBHOOK
// IMPORTANT: MUST USE RAW BODY
// -----------------------------
app.post("/dodo-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    console.log("====== DODO WEBHOOK RECEIVED ======");

    const event = JSON.parse(req.body.toString());

    console.log("Event Type:", event.type);

    if (event.type !== "payment.succeeded") {
      return res.sendStatus(200);
    }

    const data = event.data;

    const metadata = data.metadata || {};
    const firebaseUid = metadata.firebaseUid;
    const productId = metadata.productId;

    console.log("UID:", firebaseUid);
    console.log("Product ID:", productId);

    if (!firebaseUid || !productId) {
      console.log("Missing metadata or productId");
      return res.sendStatus(200);
    }

    const userRef = db.collection("users").doc(firebaseUid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      console.log("User not found");
      return res.sendStatus(200);
    }

    let updateData = {};

    // ---------------- LITE MONTHLY ----------------
    if (productId === process.env.DODO_LITE_PRODUCT_ID) {
      updateData = {
        subscriptionTier: "lite",
        subscriptionCredits: 15,
        subscriptionUsed: 0,
        subscriptionType: "monthly",
        subscriptionStartDate: new Date().toISOString(),
      };
    }

    // ---------------- LITE YEARLY ----------------
    else if (productId === process.env.DODO_LITE_YEARLY_ID) {
      updateData = {
        subscriptionTier: "lite",
        subscriptionCredits: 15,
        subscriptionUsed: 0,
        subscriptionType: "yearly",
        subscriptionStartDate: new Date().toISOString(),
      };
    }

    // ---------------- PRO MONTHLY ----------------
    else if (productId === process.env.DODO_PRO_PRODUCT_ID) {
      updateData = {
        subscriptionTier: "pro",
        subscriptionCredits: 50,
        subscriptionUsed: 0,
        subscriptionType: "monthly",
        subscriptionStartDate: new Date().toISOString(),
      };
    }

    // ---------------- PRO YEARLY ----------------
    else if (productId === process.env.DODO_PRO_YEARLY_ID) {
      updateData = {
        subscriptionTier: "pro",
        subscriptionCredits: 50,
        subscriptionUsed: 0,
        subscriptionType: "yearly",
        subscriptionStartDate: new Date().toISOString(),
      };
    }

    else {
      console.log("Unknown productId");
      return res.sendStatus(200);
    }

    await userRef.update(updateData);

    console.log("User upgraded to:", updateData.subscriptionTier, updateData.subscriptionType);

    res.sendStatus(200);

  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});