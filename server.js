require("dotenv").config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const DodoPayments = require("dodopayments");

const app = express();

app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"] }));
app.use(express.json());

/* ================= FIREBASE ================= */

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const db = admin.firestore();

/* ================= DODO ================= */

const dodo = new DodoPayments({
  bearerToken: process.env.DODO_PAYMENTS_API_KEY,
  environment: "test_mode",
});

/* ================= CREATE CHECKOUT ================= */

app.post("/create-checkout-session", async (req, res) => {
  try {
    const { firebaseUid, productId } = req.body;

    if (!firebaseUid || !productId) {
      return res.status(400).json({ error: "Missing data" });
    }

    const userDoc = await db.collection("users").doc(firebaseUid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const userData = userDoc.data();

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
        productId: productId, // 🔥 IMPORTANT FIX
      },
      return_url: "https://ais-dev-nkyqsdho3kbs2ciwpt7hyn-59374719483.europe-west2.run.app/payment-success",
    });

    res.json({ checkoutUrl: session.checkout_url });

  } catch (err) {
    console.error("Checkout error:", err);
    res.status(500).json({ error: "Failed to create session" });
  }
});

/* ================= WEBHOOK ================= */

app.post("/dodo-webhook", async (req, res) => {
  try {
    const payload = req.body;

    console.log("====== DODO WEBHOOK RECEIVED ======");
    console.log("Event Type:", payload.type);

    if (payload.type === "payment.succeeded") {

      const firebaseUid = payload.data?.metadata?.firebaseUid;
      const productId = payload.data?.metadata?.productId; // 🔥 READ FROM METADATA

      console.log("UID:", firebaseUid);
      console.log("Product ID:", productId);

      if (!firebaseUid || !productId) {
        console.log("Missing metadata");
        return res.status(200).send("Missing metadata");
      }

      const userRef = db.collection("users").doc(firebaseUid);
      const userDoc = await userRef.get();
      if (!userDoc.exists) {
        console.log("User not found");
        return res.status(200).send("User not found");
      }

      const currentData = userDoc.data();

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

    res.status(200).send("Webhook processed");

  } catch (err) {
    console.error("Webhook error:", err);
    res.status(200).send("Error handled safely");
  }
});

/* ================= ROOT ================= */

app.get("/", (req, res) => {
  res.send("Backend running");
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});