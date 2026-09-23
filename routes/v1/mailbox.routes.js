const express = require("express");
const mailboxController = require("../../controllers/mailbox.controller");

const router = express.Router();

router.get("/", mailboxController.listMailboxes);
router.post("/", mailboxController.createMailboxes);
router.post("/refresh", mailboxController.refreshAllMailboxes);
router.post("/:id/refresh", mailboxController.refreshMailbox);
router.delete("/:id", mailboxController.deleteMailbox);

module.exports = router;
