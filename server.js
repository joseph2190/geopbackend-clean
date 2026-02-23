require("dotenv").config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();

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
   CREEM WEBHOOK (RAW BODY REQUIRED)
========================================= */
app.post("/creem-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const payload = JSON.parse(req.body.toString());

    console.log("====== CREEM WEBHOOK RECEIVED ======");
    console.log("Event Type:", payload.eventType);

    const eventType = payload.eventType;

    /* =========================================
       SUBSCRIPTION ACTIVATION / PAYMENT
    ========================================= */
    if (
      eventType === "subscription.active" ||
      eventType === "subscription.paid"
    ) {
      const customerEmail = payload.object?.customer?.email;
      const productId = payload.object?.product?.id;

      console.log("Customer email:", customerEmail);
      console.log("Product ID:", productId);

      if (!customerEmail || !productId) {
        return res.status(200).send("Missing subscription data");
      }

      let newTier = null;
      let newCredits = 0;

      if (productId === process.env.CREEM_LITE_PRODUCT_ID) {
        newTier = "lite";
        newCredits = 15;
      }

      if (productId === process.env.CREEM_PRO_PRODUCT_ID) {
        newTier = "pro";
        newCredits = 50;
      }

      if (!newTier) {
        console.log("Unknown subscription product");
        return res.status(200).send("Unknown subscription product");
      }

      const usersRef = db.collection("users");
      const snapshot = await usersRef.where("email", "==", customerEmail).get();

      if (snapshot.empty) {
        console.log("User not found");
        return res.status(200).send("User not found");
      }

      const userDoc = snapshot.docs[0];

      await userDoc.ref.update({
        subscriptionTier: newTier,
        totalCredits: newCredits,
        creditsUsed: 0,
        subscriptionStartDate: new Date().toISOString(),
        lastDailyReset: new Date().toISOString(),
      });

      console.log("User upgraded to:", newTier);
    }

    /* =========================================
       SUBSCRIPTION CANCEL / EXPIRE / UNPAID
    ========================================= */
    if (
      eventType === "subscription.canceled" ||
      eventType === "subscription.unpaid" ||
      eventType === "subscription.expired"
    ) {
      const customerEmail = payload.object?.customer?.email;

      if (!customerEmail) {
        return res.status(200).send("Missing email for downgrade");
      }

      const usersRef = db.collection("users");
      const snapshot = await usersRef.where("email", "==", customerEmail).get();

      if (!snapshot.empty) {
        const userDoc = snapshot.docs[0];

        await userDoc.ref.update({
          subscriptionTier: "free",
          totalCredits: 5,
          creditsUsed: 0,
        });

        console.log("User downgraded to free");
      }
    }

    /* =========================================
       ONE-TIME CREDIT PACKS
    ========================================= */
    if (eventType === "checkout.completed") {
      const customerEmail = payload.object?.customer?.email;
      const productId = payload.object?.product?.id;

      if (!customerEmail || !productId) {
        return res.status(200).send("Missing checkout data");
      }

      let creditsToAdd = 0;

      if (productId === process.env.CREEM_STARTER_PRODUCT_ID) {
        creditsToAdd = 5;
      }

      if (productId === process.env.CREEM_POWER_PRODUCT_ID) {
        creditsToAdd = 50;
      }

      if (!creditsToAdd) {
        return res.status(200).send("Not a credit product");
      }

      const usersRef = db.collection("users");
      const snapshot = await usersRef.where("email", "==", customerEmail).get();

      if (snapshot.empty) {
        console.log("User not found for credit pack");
        return res.status(200).send("User not found");
      }

      const userDoc = snapshot.docs[0];
      const currentData = userDoc.data();

      await userDoc.ref.update({
        totalCredits: (currentData.totalCredits || 0) + creditsToAdd,
      });

      console.log("Credits added:", creditsToAdd);
    }

    return res.status(200).send("Webhook processed");
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(200).send("Error handled safely");
  }
});

/* =========================================
   NORMAL EXPRESS MIDDLEWARE
========================================= */
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Backend running");
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});