require("dotenv").config();

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const DodoPayments = require("dodopayments");
const crypto = require("crypto");

/* =====================================================
   CONFIGURATION
   ===================================================== */

const app = express();
const PORT = process.env.PORT || 10000;
const PAYPAL_API_BASE = "https://api-m.paypal.com";
const GEO_PIXEL_RETURN_URL = "https://geopixel.app/payment-success";
const GEO_PIXEL_PRICING_URL = "https://geopixel.app/pricing";

const requiredEnv = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
  "DODO_PAYMENTS_API_KEY",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_SECRET",
];

const missingEnv = requiredEnv.filter((name) => !process.env[name]);
if (missingEnv.length) {
  console.error("Missing required environment variables:", missingEnv.join(", "));
  process.exit(1);
}

if (!process.env.PAYPAL_WEBHOOK_ID) {
  console.warn("WARNING: PAYPAL_WEBHOOK_ID is missing; PayPal webhook signature verification will fail.");
}
if (!process.env.DODO_PAYMENTS_WEBHOOK_KEY) {
  console.warn("WARNING: DODO_PAYMENTS_WEBHOOK_KEY is missing; verified Dodo webhook processing will fail.");
}
for (const name of [
  "DODO_PRODUCT_10_CREDITS",
  "DODO_PRODUCT_25_CREDITS",
  "DODO_PRODUCT_50_CREDITS",
]) {
  if (!process.env[name]) {
    console.warn(`WARNING: ${name} is missing; that Dodo credit pack will not be recognized.`);
  }
}

/* =====================================================
   FIREBASE
   ===================================================== */

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

/* =====================================================
   DODO CLIENT
   ===================================================== */

const dodo = new DodoPayments({
  bearerToken: process.env.DODO_PAYMENTS_API_KEY,
  webhookKey: process.env.DODO_PAYMENTS_WEBHOOK_KEY,
  environment: "live_mode",
});

/* =====================================================
   MIDDLEWARE AND HEALTH CHECK

   Dodo's webhook route is registered with express.raw BEFORE
   express.json so signature verification uses the exact body bytes.
   ===================================================== */

app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"] }));

app.get("/", (_req, res) => {
  res.status(200).send("GeoPixel Backend Running");
});

app.post("/dodo-webhook", express.raw({ type: "application/json" }), handleDodoWebhook);

app.use(express.json({ limit: "1mb" }));

/* =====================================================
   COMMON HELPERS
   ===================================================== */

function safeDocId(value) {
  return Buffer.from(String(value)).toString("base64url");
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function getPayPalPlanDefinitions() {
  const definitions = [
    { id: process.env.PAYPAL_LITE_MONTHLY_PLAN, tier: "lite", credits: 30, interval: "monthly" },
    { id: process.env.PAYPAL_LITE_YEARLY_PLAN, tier: "lite", credits: 30, interval: "yearly" },
    { id: process.env.PAYPAL_PRO_MONTHLY_PLAN, tier: "pro", credits: 100, interval: "monthly" },
    { id: process.env.PAYPAL_PRO_YEARLY_PLAN, tier: "pro", credits: 100, interval: "yearly" },
  ].filter((item) => Boolean(item.id));

  // This is the Lite monthly plan ID confirmed in the supplied PayPal subscription details.
  const knownLiteMonthlyId = "P-5J253134VT1166157NG46YKQ";
  if (!definitions.some((item) => item.id === knownLiteMonthlyId)) {
    definitions.push({ id: knownLiteMonthlyId, tier: "lite", credits: 30, interval: "monthly" });
  }

  return definitions;
}

function getPayPalPlanDefinition(planId) {
  return getPayPalPlanDefinitions().find((item) => item.id === planId) || null;
}

function getDodoPlanDefinition(productId) {
  if (
    productId &&
    (productId === process.env.DODO_LITE_PRODUCT_ID ||
      productId === process.env.DODO_LITE_YEARLY_ID)
  ) {
    return { tier: "lite", credits: 30 };
  }
  if (
    productId &&
    (productId === process.env.DODO_PRO_PRODUCT_ID ||
      productId === process.env.DODO_PRO_YEARLY_ID)
  ) {
    return { tier: "pro", credits: 100 };
  }
  return null;
}

// Dodo one-time credit packs. Configure the matching product IDs in Render.
// The legacy variables remain supported so existing Dodo pack purchases keep working.
function getDodoCreditPackDefinition(productId) {
  if (!productId) return null;

  const definitions = [
    {
      id: process.env.DODO_PRODUCT_10_CREDITS,
      pack: "10 Credits",
      credits: 10,
    },
    {
      id: process.env.DODO_PRODUCT_25_CREDITS,
      pack: "25 Credits",
      credits: 25,
    },
    {
      id: process.env.DODO_PRODUCT_50_CREDITS,
      pack: "50 Credits",
      credits: 50,
    },
    {
      id: process.env.DODO_STARTER_PACK_ID,
      pack: "Legacy Starter Pack",
      credits: 5,
    },
    {
      id: process.env.DODO_POWER_PACK_ID,
      pack: "Legacy Power Pack",
      credits: 50,
    },
  ].filter((item) => Boolean(item.id));

  return definitions.find((item) => item.id === productId) || null;
}


function findApprovalLink(links) {
  return (links || []).find((link) => link.rel === "approve" || link.rel === "payer-action") || null;
}

function getCreditPack(pack) {
  if (pack === "starter") {
    return { pack: "starter", description: "starter_pack", amount: "3.00", credits: 5 };
  }
  if (pack === "power") {
    return { pack: "power", description: "power_pack", amount: "15.00", credits: 50 };
  }
  return null;
}

function inferCreditPackFromDescription(description) {
  if (description === "starter_pack") return getCreditPack("starter");
  if (description === "power_pack") return getCreditPack("power");
  return null;
}

/* =====================================================
   PAYPAL API HELPERS
   ===================================================== */

let cachedPayPalToken = null;
let cachedPayPalTokenExpiresAt = 0;

async function getPayPalAccessToken() {
  if (cachedPayPalToken && Date.now() < cachedPayPalTokenExpiresAt - 60_000) {
    return cachedPayPalToken;
  }

  const auth = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`
  ).toString("base64");

  const response = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const data = await readJsonResponse(response);
  if (!response.ok || !data?.access_token) {
    console.error("PayPal authentication failed:", response.status, data?.error || data?.message || "Unknown error");
    throw new Error("PayPal authentication failed");
  }

  cachedPayPalToken = data.access_token;
  cachedPayPalTokenExpiresAt = Date.now() + Number(data.expires_in || 300) * 1000;
  return cachedPayPalToken;
}

async function paypalApi(path, options = {}) {
  const token = await getPayPalAccessToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  if (options.requestId) headers["PayPal-Request-Id"] = options.requestId;

  const response = await fetch(`${PAYPAL_API_BASE}${path}`, {
    method: options.method || "GET",
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

  const data = await readJsonResponse(response);
  if (!response.ok) {
    const message = data?.message || data?.name || data?.details?.[0]?.description || "PayPal API request failed";
    const error = new Error(`${message} (HTTP ${response.status})`);
    error.status = response.status;
    error.details = data;
    throw error;
  }

  return { data, status: response.status };
}

async function cancelPayPalSubscription(subscriptionId) {
  if (!subscriptionId) return;
  await paypalApi(`/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
    method: "POST",
    body: { reason: "GeoPixel subscription replaced or cancelled" },
    requestId: `gp-cancel-${safeDocId(subscriptionId).slice(0, 24)}`,
  });
  console.log("PayPal subscription cancellation requested:", subscriptionId);
}

