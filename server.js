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
   DODO WEBHOOK (DEBUG MODE)
========================================= */
app.post("/dodo-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const rawBody = req.body.toString();
    const payload = JSON.parse(rawBody);

    console.log("==========================================");
    console.log("====== FULL DODO WEBHOOK PAYLOAD ======");
    console.log(JSON.stringify(payload, null, 2));
    console.log("==========================================");

    return res.status(200).send("Webhook logged successfully");

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