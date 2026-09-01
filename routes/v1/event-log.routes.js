const express = require("express");
const eventLogController = require("../../controllers/eventLog.controller");

const router = express.Router();

router.get("/", eventLogController.listEventLogs);

module.exports = router;
