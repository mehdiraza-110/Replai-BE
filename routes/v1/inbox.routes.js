const express = require("express");
const inboxController = require("../../controllers/inbox.controller");

const router = express.Router();

router.get("/threads", inboxController.listThreads);
router.get("/threads/:mailboxId/:threadId", inboxController.getThread);
router.post("/threads/:mailboxId/:threadId/read", inboxController.markThreadRead);
router.post("/threads/:mailboxId/:threadId/reply", inboxController.sendReply);

module.exports = router;
