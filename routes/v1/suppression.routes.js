const express = require("express");
const suppressionController = require("../../controllers/suppression.controller");

const router = express.Router();

router.get("/", suppressionController.listSuppressions);
router.post("/", suppressionController.createManualSuppression);

module.exports = router;
