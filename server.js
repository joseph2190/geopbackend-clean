require("dotenv").config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const DodoPayments = require("dodopayments").default;

const app = express();

/* ================= CORS ================= */

app.use(cors({
  origin: "*", // restrict later to your real domain
  methods: ["GET", "POST", "OPTIONS"],
}));

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
  environment: "test_mode", // change to live_mode in production
});

/* ================= CREATE CHECKOUT SESSION ================= */

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

    const session = await dodo.checkoutSessions.create({
      product_cart: [
        {
          product_id: productId,
          quantity: 1,
        },
      ],
      customer: {
        email: userData.email,
      },
      metadata: {
        firebaseUid,
        productId,
      },
      return_url: "https://ais-dev-nkyqsdho3kbs2ciwpt7hyn-59374719483.europe-west2.run.app/payment-success",
    });

    res.json({ checkoutUrl: session.checkout_url });

  } catch (err) {
    console.error("Checkout session error:", err);
    res.status(500).json({ error: "Session creation failed" });
  }
});

/* ================= DODO WEBHOOK ================= */

app.post("/dodo-webhook", async (req, res) => {
  try {
    const payload = req.body;

    console.log("====== DODO WEBHOOK RECEIVED ======");
    console.log("Event Type:", payload.type);

    const firebaseUid = payload.data?.metadata?.firebaseUid;
    const productId = payload.data?.metadata?.productId;

    if (!firebaseUid) {
      console.log("No firebaseUid in metadata");
      return res.status(200).send("No UID");
    }

    const userRef = db.collection("users").doc(firebaseUid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      console.log("User not found");
      return res.status(200).send("User not found");
    }

    const userData = userDoc.data();

    /* ================= PAYMENT SUCCESS OR RENEW ================= */

    if (
      payload.type === "payment.succeeded" ||
      payload.type === "subscription.renewed"
    ) {

      /* ===== LITE MONTHLY ===== */
      if (productId === process.env.DODO_LITE_PRODUCT_ID) {
        await userRef.update({
          subscriptionTier: "lite",
          subscriptionCredits: 15,
          subscriptionUsed: 0,
          subscriptionType: "monthly",
          subscriptionStartDate: new Date().toISOString(),
        });

        console.log("Lite monthly activated/reset");
      }

      /* ===== LITE YEARLY ===== */
      else if (productId === process.env.DODO_LITE_YEARLY_ID) {
        await userRef.update({
          subscriptionTier: "lite",
          subscriptionCredits: 15,
          subscriptionUsed: 0,
          subscriptionType: "yearly",
          subscriptionStartDate: new Date().toISOString(),
        });

        console.log("Lite yearly activated/reset");
      }

      /* ===== PRO MONTHLY ===== */
      else if (productId === process.env.DODO_PRO_PRODUCT_ID) {
        await userRef.update({
          subscriptionTier: "pro",
          subscriptionCredits: 50,
          subscriptionUsed: 0,
          subscriptionType: "monthly",
          subscriptionStartDate: new Date().toISOString(),
        });

        console.log("Pro monthly activated/reset");
      }

      /* ===== PRO YEARLY ===== */
      else if (productId === process.env.DODO_PRO_YEARLY_ID) {
        await userRef.update({
          subscriptionTier: "pro",
          subscriptionCredits: 50,
          subscriptionUsed: 0,
          subscriptionType: "yearly",
          subscriptionStartDate: new Date().toISOString(),
        });

        console.log("Pro yearly activated/reset");
      }

      /* ===== STARTER PACK ===== */
      else if (productId === process.env.DODO_STARTER_PRODUCT_ID) {
        await userRef.update({
          purchasedCredits: (userData.purchasedCredits || 0) + 5,
        });

        console.log("Added 5 purchased credits");
      }

      /* ===== POWER PACK ===== */
      else if (productId === process.env.DODO_POWER_PRODUCT_ID) {
        await userRef.update({
          purchasedCredits: (userData.purchasedCredits || 0) + 50,
        });

        console.log("Added 50 purchased credits");
      }

      else {
        console.log("Unknown productId:", productId);
      }
    }

    /* ================= SUBSCRIPTION CANCELED ================= */

    if (payload.type === "subscription.canceled") {
      await userRef.update({
        subscriptionTier: "free",
        subscriptionCredits: 0,
        subscriptionUsed: 0,
        subscriptionType: null,
      });

      console.log("Subscription canceled → downgraded to free");
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

/* ================= START SERVER ================= */

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});