const express = require("express");
const ghlController = require("../../controllers/ghl.controller");

const router = express.Router();

router.get("/connection", ghlController.getConnection);
router.put("/connection", ghlController.saveConnection);
router.post("/test", ghlController.testConnection);

module.exports = router;
