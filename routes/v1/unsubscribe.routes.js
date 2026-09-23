const express = require("express");
const unsubscribeController = require("../../controllers/unsubscribe.controller");

const router = express.Router();

// Public — no auth. Recipients reach these directly from an email footer/header, with no session.
router.get("/:token", unsubscribeController.unsubscribe);
router.post("/:token", unsubscribeController.unsubscribeOneClick);

module.exports = router;
