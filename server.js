require("dotenv").config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const DodoPayments = require("dodopayments");

const app = express();

/* =========================================
   CORS CONFIGURATION
   (Temporary allow all for testing)
========================================= */
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
}));

/* =========================================
   FIREBASE INITIALIZATION
========================================= */
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const db = admin.firestore();

/* =========================================
   DODO CLIENT INITIALIZATION
========================================= */
const dodo = new DodoPayments({
  bearerToken: process.env.DODO_PAYMENTS_API_KEY,
  environment: "test_mode", // change to live_mode later
});

/* =========================================
   PARSE JSON FOR NORMAL ROUTES
========================================= */
app.use(express.json());

/* =========================================
   CREATE CHECKOUT SESSION
========================================= */
app.post("/create-checkout-session", async (req, res) => {
  try {
    console.log("=== CREATE CHECKOUT SESSION CALLED ===");

    const { firebaseUid, productId } = req.body;

    if (!firebaseUid || !productId) {
      return res.status(400).json({ error: "Missing firebaseUid or productId" });
    }

    const userDoc = await db.collection("users").doc(firebaseUid).get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const userData = userDoc.data();

    console.log("Creating Dodo session for:", userData.email);

    const session = await dodo.checkoutSessions.create({
      product_cart: [
        {
          product_id: productId,
          quantity: 1,
        },
      ],
      customer: {
        email: userData.email,
        name: userData.email,
      },
      metadata: {
        firebaseUid: firebaseUid,
      },
      return_url: "https://ais-dev-nkyqsdho3kbs2ciwpt7hyn-59374719483.europe-west2.run.app/payment-success",
    });

    return res.json({ checkoutUrl: session.checkout_url });

  } catch (err) {
    console.error("Checkout session error:", err);
    return res.status(500).json({ error: "Session creation failed" });
  }
});

/* =========================================
   DODO WEBHOOK
========================================= */
app.post("/dodo-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const payload = JSON.parse(req.body.toString());

    console.log("====== DODO WEBHOOK RECEIVED ======");
    console.log("Event Type:", payload.type);

    if (payload.type === "payment.succeeded") {

      const firebaseUid = payload.data?.metadata?.firebaseUid;
      const productId = payload.data?.product_cart?.[0]?.product_id;

      if (!firebaseUid || !productId) {
        console.log("Missing metadata or productId");
        return res.status(200).send("Missing metadata");
      }

      const userRef = db.collection("users").doc(firebaseUid);
      const userDoc = await userRef.get();

      if (!userDoc.exists) {
        console.log("User not found");
        return res.status(200).send("User not found");
      }

      const currentData = userDoc.data();

      /* ===== SUBSCRIPTIONS ===== */
      if (productId === process.env.DODO_LITE_PRODUCT_ID) {
        await userRef.update({
          subscriptionTier: "lite",
          subscriptionCredits: 15,
          subscriptionUsed: 0,
        });
        console.log("User upgraded to Lite");
      }

      else if (productId === process.env.DODO_PRO_PRODUCT_ID) {
        await userRef.update({
          subscriptionTier: "pro",
          subscriptionCredits: 50,
          subscriptionUsed: 0,
        });
        console.log("User upgraded to Pro");
      }

      /* ===== CREDIT PACKS ===== */
      else if (productId === process.env.DODO_STARTER_PRODUCT_ID) {
        await userRef.update({
          purchasedCredits: (currentData.purchasedCredits || 0) + 5,
        });
        console.log("Added 5 credits");
      }

      else if (productId === process.env.DODO_POWER_PRODUCT_ID) {
        await userRef.update({
          purchasedCredits: (currentData.purchasedCredits || 0) + 50,
        });
        console.log("Added 50 credits");
      }

      else {
        console.log("Unknown product ID:", productId);
      }
    }

    return res.status(200).send("Webhook processed");

  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(200).send("Error handled safely");
  }
});

/* =========================================
   ROOT ROUTE
========================================= */
app.get("/", (req, res) => {
  res.send("Backend running");
});

/* =========================================
   START SERVER
========================================= */
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});