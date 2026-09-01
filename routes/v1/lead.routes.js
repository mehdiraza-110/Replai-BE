const express = require("express");
const leadController = require("../../controllers/lead.controller");

const router = express.Router();

router.get("/", leadController.listPositiveLeads);

module.exports = router;
