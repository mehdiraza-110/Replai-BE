const express = require("express");
const sesEventsController = require("../../controllers/sesEvents.controller");

const router = express.Router();

// SNS posts Content-Type: text/plain even though the body is JSON — parse as raw text here only.
router.post("/notifications", express.text({ type: () => true, limit: "10mb" }), sesEventsController.receiveNotification);

module.exports = router;
