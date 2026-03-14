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

    if (!firebaseUid || !planId) {
      return res.status(400).json({ error: "Missing firebaseUid or planId" });
    }

    const userRef = db.collection("users").doc(firebaseUid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const userData = userDoc.data();

    console.log("Creating PayPal subscription for:", userData.email);
    console.log("Using Plan ID:", planId);

    /* ================= GET ACCESS TOKEN ================= */

    const token = await getPayPalAccessToken();

    /* ================= CREATE SUBSCRIPTION ================= */

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
          subscriber: {
            email_address: userData.email,
          },
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

    console.log(
      "PayPal subscription response:",
      JSON.stringify(subData, null, 2)
    );

    /* ================= ERROR HANDLING ================= */

    if (!subRes.ok) {
      console.error("PayPal API error:", subData);
      return res.status(500).json({
        error: "PayPal API error",
        details: subData,
      });
    }

    if (!subData || !subData.links) {
      console.error("Invalid PayPal response structure:", subData);
      return res.status(500).json({
        error: "Invalid PayPal response",
      });
    }

    const approveLink = subData.links.find(
      (link) => link.rel === "approve"
    );

    if (!approveLink || !approveLink.href) {
      console.error("Approve link not found in response:", subData);
      return res.status(500).json({
        error: "Approval URL not returned by PayPal",
      });
    }

    /* ================= SUCCESS ================= */

    res.json({
      approveUrl: approveLink.href,
    });

  } catch (err) {
    console.error("PayPal create subscription error:", err);
    res.status(500).json({
      error: "Internal PayPal subscription error",
    });
  }
});
/* ===================================================== */
/* ================= PAYPAL CREDIT PACK ================= */
/* ===================================================== */

app.post("/create-paypal-pack", async (req, res) => {
  try {

    const { firebaseUid, pack } = req.body;

    if (!firebaseUid || !pack) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    const userRef = db.collection("users").doc(firebaseUid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const userData = userDoc.data();

    const token = await getPayPalAccessToken();

    let amount = "0.00";
    let description = "";

    if (pack === "starter") {
      amount = "3.00";
      description = "starter_pack";
    }

    if (pack === "power") {
      amount = "15.00";
      description = "power_pack";
    }

    console.log("Creating PayPal pack order:", pack);

    const orderRes = await fetch(
      "https://api-m.sandbox.paypal.com/v2/checkout/orders",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          intent: "CAPTURE",
          purchase_units: [
            {
              custom_id: firebaseUid,
              description: description,
              amount: {
                currency_code: "USD",
                value: amount
              }
            }
          ],
          application_context: {
            brand_name: "GeoPixel",
            user_action: "PAY_NOW",
            return_url:
              "https://ais-dev-nkyqsdho3kbs2ciwpt7hyn-59374719483.europe-west2.run.app/payment-success",
            cancel_url:
              "https://ais-dev-nkyqsdho3kbs2ciwpt7hyn-59374719483.europe-west2.run.app/pricing"
          }
        })
      }
    );

    const orderData = await orderRes.json();

    console.log("PayPal order response:", orderData);

    const approveLink = orderData.links.find(l => l.rel === "approve");

    if (!approveLink) {
      return res.status(500).json({ error: "Approval link missing" });
    }

    res.json({
      approveUrl: approveLink.href
    });

  } catch (err) {

    console.error("PayPal pack error:", err);

    res.status(500).json({
      error: "PayPal pack checkout failed"
    });

  }
});
/* ===================================================== */
/* ================= PAYPAL WEBHOOK ==================== */
/* ===================================================== */

app.post("/paypal-webhook", async (req, res) => {
  try {

    const event = req.body;
    const eventType = event.event_type;
    const resource = event.resource;

    if (!resource) return res.status(200).send("No resource");

    console.log("====== PAYPAL WEBHOOK ======");
    console.log("EVENT:", eventType);
	
/* ===================================================== */
/* ================= CREDIT PACK PURCHASE =============== */
/* ===================================================== */

if (
  eventType === "PAYMENT.CAPTURE.COMPLETED" ||
  eventType === "CHECKOUT.ORDER.APPROVED"
) {

  const purchaseUnit = resource.purchase_units?.[0];

  const firebaseUid = purchaseUnit?.custom_id;
  const description = purchaseUnit?.description;

  if (!firebaseUid) {
    console.log("No firebaseUid in PayPal pack purchase");
    return res.status(200).send("No UID");
  }

  const userRef = db.collection("users").doc(firebaseUid);

  if (description === "starter_pack") {

    await userRef.update({
      purchasedCredits: admin.firestore.FieldValue.increment(5)
    });

    console.log("Starter pack purchased (+5 credits)");
    return res.status(200).send("Credits added");
  }

  if (description === "power_pack") {

    await userRef.update({
      purchasedCredits: admin.firestore.FieldValue.increment(50)
    });

    console.log("Power pack purchased (+50 credits)");
    return res.status(200).send("Credits added");
  }

  return res.status(200).send("Pack processed");
}
    /* ===================================================== */
    /* ================= SUBSCRIPTION EVENTS ================ */
    /* ===================================================== */

    const firebaseUid = resource.custom_id;
    const subscriptionId = resource.id;
    const planId = resource.plan_id;

    if (!firebaseUid) {
      console.log("No firebaseUid in subscription event");
      return res.status(200).send("No UID");
    }

    const userRef = db.collection("users").doc(firebaseUid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      console.log("User not found in Firestore");
      return res.status(200).send("User not found");
    }

    const userData = userDoc.data();

    /* ===================================================== */
    /* ================= SUB ACTIVATED ===================== */
    /* ===================================================== */

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

      const oldProvider = userData.subscriptionProvider;
      const oldSubscriptionId = userData.subscriptionId;

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

      /* ============ Cancel previous subscription ============ */

      if (
        oldSubscriptionId &&
        oldProvider &&
        oldSubscriptionId !== subscriptionId
      ) {

        console.log("Cancelling previous subscription");

        if (oldProvider === "paypal") {
          await cancelPayPalSubscription(oldSubscriptionId);
        }

        if (oldProvider === "dodo") {
          await cancelDodoSubscription(oldSubscriptionId);
        }
      }
    }

    /* ===================================================== */
    /* ================= SUB CANCELLED ===================== */
    /* ===================================================== */

    if (
      eventType === "BILLING.SUBSCRIPTION.CANCELLED" ||
      eventType === "BILLING.SUBSCRIPTION.EXPIRED" ||
      eventType === "BILLING.SUBSCRIPTION.SUSPENDED"
    ) {

      if (userData.subscriptionId === subscriptionId) {

        await userRef.update({
          subscriptionTier: "free",
          subscriptionCredits: 5,
          subscriptionUsed: 0,
          subscriptionProvider: null,
          subscriptionId: null,
          subscriptionStatus: "cancelled",
        });

        console.log("PayPal cancelled active subscription");

      } else {

        console.log("Ignored old cancellation");

      }
    }

    res.status(200).send("OK");

  } catch (err) {

    console.error("PayPal webhook error:", err);
    res.status(200).send("Handled safely");

  }
});

