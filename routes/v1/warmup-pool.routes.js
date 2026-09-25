const express = require("express");
const warmupPoolController = require("../../controllers/warmupPool.controller");
const { upload } = require("../../config/multer.config");

const router = express.Router();

router.get("/stats", warmupPoolController.getStats);
router.post("/leads", warmupPoolController.addLeads);
router.post("/leads/upload", upload.single("file"), warmupPoolController.addLeadsFromFile);

module.exports = router;
