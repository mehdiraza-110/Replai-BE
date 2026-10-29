const express = require("express");
const c = require("../../controllers/aiSdr.controller");

const router = express.Router();

// Inbox
router.get("/threads", c.listThreads);
router.get("/campaigns", c.listCampaigns);
router.post("/threads/bulk", c.bulk); // before the :mailboxId routes so "bulk" is not read as an id
router.get("/threads/:mailboxId/:threadId", c.getThread);
router.patch("/threads/:mailboxId/:threadId", c.patchThread);
router.post("/threads/:mailboxId/:threadId/reply", c.reply);
router.post("/threads/:mailboxId/:threadId/messages/:messageId/forward", c.forward);
router.post("/threads/:mailboxId/:threadId/drafts/:draftId/send", c.sendDraft);
router.post("/threads/:mailboxId/:threadId/drafts/:draftId/discard", c.discardDraft);

// Settings (writes are owner/admin only, enforced in the controller)
router.get("/settings", c.getSettings);
router.put("/settings", c.updateSettings);
router.put("/rules", c.updateRules);
router.put("/brain", c.updateBrain);
router.get("/overrides", c.listOverrides);
router.put("/overrides/:campaignId", c.saveOverride);
router.delete("/overrides/:campaignId", c.clearOverride);
router.post("/meeting-types", c.createMeetingType);
router.put("/meeting-types/:id", c.updateMeetingType);
router.delete("/meeting-types/:id", c.deleteMeetingType);
router.post("/resources", c.createResource);
router.delete("/resources/:id", c.deleteResource);
router.post("/webhook/secret", c.revealWebhookSecret);
router.post("/webhook/secret/rotate", c.rotateWebhookSecret);
router.post("/webhook/test", c.testWebhook);

module.exports = router;
