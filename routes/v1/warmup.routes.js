const express = require("express");
const warmupController = require("../../controllers/warmup.controller");

const router = express.Router();

router.get("/strategies", warmupController.listStrategies);
router.post("/strategies", warmupController.createStrategy);
router.post("/strategies/:id/assign", warmupController.assignStrategy);
router.post("/generate-ai", warmupController.generateAiSchedule);
router.get("/summary", warmupController.getSummary);
router.post("/tick", warmupController.runTick);

module.exports = router;
