const express = require("express");
const postalController = require("../../controllers/postal.controller");

const router = express.Router();

router.post("/events", postalController.receiveEvent);
router.post("/inbound", postalController.receiveInbound);

module.exports = router;
