const express = require("express");
const calendarController = require("../../controllers/calendar.controller");

const router = express.Router();

router.get("/connections", calendarController.listConnections);
router.get("/google/auth", calendarController.getGoogleAuthUrl);
router.get("/google/callback", calendarController.handleGoogleCallback);
router.delete("/connections/:id", calendarController.disconnectConnection);

module.exports = router;
