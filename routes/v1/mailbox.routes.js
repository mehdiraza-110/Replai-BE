const express = require("express");
const mailboxController = require("../../controllers/mailbox.controller");

const router = express.Router();

router.get("/", mailboxController.listMailboxes);
router.post("/", mailboxController.createMailboxes);
router.post("/quote", mailboxController.quoteMailboxes);
router.post("/sync-maildoso", mailboxController.syncMaildoso);
router.post("/refresh", mailboxController.refreshAllMailboxes);
router.post("/:id/refresh", mailboxController.refreshMailbox);
router.get("/:id/messages", mailboxController.listMailboxMessages);
router.delete("/:id", mailboxController.deleteMailbox);

module.exports = router;
