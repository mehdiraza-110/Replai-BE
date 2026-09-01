const express = require("express");
const plusVibeController = require("../../controllers/plusVibe.controller");

const router = express.Router();

router.get("/connection", plusVibeController.getConnection);
router.put("/connection", plusVibeController.saveConnection);
router.post("/test", plusVibeController.testConnection);
router.post("/refresh", plusVibeController.refreshConnection);
router.get("/inboxes", plusVibeController.listInboxes);
router.get("/campaigns", plusVibeController.listCampaigns);
router.post("/campaigns/sync", plusVibeController.syncCampaigns);
router.patch("/campaigns/:id/agent", plusVibeController.assignCampaignAgent);
router.post("/webhook", plusVibeController.receiveWebhook);

module.exports = router;