async function cancelDodoSubscription(subscriptionId) {
  if (!subscriptionId) return;
  try {
    await dodo.subscriptions.update(subscriptionId, { status: "cancelled" });
    console.log("Dodo subscription cancelled:", subscriptionId);
  } catch (error) {
    console.error("Dodo cancellation failed:", error.message);
    throw error;
  }
}

async function cancelOldSubscription(provider, subscriptionId) {
  if (!provider || !subscriptionId) return;
  try {
    if (provider === "paypal") await cancelPayPalSubscription(subscriptionId);
    else if (provider === "dodo") await cancelDodoSubscription(subscriptionId);
  } catch (error) {
    // Keep the newly activated subscription working, but expose failed cleanup in logs.
    console.error("Could not cancel previous subscription:", provider, subscriptionId, error.message);
  }
}

/* =====================================================
   PAYPAL WEBHOOK SIGNATURE VERIFICATION
   ===================================================== */

async function verifyPayPalWebhook(req) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) throw new Error("PAYPAL_WEBHOOK_ID is not configured");

  const transmissionId = req.headers["paypal-transmission-id"];
  const transmissionTime = req.headers["paypal-transmission-time"];
  const certUrl = req.headers["paypal-cert-url"];
  const authAlgo = req.headers["paypal-auth-algo"];
  const transmissionSig = req.headers["paypal-transmission-sig"];

  if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig) {
    return false;
  }

  const { data } = await paypalApi("/v1/notifications/verify-webhook-signature", {
    method: "POST",
    body: {
      transmission_id: transmissionId,
      transmission_time: transmissionTime,
      cert_url: certUrl,
      auth_algo: authAlgo,
      transmission_sig: transmissionSig,
      webhook_id: webhookId,
      webhook_event: req.body,
    },
  });

  return data?.verification_status === "SUCCESS";
}

/* =====================================================
   FIRESTORE LOOKUPS / IDEMPOTENCY
   ===================================================== */

async function findUserRefForSubscription(subscriptionId, firebaseUid = null) {
  if (firebaseUid) {
    const ref = db.collection("users").doc(firebaseUid);
    const snap = await ref.get();
    if (snap.exists) return ref;
  }

  if (!subscriptionId) return null;

  let snap = await db.collection("users").where("subscriptionId", "==", subscriptionId).limit(1).get();
  if (!snap.empty) return snap.docs[0].ref;

  snap = await db.collection("users").where("pendingPayPalSubscriptionId", "==", subscriptionId).limit(1).get();
  if (!snap.empty) return snap.docs[0].ref;

  return null;
}

