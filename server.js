require("dotenv").config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();

/* FIREBASE INIT */
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const db = admin.firestore();

/* DODO WEBHOOK */
app.post("/dodo-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const payload = JSON.parse(req.body.toString());

    console.log("====== DODO WEBHOOK RECEIVED ======");
    console.log("Event Type:", payload.type);

    if (payload.type === "payment.succeeded") {

      const customerEmail = payload.data?.customer?.email;
      const paymentLink = payload.data?.payment_link;

      if (!customerEmail || !paymentLink) {
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

      /* SUBSCRIPTIONS */
      if (paymentLink === process.env.DODO_LITE_LINK) {
        await userDoc.ref.update({
          subscriptionTier: "lite",
          subscriptionCredits: 15,
          subscriptionUsed: 0,
          subscriptionStartDate: new Date().toISOString(),
        });
        console.log("Upgraded to Lite");
      }

      else if (paymentLink === process.env.DODO_PRO_LINK) {
        await userDoc.ref.update({
          subscriptionTier: "pro",
          subscriptionCredits: 50,
          subscriptionUsed: 0,
          subscriptionStartDate: new Date().toISOString(),
        });
        console.log("Upgraded to Pro");
      }

      /* CREDIT PACKS */
      else if (paymentLink === process.env.DODO_STARTER_LINK) {
        await userDoc.ref.update({
          purchasedCredits: (currentData.purchasedCredits || 0) + 5,
        });
        console.log("Added 5 credits");
      }

      else if (paymentLink === process.env.DODO_POWER_LINK) {
        await userDoc.ref.update({
          purchasedCredits: (currentData.purchasedCredits || 0) + 50,
        });
        console.log("Added 50 credits");
      }

      else {
        console.log("Unknown payment link");
      }
    }

    return res.status(200).send("Webhook processed");

  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(200).send("Error handled safely");
  }
});

/* EXPRESS */
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Backend running");
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});