app.post("/creem-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const payload = JSON.parse(req.body.toString());

    console.log("Webhook event:", payload.type);

    if (payload.type === "subscription.active" || payload.type === "subscription.paid") {
      const customerEmail = payload.data?.customer?.email;

      console.log("Customer email:", customerEmail);

      // TODO: Update Firestore user subscription here
    }

    return res.status(200).send("Webhook processed");
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(200).send("Error handled safely");
  }
});