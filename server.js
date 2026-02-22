require("dotenv").config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();

/*
  Initialize Firebase Admin
  (Using environment variables in Render, NOT JSON file)
*/
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const db = admin.firestore();

/*
  Creem Webhook
*/
app.post("/creem-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const payload = JSON.parse(req.body.toString());

    console.log("====== CREEM WEBHOOK RECEIVED ======");
    console.log("Event Type:", payload.eventType);

    const eventType = payload.eventType;

    if (eventType === "subscription.active" || eventType === "subscription.paid") {
      const customerEmail = payload.object?.customer?.email;
      const productId = payload.object?.product?.id;

      console.log("Customer email:", customerEmail);
      console.log("Product ID:", productId);

      if (!customerEmail) {
        return res.status(200).send("No email found");
      }

      // Find user by email
      const usersRef = db.collection("users");
      const snapshot = await usersRef.where("email", "==", customerEmail).get();

      if (snapshot.empty) {
        console.log("No user found with that email");
        return res.status(200).send("User not found");
      }

      const userDoc = snapshot.docs[0];

      // Decide plan based on product ID
      let newTier = "lite";
      let newCredits = 15;

      if (productId === process.env.CREEM_PRO_PRODUCT_ID) {
        newTier = "pro";
        newCredits = 50;
      }

      await userDoc.ref.update({
        subscriptionTier: newTier,
        totalCredits: newCredits,
        creditsUsed: 0,
        subscriptionStartDate: new Date().toISOString(),
        lastDailyReset: new Date().toISOString(),
      });

      console.log("User upgraded to:", newTier);
    }

    return res.status(200).send("Webhook processed");
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(200).send("Error handled safely");
  }
});

// Normal middleware AFTER webhook
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Backend running");
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});