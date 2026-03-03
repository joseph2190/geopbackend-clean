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
  environment: "test_mode", // change to live_mode later
});

/* ===================================================== */
/* ================= UTILITY HELPERS =================== */
/* ===================================================== */

async function getPayPalAccessToken() {
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
    throw new Error("PayPal token failed");
  }

  return tokenData.access_token;
}

async function cancelPayPalSubscription(subscriptionId) {
  const accessToken = await getPayPalAccessToken();

  const cancelRes = await fetch(
    `https://api-m.sandbox.paypal.com/v1/billing/subscriptions/${subscriptionId}/cancel`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reason: "User upgraded plan" }),
    }
  );

  if (cancelRes.status !== 204) {
    const text = await cancelRes.text();
    console.error("PayPal cancel failed:", text);
    throw new Error("Failed to cancel PayPal subscription");
  }
}

async function cancelDodoSubscription(subscriptionId) {
  await dodo.subscriptions.cancel(subscriptionId);
}

/* ===================================================== */
/* ============ UNIFIED CANCEL OLD SUB ================= */
/* ===================================================== */

async function cancelOldSubscription(userData) {
  if (!userData.subscriptionId || !userData.subscriptionProvider) return;

  console.log("Cancelling old subscription:",
    userData.subscriptionProvider,
    userData.subscriptionId
  );

  if (userData.subscriptionProvider === "paypal") {
    await cancelPayPalSubscription(userData.subscriptionId);
  }

  if (userData.subscriptionProvider === "dodo") {
    await cancelDodoSubscription(userData.subscriptionId);
  }
}

/* ===================================================== */
/* ================= CREATE PAYPAL SUB ================= */
/* ===================================================== */

app.post("/create-paypal-subscription", async (req, res) => {
  try {
    const { firebaseUid, planId } = req.body;

    const userRef = db.collection("users").doc(firebaseUid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const userData = userDoc.data();

    // Cancel previous subscription (any provider)
    await cancelOldSubscription(userData);

    const accessToken = await getPayPalAccessToken();

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
      console.error(subData);
      return res.status(500).json({ error: "Subscription failed" });
    }

    const approveUrl = subData.links.find(l => l.rel === "approve").href;

    res.json({ approveUrl });

  } catch (err) {
    console.error("PayPal create error:", err);
    res.status(500).json({ error: "PayPal subscription failed" });
  }
});

/* ===================================================== */
/* ================= CREATE DODO SUB =================== */
/* ===================================================== */

app.post("/create-dodo-subscription", async (req, res) => {
  try {
    const { firebaseUid, productId } = req.body;

    const userRef = db.collection("users").doc(firebaseUid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const userData = userDoc.data();

    // Cancel previous subscription (any provider)
    await cancelOldSubscription(userData);

    const session = await dodo.checkoutSessions.create({
      product_cart: [{ product_id: productId, quantity: 1 }],
      customer: { email: userData.email },
      metadata: { firebaseUid },
      return_url: "https://ais-dev-nkyqsdho3kbs2ciwpt7hyn-59374719483.europe-west2.run.app/payment-success",
    });

    res.json({ checkoutUrl: session.checkout_url });

  } catch (err) {
    console.error("Dodo create error:", err);
    res.status(500).json({ error: "Dodo subscription failed" });
  }
});

/* ===================================================== */
/* ================= PAYPAL WEBHOOK ==================== */
/* ===================================================== */

app.post("/paypal-webhook", async (req, res) => {
  try {
    const event = req.body;
    const resource = event.resource;
    if (!resource) return res.status(200).send("No resource");

    const firebaseUid = resource.custom_id;
    const subscriptionId = resource.id;
    const planId = resource.plan_id;
    const eventType = event.event_type;

    if (!firebaseUid) return res.status(200).send("No UID");

    const userRef = db.collection("users").doc(firebaseUid);

    if (eventType === "BILLING.SUBSCRIPTION.ACTIVATED") {

      let tier = "free";
      let credits = 5;

      if (
        planId === process.env.PAYPAL_LITE_MONTHLY_PLAN ||
        planId === process.env.PAYPAL_LITE_YEARLY_PLAN
      ) {
        tier = "lite";
        credits = 15;
      }

      if (
        planId === process.env.PAYPAL_PRO_MONTHLY_PLAN ||
        planId === process.env.PAYPAL_PRO_YEARLY_PLAN
      ) {
        tier = "pro";
        credits = 50;
      }

      await userRef.update({
        subscriptionTier: tier,
        subscriptionCredits: credits,
        subscriptionUsed: 0,
        subscriptionStartDate: new Date().toISOString(),
        subscriptionProvider: "paypal",
        subscriptionId: subscriptionId,
        subscriptionStatus: "active",
      });
    }

    if (
      eventType === "BILLING.SUBSCRIPTION.CANCELLED" ||
      eventType === "BILLING.SUBSCRIPTION.EXPIRED" ||
      eventType === "BILLING.SUBSCRIPTION.SUSPENDED"
    ) {
      await userRef.update({
        subscriptionTier: "free",
        subscriptionCredits: 5,
        subscriptionUsed: 0,
        subscriptionProvider: null,
        subscriptionId: null,
        subscriptionStatus: "cancelled",
      });
    }

    res.status(200).send("OK");

  } catch (err) {
    console.error("PayPal webhook error:", err);
    res.status(200).send("Handled");
  }
});

/* ===================================================== */
/* ================= DODO WEBHOOK ====================== */
/* ===================================================== */

app.post("/dodo-webhook", async (req, res) => {
  try {
    const payload = req.body;

    const firebaseUid = payload.data?.metadata?.firebaseUid;
    const subscriptionId = payload.data?.id;

    if (!firebaseUid) return res.status(200).send("No UID");

    const userRef = db.collection("users").doc(firebaseUid);

    if (payload.type === "subscription.active") {

      await userRef.update({
        subscriptionTier: "lite", // map properly per productId if needed
        subscriptionCredits: 15,
        subscriptionUsed: 0,
        subscriptionStartDate: new Date().toISOString(),
        subscriptionProvider: "dodo",
        subscriptionId: subscriptionId,
        subscriptionStatus: "active",
      });
    }

    if (payload.type === "subscription.canceled") {
      await userRef.update({
        subscriptionTier: "free",
        subscriptionCredits: 5,
        subscriptionUsed: 0,
        subscriptionProvider: null,
        subscriptionId: null,
        subscriptionStatus: "cancelled",
      });
    }

    res.status(200).send("OK");

  } catch (err) {
    console.error("Dodo webhook error:", err);
    res.status(200).send("Handled");
  }
});

/* ================= START SERVER ================= */

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});