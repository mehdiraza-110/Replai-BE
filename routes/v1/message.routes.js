const express = require("express");
const messageController = require("../../controllers/message.controller");

const router = express.Router();

router.get("/conversations", messageController.listConversations);
router.get("/conversations/:threadId", messageController.getConversation);
router.post("/conversations/:threadId/reply", messageController.sendManualReply);
router.post("/conversations/:threadId/draft", messageController.generateDraft);
router.post("/drafts/:draftId/approve", messageController.approveDraft);
router.post("/drafts/:draftId/reject", messageController.rejectDraft);

module.exports = router;