async function grantCreditsOnce({ provider, paymentKey, firebaseUid, credits, orderId = null }) {
  if (!provider || !paymentKey || !firebaseUid || !Number.isInteger(credits) || credits <= 0) {
    throw new Error("Invalid credit fulfillment details");
  }

  const ledgerRef = db.collection("processedPayments").doc(`${provider}_${safeDocId(paymentKey)}`);
  const userRef = db.collection("users").doc(firebaseUid);
  const orderRef = orderId ? db.collection("paypalOrders").doc(orderId) : null;

  return db.runTransaction(async (transaction) => {
    const reads = [transaction.get(ledgerRef), transaction.get(userRef)];
    if (orderRef) reads.push(transaction.get(orderRef));
    const snapshots = await Promise.all(reads);
    const ledgerSnap = snapshots[0];
    const userSnap = snapshots[1];
    const orderSnap = orderRef ? snapshots[2] : null;

    if (ledgerSnap.exists) {
      return { granted: false, duplicate: true };
    }
    if (!userSnap.exists) {
      throw new Error(`User not found for ${provider} payment fulfillment`);
    }
    if (orderSnap?.exists && orderSnap.data().firebaseUid !== firebaseUid) {
      throw new Error("PayPal order owner does not match the checkout record");
    }

    transaction.update(userRef, {
      purchasedCredits: FieldValue.increment(credits),
    });
    transaction.create(ledgerRef, {
      provider,
      paymentKey: String(paymentKey),
      firebaseUid,
      credits,
      orderId: orderId || null,
      processedAt: FieldValue.serverTimestamp(),
    });
    if (orderRef) {
      transaction.set(orderRef, {
        status: "COMPLETED",
        captureId: String(paymentKey),
        completedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    return { granted: true, duplicate: false };
  });
}

function getCompletedCaptures(orderData) {
  const captures = [];
  for (const purchaseUnit of orderData?.purchase_units || []) {
    for (const capture of purchaseUnit?.payments?.captures || []) {
      if (capture?.status === "COMPLETED" && capture?.id) captures.push(capture);
    }
  }
  return captures;
}

async function getValidatedPackContext(orderId, orderData) {
  const purchaseUnit = orderData?.purchase_units?.[0];
  if (!purchaseUnit) throw new Error(`PayPal order ${orderId} has no purchase unit`);

  const orderRef = db.collection("paypalOrders").doc(orderId);
  const storedOrderSnap = await orderRef.get();
  const storedOrder = storedOrderSnap.exists ? storedOrderSnap.data() : null;

  const description = purchaseUnit.description;
  const inferredPack = inferCreditPackFromDescription(description);
  const pack = storedOrder?.pack ? getCreditPack(storedOrder.pack) : inferredPack;
  const firebaseUid = storedOrder?.firebaseUid || purchaseUnit.custom_id;

  if (!pack || !firebaseUid) {
    throw new Error(`PayPal order ${orderId} is not a recognized GeoPixel credit pack`);
  }
  if (storedOrder && (storedOrder.description !== pack.description || storedOrder.amount !== pack.amount)) {
    throw new Error(`Stored GeoPixel pack details do not match PayPal order ${orderId}`);
  }
  if (description !== pack.description || purchaseUnit.custom_id !== firebaseUid) {
    throw new Error(`PayPal order ${orderId} details do not match the expected pack`);
  }

  const amount = purchaseUnit.amount;
  if (amount?.currency_code !== "USD" || amount?.value !== pack.amount) {
    throw new Error(`PayPal order ${orderId} has an unexpected amount or currency`);
  }

  const userSnap = await db.collection("users").doc(firebaseUid).get();
  if (!userSnap.exists) throw new Error(`GeoPixel user for PayPal order ${orderId} was not found`);

  if (!storedOrder) {
    // Compatibility for an older order created before this local order ledger existed.
    await orderRef.set({
      firebaseUid,
      pack: pack.pack,
      description: pack.description,
      amount: pack.amount,
      currency: "USD",
      paypalOrderId: orderId,
      status: orderData.status || "UNKNOWN",
      createdAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  return { firebaseUid, pack, orderRef };
}

async function fulfillCompletedPayPalOrder(orderId, orderData, capture) {
  if (!capture?.id || capture.status !== "COMPLETED") {
    throw new Error("PayPal capture is not completed");
  }

  const context = await getValidatedPackContext(orderId, orderData);
  const result = await grantCreditsOnce({
    provider: "paypal",
    paymentKey: capture.id,
    firebaseUid: context.firebaseUid,
    credits: context.pack.credits,
    orderId,
  });

  console.log(
    result.duplicate ? "PayPal credit pack already fulfilled (duplicate ignored):" : "PayPal credit pack fulfilled:",
    context.pack.pack,
    result.duplicate ? "" : `(+${context.pack.credits} credits)`,
    "order:", orderId
  );
  return result;
}

async function handlePayPalOrderApproved(event) {
  const orderId = event.resource?.id;
  if (!orderId) throw new Error("CHECKOUT.ORDER.APPROVED event has no order ID");

  const { data: orderData } = await paypalApi(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  await getValidatedPackContext(orderId, orderData);

  if (orderData.status === "COMPLETED") {
    const captures = getCompletedCaptures(orderData);
    if (!captures.length) throw new Error(`Completed PayPal order ${orderId} has no completed capture`);
    for (const capture of captures) await fulfillCompletedPayPalOrder(orderId, orderData, capture);
    return;
  }

  if (orderData.status !== "APPROVED") {
    console.log("Ignoring PayPal order that is not approved:", orderId, orderData.status);
    return;
  }

  let captureData;
  try {
    const result = await paypalApi(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      method: "POST",
      body: {},
      requestId: `gp-cap-${safeDocId(orderId).slice(0, 24)}`,
    });
    captureData = result.data;
  } catch (error) {
    // A simultaneous capture/webhook retry may mean another request just completed it.
    const { data: latestOrder } = await paypalApi(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
    if (latestOrder.status !== "COMPLETED") throw error;
    captureData = latestOrder;
  }

  const captures = getCompletedCaptures(captureData);
  if (!captures.length) {
    // Capture response can be incomplete; fetch the authoritative order state before retrying.
    const { data: latestOrder } = await paypalApi(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
    const latestCaptures = getCompletedCaptures(latestOrder);
    if (!latestCaptures.length) throw new Error(`PayPal order ${orderId} was not captured successfully`);
    for (const capture of latestCaptures) await fulfillCompletedPayPalOrder(orderId, latestOrder, capture);
    return;
  }

  const authoritativeOrder = captureData.status === "COMPLETED"
    ? captureData
    : (await paypalApi(`/v2/checkout/orders/${encodeURIComponent(orderId)}`)).data;

  for (const capture of captures) {
    await fulfillCompletedPayPalOrder(orderId, authoritativeOrder, capture);
  }
}

/* =====================================================
   SUBSCRIPTION STATE HELPERS
   ===================================================== */

async function activatePayPalSubscription({ eventId, firebaseUid, subscriptionId, planId, startTime }) {
  const plan = getPayPalPlanDefinition(planId);
  if (!plan) {
    throw new Error(`PayPal plan ID is not mapped to a GeoPixel tier: ${planId || "missing"}`);
  }
  if (!firebaseUid) throw new Error(`No Firebase UID for PayPal subscription ${subscriptionId}`);
  if (!subscriptionId) throw new Error("PayPal activation has no subscription ID");

  const userRef = db.collection("users").doc(firebaseUid);
  const eventRef = db.collection("processedPayPalEvents").doc(safeDocId(eventId));

  const result = await db.runTransaction(async (transaction) => {
    const [eventSnap, userSnap] = await Promise.all([
      transaction.get(eventRef),
      transaction.get(userRef),
    ]);

    if (eventSnap.exists) return { duplicateEvent: true, oldProvider: null, oldSubscriptionId: null };
    if (!userSnap.exists) throw new Error(`Firestore user ${firebaseUid} not found for PayPal activation`);

    const userData = userSnap.data();
    const alreadyActive =
      userData.subscriptionProvider === "paypal" &&
      userData.subscriptionId === subscriptionId &&
      userData.subscriptionStatus === "active" &&
      userData.subscriptionTier === plan.tier &&
      userData.subscriptionCredits === plan.credits;

    let oldProvider = null;
    let oldSubscriptionId = null;

    if (!alreadyActive) {
      oldProvider = userData.subscriptionProvider || null;
      oldSubscriptionId = userData.subscriptionId || null;
      transaction.update(userRef, {
        subscriptionTier: plan.tier,
        subscriptionCredits: plan.credits,
        subscriptionUsed: 0,
        subscriptionStartDate: startTime || new Date().toISOString(),
        subscriptionProvider: "paypal",
        subscriptionId,
        subscriptionStatus: "active",
        pendingPayPalSubscriptionId: FieldValue.delete(),
        pendingPayPalPlanId: FieldValue.delete(),
        lastPaymentFailureAt: FieldValue.delete(),
      });
    }

    transaction.create(eventRef, {
      eventType: "BILLING.SUBSCRIPTION.ACTIVATED",
      subscriptionId,
      firebaseUid,
      processedAt: FieldValue.serverTimestamp(),
    });

    return { duplicateEvent: false, oldProvider, oldSubscriptionId };
  });

  if (!result.duplicateEvent && result.oldSubscriptionId && result.oldSubscriptionId !== subscriptionId) {
    await cancelOldSubscription(result.oldProvider, result.oldSubscriptionId);
  }

  console.log(result.duplicateEvent ? "Duplicate PayPal activation ignored:" : "PayPal subscription activated:", plan.tier, subscriptionId);
  return result;
}

async function deactivatePayPalSubscription({ eventId, eventType, firebaseUid, subscriptionId }) {
  if (!subscriptionId) throw new Error(`PayPal ${eventType} event has no subscription ID`);
  const userRef = await findUserRefForSubscription(subscriptionId, firebaseUid);
  if (!userRef) throw new Error(`No GeoPixel user found for PayPal subscription ${subscriptionId}`);
  const eventRef = db.collection("processedPayPalEvents").doc(safeDocId(eventId));

  return db.runTransaction(async (transaction) => {
    const [eventSnap, userSnap] = await Promise.all([
      transaction.get(eventRef),
      transaction.get(userRef),
    ]);

    if (eventSnap.exists) return { duplicateEvent: true, changed: false };
    if (!userSnap.exists) throw new Error("GeoPixel user disappeared during PayPal cancellation handling");

    const userData = userSnap.data();
    let changed = false;

    if (userData.subscriptionId === subscriptionId && userData.subscriptionProvider === "paypal") {
      transaction.update(userRef, {
        subscriptionTier: "free",
        subscriptionCredits: 5,
        subscriptionUsed: 0,
        subscriptionProvider: null,
        subscriptionId: null,
        subscriptionStatus: eventType === "BILLING.SUBSCRIPTION.SUSPENDED" ? "suspended" : "cancelled",
      });
      changed = true;
    } else if (userData.pendingPayPalSubscriptionId === subscriptionId) {
      transaction.update(userRef, {
        pendingPayPalSubscriptionId: FieldValue.delete(),
        pendingPayPalPlanId: FieldValue.delete(),
      });
      changed = true;
    }

    transaction.create(eventRef, {
      eventType,
      subscriptionId,
      firebaseUid: userRef.id,
      changed,
      processedAt: FieldValue.serverTimestamp(),
    });

    return { duplicateEvent: false, changed };
  });
}

async function handlePayPalSaleCompleted(event) {
  const resource = event.resource || {};
  const subscriptionId = resource.billing_agreement_id;
  if (!subscriptionId) {
    console.log("PAYMENT.SALE.COMPLETED without billing_agreement_id; ignoring for subscription credits");
    return;
  }

  const userRef = await findUserRefForSubscription(subscriptionId);
  if (!userRef) throw new Error(`No GeoPixel user found for PayPal recurring payment ${subscriptionId}`);
  const eventId = event.id || `${event.event_type}-${resource.id}-${event.create_time}`;
  const eventRef = db.collection("processedPayPalEvents").doc(safeDocId(eventId));

  const result = await db.runTransaction(async (transaction) => {
    const [eventSnap, userSnap] = await Promise.all([
      transaction.get(eventRef),
      transaction.get(userRef),
    ]);
    if (eventSnap.exists) return { duplicateEvent: true, reset: false };
    if (!userSnap.exists) throw new Error("GeoPixel user not found for recurring PayPal payment");

    const userData = userSnap.data();
    let reset = false;
    if (userData.subscriptionId === subscriptionId && userData.subscriptionProvider === "paypal" && userData.subscriptionStatus === "active") {
      const credits = userData.subscriptionTier === "pro" ? 100 : userData.subscriptionTier === "lite" ? 30 : null;
      if (credits !== null) {
        transaction.update(userRef, {
          subscriptionCredits: credits,
          subscriptionUsed: 0,
          lastSubscriptionPaymentAt: new Date().toISOString(),
          lastPaymentFailureAt: FieldValue.delete(),
        });
        reset = true;
      }
    }

    transaction.create(eventRef, {
      eventType: event.event_type,
      subscriptionId,
      firebaseUid: userRef.id,
      processedAt: FieldValue.serverTimestamp(),
    });
    return { duplicateEvent: false, reset };
  });

  console.log("PayPal recurring payment handled:", subscriptionId, result.duplicateEvent ? "duplicate ignored" : (result.reset ? "subscription credits reset" : "subscription not current/active; no entitlement change"));
}

async function handlePayPalSaleFailed(event) {
  const resource = event.resource || {};
  const subscriptionId = event.event_type === "BILLING.SUBSCRIPTION.PAYMENT.FAILED"
    ? (resource.subscription_id || resource.id || resource.billing_agreement_id)
    : resource.billing_agreement_id;
  if (!subscriptionId) {
    console.log(`${event.event_type} without a subscription reference; no user update possible`);
    return;
  }

  const userRef = await findUserRefForSubscription(subscriptionId);
  if (!userRef) throw new Error(`No GeoPixel user found for failed PayPal payment ${subscriptionId}`);
  const eventId = event.id || `${event.event_type}-${resource.id}-${event.create_time}`;
  const eventRef = db.collection("processedPayPalEvents").doc(safeDocId(eventId));

  await db.runTransaction(async (transaction) => {
    const [eventSnap, userSnap] = await Promise.all([
      transaction.get(eventRef),
      transaction.get(userRef),
    ]);
    if (eventSnap.exists) return;
    if (!userSnap.exists) throw new Error("GeoPixel user not found while recording failed payment");

    const userData = userSnap.data();
    if (userData.subscriptionId === subscriptionId && userData.subscriptionProvider === "paypal") {
      transaction.update(userRef, { lastPaymentFailureAt: new Date().toISOString() });
    }
    transaction.create(eventRef, {
      eventType: event.event_type,
      subscriptionId,
      firebaseUid: userRef.id,
      processedAt: FieldValue.serverTimestamp(),
    });
  });

  console.log("PayPal subscription payment failure recorded:", subscriptionId);
}

/* =====================================================
   DODO WEBHOOK HANDLER
   ===================================================== */

async function handleDodoWebhook(req, res) {
  try {
    if (!Buffer.isBuffer(req.body)) {
      return res.status(400).send("Expected raw Dodo webhook body");
    }

    const event = dodo.webhooks.unwrap(req.body.toString("utf8"), {
      headers: {
        "webhook-id": req.headers["webhook-id"],
        "webhook-signature": req.headers["webhook-signature"],
        "webhook-timestamp": req.headers["webhook-timestamp"],
      },
    });

    const payload = typeof event === "string" ? JSON.parse(event) : event;
    if (!payload || !payload.type) return res.status(400).send("Invalid Dodo webhook");

    console.log("====== VERIFIED DODO WEBHOOK ======");
    console.log("TYPE:", payload.type);

    const data = payload.data || {};
    const metadata = data.metadata || {};
    const firebaseUid = metadata.firebaseUid;
    const productId = metadata.productId || data.product_id || data.product?.id;
    const paymentId = data.payment_id || data.payment?.id || data.id || req.headers["webhook-id"];
    const subscriptionId = data.subscription_id || data.subscription?.id || null;

    if (payload.type === "payment.succeeded") {
      if (!firebaseUid) throw new Error("Dodo payment event is missing metadata.firebaseUid");
      if (!paymentId) throw new Error("Dodo payment event is missing a payment identifier");

      const creditPack = getDodoCreditPackDefinition(productId);
      if (creditPack) {
        const result = await grantCreditsOnce({
          provider: "dodo",
          paymentKey: paymentId,
          firebaseUid,
          credits: creditPack.credits,
        });

        console.log(
          result.duplicate
            ? `Duplicate Dodo ${creditPack.pack} ignored`
            : `Dodo ${creditPack.pack} fulfilled (+${creditPack.credits} credits)`
        );
        return res.status(200).send("OK");
      }

      const plan = getDodoPlanDefinition(productId);
      if (!plan) {
        console.warn("Verified Dodo payment has an unrecognized product ID; no credits or subscription granted:", productId || "missing");
        return res.status(200).send("Unrecognized product; ignored");
      }

      if (!subscriptionId) {
        throw new Error(`Dodo subscription product payment is missing a subscription ID: ${productId}`);
      }

      const userRef = db.collection("users").doc(firebaseUid);
      const paymentRef = db.collection("processedPayments").doc(`dodo_${safeDocId(paymentId)}`);
      const result = await db.runTransaction(async (transaction) => {
        const [paymentSnap, userSnap] = await Promise.all([
          transaction.get(paymentRef),
          transaction.get(userRef),
        ]);
        if (paymentSnap.exists) return { duplicate: true, oldProvider: null, oldSubscriptionId: null };
        if (!userSnap.exists) throw new Error(`Firestore user ${firebaseUid} not found for Dodo subscription`);

        const userData = userSnap.data();
        const oldProvider = userData.subscriptionProvider || null;
        const oldSubscriptionId = userData.subscriptionId || null;
        transaction.update(userRef, {
          subscriptionTier: plan.tier,
          subscriptionCredits: plan.credits,
          subscriptionUsed: 0,
          subscriptionStartDate: new Date().toISOString(),
          subscriptionProvider: "dodo",
          subscriptionId: subscriptionId,
          subscriptionStatus: "active",
          lastPaymentFailureAt: FieldValue.delete(),
        });
        transaction.create(paymentRef, {
          provider: "dodo",
          paymentKey: String(paymentId),
          firebaseUid,
          productId,
          subscriptionId,
          processedAt: FieldValue.serverTimestamp(),
        });
        return { duplicate: false, oldProvider, oldSubscriptionId };
      });

      if (!result.duplicate && result.oldSubscriptionId && result.oldSubscriptionId !== subscriptionId) {
        await cancelOldSubscription(result.oldProvider, result.oldSubscriptionId);
      }
      console.log(result.duplicate ? "Duplicate Dodo subscription payment ignored" : "Dodo subscription activated/renewed:", plan.tier);
      return res.status(200).send("OK");
    }

    if (["subscription.canceled", "subscription.cancelled", "subscription.expired"].includes(payload.type)) {
      if (!subscriptionId) {
        console.warn("Dodo cancellation event missing subscription ID");
        return res.status(200).send("No subscription ID");
      }
      const userRef = await findUserRefForSubscription(subscriptionId, firebaseUid || null);
      if (!userRef) {
        console.warn("No GeoPixel user found for Dodo cancellation:", subscriptionId);
        return res.status(200).send("User not found");
      }

      await db.runTransaction(async (transaction) => {
        const userSnap = await transaction.get(userRef);
        if (!userSnap.exists) throw new Error("GeoPixel user not found while handling Dodo cancellation");
        const userData = userSnap.data();
        if (userData.subscriptionId === subscriptionId && userData.subscriptionProvider === "dodo") {
          transaction.update(userRef, {
            subscriptionTier: "free",
            subscriptionCredits: 5,
            subscriptionUsed: 0,
            subscriptionProvider: null,
            subscriptionId: null,
            subscriptionStatus: "cancelled",
          });
          console.log("Dodo subscription ended; GeoPixel user downgraded:", subscriptionId);
        } else {
          console.log("Ignored cancellation for an old Dodo subscription:", subscriptionId);
        }
      });
      return res.status(200).send("OK");
    }

    // Acknowledge verified event types this application does not need to process.
    console.log("Verified Dodo event acknowledged without entitlement changes:", payload.type);
    return res.status(200).send("OK");
  } catch (error) {
    console.error("Dodo webhook verification/processing failed:", error.message);
    // Non-2xx tells Dodo delivery failed so it can retry.
    return res.status(500).send("Dodo webhook processing failed");
  }
}

/* =====================================================
   DODO CHECKOUT
   ===================================================== */

app.post("/create-checkout-session", async (req, res) => {
  try {
    const { firebaseUid, productId } = req.body || {};
    if (!firebaseUid || !productId) {
      return res.status(400).json({ error: "Missing firebaseUid or productId" });
    }

    const userRef = db.collection("users").doc(firebaseUid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ error: "User not found" });

    const userData = userDoc.data();
    const session = await dodo.checkoutSessions.create({
      product_cart: [{ product_id: productId, quantity: 1 }],
      ...(userData.email ? { customer: { email: userData.email } } : {}),
      metadata: { firebaseUid, productId },
      return_url: GEO_PIXEL_RETURN_URL,
    });

    if (!session?.checkout_url) throw new Error("Dodo did not return a checkout URL");
    return res.json({ checkoutUrl: session.checkout_url });
  } catch (error) {
    console.error("Dodo checkout creation failed:", error.message);
    return res.status(500).json({ error: "Dodo checkout failed" });
  }
});

/* =====================================================
   PAYPAL SUBSCRIPTION CREATION
   ===================================================== */

app.post("/create-paypal-subscription", async (req, res) => {
  try {
    const { firebaseUid, planId } = req.body || {};
    if (!firebaseUid || !planId) {
      return res.status(400).json({ error: "Missing firebaseUid or planId" });
    }

    const plan = getPayPalPlanDefinition(planId);
    if (!plan) {
      return res.status(400).json({ error: "Unrecognized PayPal plan ID. Check the plan ID and Render environment variables." });
    }

    const userRef = db.collection("users").doc(firebaseUid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ error: "User not found" });
    const userData = userDoc.data();

    console.log("Creating PayPal subscription for GeoPixel tier:", plan.tier, "plan:", planId);
    const { data: subData } = await paypalApi("/v1/billing/subscriptions", {
      method: "POST",
      body: {
        plan_id: planId,
        custom_id: firebaseUid,
        ...(userData.email ? { subscriber: { email_address: userData.email } } : {}),
        application_context: {
          brand_name: "GeoPixel",
          user_action: "SUBSCRIBE_NOW",
          return_url: GEO_PIXEL_RETURN_URL,
          cancel_url: GEO_PIXEL_PRICING_URL,
        },
      },
      requestId: `gpsub-${crypto.randomUUID().replace(/-/g, "")}`,
    });

    const approveLink = findApprovalLink(subData?.links);
    if (!subData?.id || !approveLink?.href) {
      console.error("PayPal response was missing subscription ID or approval URL");
      return res.status(502).json({ error: "PayPal did not return a valid approval URL" });
    }

    await userRef.set({
      pendingPayPalSubscriptionId: subData.id,
      pendingPayPalPlanId: planId,
    }, { merge: true });

    console.log("PayPal subscription created; customer approval is required:", subData.id, subData.status);
    return res.json({ approveUrl: approveLink.href });
  } catch (error) {
    console.error("PayPal subscription creation failed:", error.message);
    return res.status(500).json({ error: "PayPal subscription creation failed" });
  }
});

/* =====================================================
   PAYPAL ONE-TIME CREDIT PACK CREATION
   ===================================================== */

app.post("/create-paypal-pack", async (req, res) => {
  try {
    const { firebaseUid, pack: requestedPack } = req.body || {};
    const pack = getCreditPack(requestedPack);
    if (!firebaseUid || !pack) {
      return res.status(400).json({ error: "Missing or invalid firebaseUid/pack" });
    }

    const userRef = db.collection("users").doc(firebaseUid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ error: "User not found" });

    const { data: orderData } = await paypalApi("/v2/checkout/orders", {
      method: "POST",
      requestId: `gpord-${crypto.randomUUID().replace(/-/g, "")}`,
      body: {
        intent: "CAPTURE",
        purchase_units: [{
          custom_id: firebaseUid,
          description: pack.description,
          amount: { currency_code: "USD", value: pack.amount },
        }],
        application_context: {
          brand_name: "GeoPixel",
          user_action: "PAY_NOW",
          return_url: GEO_PIXEL_RETURN_URL,
          cancel_url: GEO_PIXEL_PRICING_URL,
        },
      },
    });

    const approveLink = findApprovalLink(orderData?.links);
    if (!orderData?.id || !approveLink?.href) {
      throw new Error("PayPal did not return an order ID or approval URL");
    }

    await db.collection("paypalOrders").doc(orderData.id).set({
      firebaseUid,
      pack: pack.pack,
      description: pack.description,
      amount: pack.amount,
      currency: "USD",
      paypalOrderId: orderData.id,
      status: orderData.status || "CREATED",
      createdAt: FieldValue.serverTimestamp(),
    });

    console.log("PayPal credit pack order created:", pack.pack, orderData.id);
    return res.json({ approveUrl: approveLink.href });
  } catch (error) {
    console.error("PayPal credit pack creation failed:", error.message);
    return res.status(500).json({ error: "PayPal credit pack checkout failed" });
  }
});

/* =====================================================
   OPTIONAL SERVER-SIDE CAPTURE ENDPOINT

   The webhook also captures APPROVED orders automatically, so this
   endpoint is optional for existing frontend code. It is available if
   the payment-success page is later updated to call it.
   ===================================================== */

app.post("/capture-paypal-pack", async (req, res) => {
  try {
    const { firebaseUid, orderId } = req.body || {};
    if (!firebaseUid || !orderId) {
      return res.status(400).json({ error: "Missing firebaseUid or orderId" });
    }

    const localOrderRef = db.collection("paypalOrders").doc(orderId);
    const localOrderSnap = await localOrderRef.get();
    if (!localOrderSnap.exists || localOrderSnap.data().firebaseUid !== firebaseUid) {
      return res.status(404).json({ error: "GeoPixel credit pack order not found for this user" });
    }

    const { data: orderData } = await paypalApi(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
    await getValidatedPackContext(orderId, orderData);

    let finalOrder = orderData;
    if (orderData.status === "APPROVED") {
      try {
        const result = await paypalApi(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
          method: "POST",
          body: {},
          requestId: `gp-cap-${safeDocId(orderId).slice(0, 24)}`,
        });
        finalOrder = result.data;
      } catch (error) {
        const latest = await paypalApi(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
        if (latest.data.status !== "COMPLETED") throw error;
        finalOrder = latest.data;
      }
    }

    const captures = getCompletedCaptures(finalOrder);
    if (!captures.length) {
      const latest = await paypalApi(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
      finalOrder = latest.data;
    }
    const completedCaptures = getCompletedCaptures(finalOrder);
    if (!completedCaptures.length) {
      return res.status(409).json({ error: "PayPal payment has not been captured yet" });
    }

    for (const capture of completedCaptures) {
      await fulfillCompletedPayPalOrder(orderId, finalOrder, capture);
    }
    return res.json({ success: true, status: "COMPLETED" });
  } catch (error) {
    console.error("PayPal credit pack capture failed:", error.message);
    return res.status(500).json({ error: "Could not capture PayPal credit pack" });
  }
});

/* =====================================================
   PAYPAL WEBHOOK HANDLER
   ===================================================== */

app.post("/paypal-webhook", async (req, res) => {
  let event;
  try {
    event = req.body;
    if (!event || !event.event_type || !event.resource) {
      return res.status(400).send("Invalid PayPal webhook payload");
    }

    const verified = await verifyPayPalWebhook(req);
    if (!verified) {
      console.warn("Rejected PayPal webhook: signature verification failed");
      return res.status(400).send("Invalid PayPal webhook signature");
    }

    const eventType = event.event_type;
    const resource = event.resource;
    const eventId = event.id || `${eventType}-${resource.id || "no-resource-id"}-${event.create_time || "no-time"}`;

    console.log("====== VERIFIED PAYPAL WEBHOOK ======");
    console.log("EVENT:", eventType, "ID:", eventId);

    if (eventType === "CHECKOUT.ORDER.APPROVED") {
      await handlePayPalOrderApproved(event);
      return res.status(200).send("OK");
    }

    if (eventType === "PAYMENT.CAPTURE.COMPLETED") {
      const captureId = resource.id;
      const orderId =
        resource.supplementary_data?.related_ids?.order_id ||
        resource.order_id;

      if (!captureId || !orderId) {
        console.warn("Completed PayPal capture did not include capture/order ID; no credits granted");
        return res.status(200).send("Capture missing order reference");
      }

      const { data: orderData } = await paypalApi(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
      const completedCapture = getCompletedCaptures(orderData).find((capture) => capture.id === captureId);
      if (!completedCapture) {
        throw new Error(`Capture ${captureId} was not found as COMPLETED on PayPal order ${orderId}`);
      }
      await fulfillCompletedPayPalOrder(orderId, orderData, completedCapture);
      return res.status(200).send("OK");
    }

    if (eventType === "BILLING.SUBSCRIPTION.ACTIVATED") {
      const subscriptionId = resource.id;
      let subscription = resource;
      if (!subscriptionId) throw new Error("PayPal activation event has no subscription ID");
      if (!subscription.custom_id || !subscription.plan_id) {
        const { data } = await paypalApi(`/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`);
        subscription = {
          ...data,
          ...subscription,
          custom_id: subscription.custom_id || data.custom_id,
          plan_id: subscription.plan_id || data.plan_id,
          start_time: subscription.start_time || data.start_time,
        };
      }

      const result = await activatePayPalSubscription({
        eventId,
        firebaseUid: subscription.custom_id,
        subscriptionId,
        planId: subscription.plan_id,
        startTime: subscription.start_time || event.create_time || new Date().toISOString(),
      });
      return res.status(200).send(result.duplicateEvent ? "Duplicate ignored" : "OK");
    }

    if ([
      "BILLING.SUBSCRIPTION.CANCELLED",
      "BILLING.SUBSCRIPTION.EXPIRED",
      "BILLING.SUBSCRIPTION.SUSPENDED",
    ].includes(eventType)) {
      const result = await deactivatePayPalSubscription({
        eventId,
        eventType,
        firebaseUid: resource.custom_id || null,
        subscriptionId: resource.id,
      });
      return res.status(200).send(result.duplicateEvent ? "Duplicate ignored" : "OK");
    }

    if (eventType === "PAYMENT.SALE.COMPLETED") {
      await handlePayPalSaleCompleted(event);
      return res.status(200).send("OK");
    }

    if (eventType === "BILLING.SUBSCRIPTION.PAYMENT.FAILED" || eventType === "PAYMENT.SALE.DENIED") {
      await handlePayPalSaleFailed(event);
      return res.status(200).send("OK");
    }

    console.log("Verified PayPal event acknowledged without entitlement changes:", eventType);
    return res.status(200).send("OK");
  } catch (error) {
    console.error("PayPal webhook processing failed:", error.message);
    // Return a non-2xx status for verified events that failed to process so PayPal can retry.
    return res.status(500).send("PayPal webhook processing failed");
  }
});

/* =====================================================
   START SERVER
   ===================================================== */

app.listen(PORT, () => {
  console.log("GeoPixel backend running on port", PORT);
  console.log("Dodo environment: live_mode");
  console.log("PayPal API environment: LIVE");
});
