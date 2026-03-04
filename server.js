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
/* ================= PAYPAL HELPERS ==================== */
/* ===================================================== */

async function getPayPalAccessToken() {
  const auth = Buffer.from(
    process.env.PAYPAL_CLIENT_ID + ":" + process.env.PAYPAL_SECRET
  ).toString("base64");

  const res = await fetch(
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

  const data = await res.json();
  if (!data.access_token) throw new Error("PayPal auth failed");
  return data.access_token;
}

async function cancelPayPalSubscription(subscriptionId) {
  const token = await getPayPalAccessToken();

  await fetch(
    `https://api-m.sandbox.paypal.com/v1/billing/subscriptions/${subscriptionId}/cancel`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reason: "User upgraded plan" }),
    }
  );

  console.log("PayPal subscription cancelled:", subscriptionId);
}

/* ===================================================== */
/* ================= DODO CANCEL (REST) ================ */
/* ===================================================== */

async function cancelDodoSubscription(subscriptionId) {
  try {
    await dodo.subscriptions.update(subscriptionId, {
      status: "cancelled"
    });

    console.log("Dodo subscription cancelled:", subscriptionId);
  } catch (err) {
    console.error("Dodo cancel failed:", err.message);
  }
}

/* ===================================================== */
/* ============= CANCEL OLD SUB (UNIFIED) ============== */
/* ===================================================== */

async function cancelOldSubscription(userData) {
  if (!userData.subscriptionId || !userData.subscriptionProvider) return;

  console.log(
    "Cancelling old:",
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
/* ================= DODO CHECKOUT ===================== */
/* ===================================================== */

app.post("/create-checkout-session", async (req, res) => {
  try {
    const { firebaseUid, productId } = req.body;

    const userRef = db.collection("users").doc(firebaseUid);
    const userDoc = await userRef.get();
    if (!userDoc.exists)
      return res.status(404).json({ error: "User not found" });

    const userData = userDoc.data();

    await cancelOldSubscription(userData);

    const session = await dodo.checkoutSessions.create({
      product_cart: [{ product_id: productId, quantity: 1 }],
      customer: { email: userData.email },
      metadata: { firebaseUid, productId },
      return_url:
        "https://ais-dev-nkyqsdho3kbs2ciwpt7hyn-59374719483.europe-west2.run.app/payment-success",
    });

    res.json({ checkoutUrl: session.checkout_url });
  } catch (err) {
    console.error("Dodo subscription error:", err);
    res.status(500).json({ error: "Dodo subscription failed" });
  }
});

/* ===================================================== */
/* ================= PAYPAL CREATE ===================== */
/* ===================================================== */

app.post("/create-paypal-subscription", async (req, res) => {
  try {
    const { firebaseUid, planId } = req.body;

    const userRef = db.collection("users").doc(firebaseUid);
    const userDoc = await userRef.get();
    if (!userDoc.exists)
      return res.status(404).json({ error: "User not found" });

    const userData = userDoc.data();

    await cancelOldSubscription(userData);

    const token = await getPayPalAccessToken();

    const subRes = await fetch(
      "https://api-m.sandbox.paypal.com/v1/billing/subscriptions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          plan_id: planId,
          custom_id: firebaseUid,
          subscriber: { email_address: userData.email },
          application_context: {
            brand_name: "GeoPixel",
            user_action: "SUBSCRIBE_NOW",
            return_url:
              "https://ais-dev-nkyqsdho3kbs2ciwpt7hyn-59374719483.europe-west2.run.app/payment-success",
            cancel_url:
              "https://ais-dev-nkyqsdho3kbs2ciwpt7hyn-59374719483.europe-west2.run.app/pricing",
          },
        }),
      }
    );

    const subData = await subRes.json();
    if (!subData.links)
      return res.status(500).json({ error: "PayPal failed" });

    const approveUrl = subData.links.find(l => l.rel === "approve").href;
    res.json({ approveUrl });
  } catch (err) {
    console.error("PayPal create error:", err);
    res.status(500).json({ error: "PayPal subscription failed" });
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
    const userDoc = await userRef.get();
    const userData = userDoc.data();

    if (eventType === "BILLING.SUBSCRIPTION.ACTIVATED") {

      if (
        userData.subscriptionProvider &&
        userData.subscriptionProvider !== "paypal"
      ) {
        console.log("Ignoring PayPal activation (another provider active)");
        return res.status(200).send("Ignored");
      }

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

      console.log("PayPal activated:", tier);
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

      console.log("PayPal cancelled");
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
    const productId = payload.data?.metadata?.productId;

    const subscriptionId =
      payload.data?.subscription_id ||
      payload.data?.subscription?.id ||
      null;

    if (!firebaseUid) return res.status(200).send("No UID");

    const userRef = db.collection("users").doc(firebaseUid);
    const userDoc = await userRef.get();
    const userData = userDoc.data();

    if (payload.type === "payment.succeeded") {

      if (
        userData.subscriptionProvider &&
        userData.subscriptionProvider !== "dodo"
      ) {
        console.log("Ignoring Dodo activation (another provider active)");
        return res.status(200).send("Ignored");
      }

      let tier = "free";
      let credits = 5;

     if (
  productId === process.env.DODO_LITE_MONTHLY_PRODUCT_ID ||
  productId === process.env.DODO_LITE_YEARLY_PRODUCT_ID
) {
  tier = "lite";
  credits = 15;
}

if (
  productId === process.env.DODO_PRO_MONTHLY_PRODUCT_ID ||
  productId === process.env.DODO_PRO_YEARLY_PRODUCT_ID
) {
  tier = "pro";
  credits = 50;
}

      await userRef.update({
        subscriptionTier: tier,
        subscriptionCredits: credits,
        subscriptionUsed: 0,
        subscriptionStartDate: new Date().toISOString(),
        subscriptionProvider: "dodo",
        subscriptionId: subscriptionId,
        subscriptionStatus: "active",
      });

      console.log("Dodo activated:", tier);
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

      console.log("Dodo cancelled");
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