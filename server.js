require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();

/*
  IMPORTANT:
  Webhook route must use express.raw BEFORE express.json()
  Otherwise signature parsing and body reading break.
*/
app.post("/creem-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const rawBody = req.body.toString();
    const payload = JSON.parse(rawBody);

    console.log("=================================");
    console.log("====== CREEM WEBHOOK RECEIVED ======");
    console.log("Full Payload:");
    console.log(JSON.stringify(payload, null, 2));
    console.log("=================================");

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