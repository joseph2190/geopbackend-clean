require("dotenv").config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();

/* =========================================
   FIREBASE INIT
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
   DODO WEBHOOK
========================================= */
app.post("/dodo-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const payload = JSON.parse(req.body.toString());

    console.log("====== DODO WEBHOOK RECEIVED ======");
    console.log("Event Type:", payload.type);

    const eventType = payload.type;

    /* ============================
       PAYMENT SUCCESS
    ============================ */
    if (eventType === "payment.succeeded") {

      const productId = payload.data?.product_id;
      const customerEmail = payload.data?.customer?.email;

      console.log("Customer:", customerEmail);
      console.log("Product:", productId);

      if (!productId || !customerEmail) {
        return res.status(200).send("Missing data");
      }

      const usersRef = db.collection("users");
      const snapshot = await usersRef.where("email", "==", customerEmail).get();

      if (snapshot.empty) {
        console.log("User not found");
        return res.status(200).send("User not found");
      }

      const userDoc = snapshot.docs[0];
      const currentData = userDoc.data();

      /* ============================
         SUBSCRIPTIONS
      ============================ */
      if (productId === process.env.DODO_LITE_PRODUCT_ID) {
        await userDoc.ref.update({
          subscriptionTier: "lite",
          subscriptionCredits: 15,
          subscriptionUsed: 0,
          subscriptionStartDate: new Date().toISOString(),
        });
        console.log("Upgraded to Lite");
      }

      else if (productId === process.env.DODO_PRO_PRODUCT_ID) {
        await userDoc.ref.update({
          subscriptionTier: "pro",
          subscriptionCredits: 50,
          subscriptionUsed: 0,
          subscriptionStartDate: new Date().toISOString(),
        });
        console.log("Upgraded to Pro");
      }

      /* ============================
         ONE TIME CREDIT PACKS
      ============================ */
      else if (productId === process.env.DODO_STARTER_PRODUCT_ID) {
        await userDoc.ref.update({
          purchasedCredits: (currentData.purchasedCredits || 0) + 5,
        });
        console.log("Added 5 credits");
      }

      else if (productId === process.env.DODO_POWER_PRODUCT_ID) {
        await userDoc.ref.update({
          purchasedCredits: (currentData.purchasedCredits || 0) + 50,
        });
        console.log("Added 50 credits");
      }

      else {
        console.log("Unknown product ID");
      }
    }

    /* ============================
       SUBSCRIPTION CANCEL
    ============================ */
    if (eventType === "subscription.cancelled") {

      const customerEmail = payload.data?.customer?.email;

      if (!customerEmail) return res.status(200).send("No email");

      const usersRef = db.collection("users");
      const snapshot = await usersRef.where("email", "==", customerEmail).get();

      if (!snapshot.empty) {
        await snapshot.docs[0].ref.update({
          subscriptionTier: "free",
          subscriptionCredits: 5,
          subscriptionUsed: 0,
        });

        console.log("User downgraded to free");
      }
    }

    return res.status(200).send("Webhook processed");

  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(200).send("Error handled safely");
  }
});

/* =========================================
   NORMAL EXPRESS
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