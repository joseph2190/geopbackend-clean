require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();

// IMPORTANT:
// Webhook must use raw body BEFORE express.json()
app.post("/creem-webhook", express.raw({ type: "application/json" }), (req, res) => {
  try {
    console.log("====== WEBHOOK RECEIVED ======");
    console.log("Headers:", req.headers);
    console.log("Raw body:", req.body.toString());

    return res.status(200).send("Webhook OK");
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(200).send("Still returning 200");
  }
});

// Normal middlewares AFTER webhook
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Backend running");
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});