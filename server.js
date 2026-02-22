require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();

// Webhook MUST come before express.json()
app.post("/creem-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const payload = JSON.parse(req.body.toString());

    console.log("====== WEBHOOK RECEIVED ======");
    console.log("Event type:", payload.type);

    if (
      payload.type === "subscription.active" ||
      payload.type === "subscription.paid"
    ) {
      const customerEmail = payload.data?.customer?.email;
      console.log("Customer email:", customerEmail);
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