/* ===================================================== */
/* ================= DODO WEBHOOK ====================== */
/* ===================================================== */

app.post("/dodo-webhook", async (req, res) => {
  try {
    const payload = req.body;

    console.log("====== DODO WEBHOOK RECEIVED ======");
    console.log("TYPE:", payload.type);

    const firebaseUid = payload.data?.metadata?.firebaseUid;
    const productId = payload.data?.metadata?.productId;

    const subscriptionId =
      payload.data?.subscription_id ||
      payload.data?.subscription?.id ||
      payload.data?.id ||
      null;

    if (!firebaseUid) {
      console.log("No firebaseUid in metadata");
      return res.status(200).send("No UID");
    }

    const userRef = db.collection("users").doc(firebaseUid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      console.log("User not found in Firestore");
      return res.status(200).send("User not found");
    }

    const userData = userDoc.data();

    /* ===================================================== */
    /* ================= PAYMENT SUCCEEDED ================= */
    /* ===================================================== */

    if (payload.type === "payment.succeeded") {

      /* ================= CREDIT PACKS ================= */

      if (productId === process.env.DODO_STARTER_PACK_ID) {

        await userRef.update({
          purchasedCredits: admin.firestore.FieldValue.increment(5)
        });

        console.log("Starter Pack purchased (+5 credits)");
        return res.status(200).send("Credits added");
      }

      if (productId === process.env.DODO_POWER_PACK_ID) {

        await userRef.update({
          purchasedCredits: admin.firestore.FieldValue.increment(50)
        });

        console.log("Power Pack purchased (+50 credits)");
        return res.status(200).send("Credits added");
      }

      /* ================= SUBSCRIPTIONS ================= */

      let tier = "free";
      let credits = 5;

      if (
        productId === process.env.DODO_LITE_PRODUCT_ID ||
        productId === process.env.DODO_LITE_YEARLY_ID
      ) {
        tier = "lite";
        credits = 15;
      }

      if (
        productId === process.env.DODO_PRO_PRODUCT_ID ||
        productId === process.env.DODO_PRO_YEARLY_ID
      ) {
        tier = "pro";
        credits = 50;
      }

      // Save previous subscription
      const oldProvider = userData.subscriptionProvider;
      const oldSubscriptionId = userData.subscriptionId;

      /* ================= ACTIVATE SUB ================= */

      await userRef.update({
        subscriptionTier: tier,
        subscriptionCredits: credits,
        subscriptionUsed: 0,
        subscriptionStartDate: new Date().toISOString(),
        subscriptionProvider: "dodo",
        subscriptionId: subscriptionId,
        subscriptionStatus: "active",
      });

      console.log("Dodo subscription activated:", tier);

      /* ================= CANCEL OLD SUB ================= */

      if (
        oldSubscriptionId &&
        oldProvider &&
        oldSubscriptionId !== subscriptionId
      ) {
        console.log("Cancelling previous subscription after activation");

        if (oldProvider === "paypal") {
          await cancelPayPalSubscription(oldSubscriptionId);
        }

        if (oldProvider === "dodo") {
          await cancelDodoSubscription(oldSubscriptionId);
        }
      }
    }

    /* ===================================================== */
    /* ================= SUB CANCELLED ===================== */
    /* ===================================================== */

    if (payload.type === "subscription.canceled") {

      if (userData.subscriptionId === subscriptionId) {

        await userRef.update({
          subscriptionTier: "free",
          subscriptionCredits: 5,
          subscriptionUsed: 0,
          subscriptionProvider: null,
          subscriptionId: null,
          subscriptionStatus: "cancelled",
        });

        console.log("Dodo subscription cancelled (active)");

      } else {

        console.log("Ignored old cancellation");

      }
    }

    res.status(200).send("OK");

  } catch (err) {
    console.error("Dodo webhook error:", err);
    res.status(200).send("Handled safely");
  }
});
/* ================= START SERVER ================= */

const PORT = process.env.PORT || 10000;
app.get("/", (req, res) => {
  res.send("GeoPixel Backend Running");
});
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});