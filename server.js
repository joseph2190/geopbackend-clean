require("dotenv").config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const DodoPayments = require("dodopayments");

const app = express();

/* ================= CORS ================= */
app.use(cors({
  origin: "*",
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
  environment: "test_mode",
});

/* ========================================================= */
/* ================= CREATE DODO CHECKOUT ================== */
/* ========================================================= */

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

/* ========================================================= */
/* ================= CREATE PAYPAL SUB ===================== */
/* ========================================================= */

app.post("/create-paypal-subscription", async (req, res) => {
  try {
    const { firebaseUid, planId } = req.body;

    if (!firebaseUid || !planId) {
      return res.status(400).json({ error: "Missing firebaseUid or planId" });
    }

    const userDoc = await db.collection("users").doc(firebaseUid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    /* ===== 1. GET ACCESS TOKEN ===== */

    const auth = Buffer.from(
      process.env.PAYPAL_CLIENT_ID + ":" + process.env.PAYPAL_SECRET
    ).toString("base64");

    const tokenRes = await fetch(
      "https://api-m.sandbox.paypal.com/v1/oauth2/token",
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      }
    );

    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      console.error("PayPal token error:", tokenData);
      return res.status(500).json({ error: "PayPal auth failed" });
    }

    const accessToken = tokenData.access_token;

    /* ===== 2. CREATE SUBSCRIPTION ===== */

    const subRes = await fetch(
      "https://api-m.sandbox.paypal.com/v1/billing/subscriptions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          plan_id: planId,
          subscriber: {
            email_address: userDoc.data().email,
          },
          application_context: {
            brand_name: "GeoPixel",
            user_action: "SUBSCRIBE_NOW",
            return_url: "https://ais-dev-nkyqsdho3kbs2ciwpt7hyn-59374719483.europe-west2.run.app/payment-success",
            cancel_url: "https://ais-dev-nkyqsdho3kbs2ciwpt7hyn-59374719483.europe-west2.run.app/pricing",
          },
        }),
      }
    );

    const subData = await subRes.json();

    if (!subData.links) {
      console.error("PayPal subscription error:", subData);
      return res.status(500).json({ error: "PayPal subscription failed" });
    }

    const approveUrl = subData.links.find(
      (link) => link.rel === "approve"
    ).href;

    res.json({ approveUrl });

  } catch (err) {
    console.error("PayPal create subscription error:", err);
    res.status(500).json({ error: "PayPal subscription failed" });
  }
});

/* ========================================================= */
/* ================= DODO WEBHOOK ========================== */
/* ========================================================= */

app.post("/dodo-webhook", async (req, res) => {
  try {
    const payload = req.body;

    console.log("====== DODO WEBHOOK RECEIVED ======");
    console.log("Event Type:", payload.type);

    const firebaseUid = payload.data?.metadata?.firebaseUid;
    const productId = payload.data?.metadata?.productId;

    if (!firebaseUid) return res.status(200).send("No UID");

    const userRef = db.collection("users").doc(firebaseUid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(200).send("User not found");

    const userData = userDoc.data();

    if (payload.type === "payment.succeeded") {

      if (productId === process.env.DODO_LITE_PRODUCT_ID) {
        await userRef.update({
          subscriptionTier: "lite",
          subscriptionCredits: 15,
          subscriptionUsed: 0,
          subscriptionStartDate: new Date().toISOString(),
        });
      }

      else if (productId === process.env.DODO_PRO_PRODUCT_ID) {
        await userRef.update({
          subscriptionTier: "pro",
          subscriptionCredits: 50,
          subscriptionUsed: 0,
          subscriptionStartDate: new Date().toISOString(),
        });
      }

      else if (productId === process.env.DODO_STARTER_PRODUCT_ID) {
        await userRef.update({
          purchasedCredits: (userData.purchasedCredits || 0) + 5,
        });
      }

      else if (productId === process.env.DODO_POWER_PRODUCT_ID) {
        await userRef.update({
          purchasedCredits: (userData.purchasedCredits || 0) + 50,
        });
      }
    }

    res.status(200).send("Webhook processed");

  } catch (err) {
    console.error("Dodo Webhook error:", err);
    res.status(200).send("Error handled safely");
  }
});

/* ========================================================= */
/* ================= PAYPAL WEBHOOK ======================== */
/* ========================================================= */

app.post("/paypal-webhook", async (req, res) => {
  try {
    const event = req.body;

    console.log("====== PAYPAL WEBHOOK ======");
    console.log("Event:", event.event_type);

    if (event.event_type === "BILLING.SUBSCRIPTION.ACTIVATED") {

      const email = event.resource.subscriber.email_address;
      const planId = event.resource.plan_id;

      const snapshot = await db.collection("users")
        .where("email", "==", email)
        .get();

      if (snapshot.empty) return res.status(200).send("User not found");

      const userRef = snapshot.docs[0].ref;

      if (
        planId === process.env.PAYPAL_LITE_MONTHLY_PLAN ||
        planId === process.env.PAYPAL_LITE_YEARLY_PLAN
      ) {
        await userRef.update({
          subscriptionTier: "lite",
          subscriptionCredits: 15,
          subscriptionUsed: 0,
          subscriptionStartDate: new Date().toISOString(),
        });
      }

      else if (
        planId === process.env.PAYPAL_PRO_MONTHLY_PLAN ||
        planId === process.env.PAYPAL_PRO_YEARLY_PLAN
      ) {
        await userRef.update({
          subscriptionTier: "pro",
          subscriptionCredits: 50,
          subscriptionUsed: 0,
          subscriptionStartDate: new Date().toISOString(),
        });
      }

      console.log("PayPal subscription activated successfully");
    }

    res.status(200).send("OK");

  } catch (err) {
    console.error("PayPal webhook error:", err);
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