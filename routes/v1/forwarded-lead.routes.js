const express = require("express");
const forwardedLeadController = require("../../controllers/forwardedLead.controller");

const router = express.Router();

router.get("/", forwardedLeadController.listForwardedLeads);

module.exports = router;
