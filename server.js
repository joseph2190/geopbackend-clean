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
/* ================= CREATE PAYPAL SUB ===================== */
/* ========================================================= */

app.post("/create-paypal-subscription", async (req, res) => {
  try {
    const { firebaseUid, planId } = req.body;

    if (!firebaseUid || !planId) {
      return res.status(400).json({ error: "Missing firebaseUid or planId" });
    }

    const userRef = db.collection("users").doc(firebaseUid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const userData = userDoc.data();

    /* ================= GET ACCESS TOKEN ================= */

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

    /* ================= CANCEL OLD SUB IF EXISTS ================= */

    if (userData.paypalSubscriptionId) {
      console.log("Cancelling old subscription:", userData.paypalSubscriptionId);

      const cancelRes = await fetch(
        `https://api-m.sandbox.paypal.com/v1/billing/subscriptions/${userData.paypalSubscriptionId}/cancel`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            reason: "User upgraded subscription",
          }),
        }
      );

      console.log("Cancel status:", cancelRes.status);

      if (cancelRes.status !== 204) {
        const cancelText = await cancelRes.text();
        console.error("Cancel failed:", cancelText);
        return res.status(500).json({ error: "Failed to cancel previous subscription" });
      }
    }

    /* ================= CREATE NEW SUBSCRIPTION ================= */

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
          custom_id: firebaseUid,
          subscriber: {
            email_address: userData.email,
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
      return res.status(500).json({ error: "Subscription creation failed" });
    }

    const approveUrl = subData.links.find(link => link.rel === "approve").href;

    res.json({ approveUrl });

  } catch (err) {
    console.error("Create PayPal subscription error:", err);
    res.status(500).json({ error: "PayPal subscription failed" });
  }
});

/* ========================================================= */
/* ================= PAYPAL WEBHOOK ======================== */
/* ========================================================= */

app.post("/paypal-webhook", async (req, res) => {
  try {
    const event = req.body;

    console.log("====== PAYPAL WEBHOOK ======");
    console.log("EVENT:", event.event_type);

    const eventType = event.event_type;
    const resource = event.resource;

    if (!resource) return res.status(200).send("No resource");

    const firebaseUid = resource.custom_id;
    const planId = resource.plan_id;
    const subscriptionId = resource.id;

    if (!firebaseUid) return res.status(200).send("No UID");

    const userRef = db.collection("users").doc(firebaseUid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) return res.status(200).send("User not found");

    /* ===== ACTIVATED ===== */

    if (eventType === "BILLING.SUBSCRIPTION.ACTIVATED") {

      if (
        planId === process.env.PAYPAL_LITE_MONTHLY_PLAN ||
        planId === process.env.PAYPAL_LITE_YEARLY_PLAN
      ) {
        await userRef.update({
          subscriptionTier: "lite",
          subscriptionCredits: 15,
          subscriptionUsed: 0,
          subscriptionStartDate: new Date().toISOString(),
          paypalSubscriptionId: subscriptionId,
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
          paypalSubscriptionId: subscriptionId,
        });
      }
    }

    /* ===== CANCEL / EXPIRE / SUSPEND ===== */

    if (
      eventType === "BILLING.SUBSCRIPTION.CANCELLED" ||
      eventType === "BILLING.SUBSCRIPTION.EXPIRED" ||
      eventType === "BILLING.SUBSCRIPTION.SUSPENDED"
    ) {
      await userRef.update({
        subscriptionTier: "free",
        subscriptionCredits: 5,
        subscriptionUsed: 0,
        paypalSubscriptionId: null,
      });
    }

    res.status(200).send("OK");

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