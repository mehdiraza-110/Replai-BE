const express = require("express");
const sesInboundController = require("../../controllers/sesInbound.controller");

const router = express.Router();

// SNS posts Content-Type: text/plain even though the body is JSON, so the app-wide
// express.json() middleware skips it — parse the raw body as text for this route only.
router.post("/notifications", express.text({ type: () => true, limit: "10mb" }), sesInboundController.receiveNotification);

module.exports = router;
