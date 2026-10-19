const express = require("express");
const mailboxController = require("../../controllers/mailbox.controller");

const { requireSuperAdmin } = require("../../middlewares/tenant.middleware");

const router = express.Router();

router.get("/", mailboxController.listMailboxes);
router.post("/", requireSuperAdmin, mailboxController.createMailboxes);
router.post("/quote", requireSuperAdmin, mailboxController.quoteMailboxes);
router.post("/sync-maildoso", requireSuperAdmin, mailboxController.syncMaildoso);
router.post("/refresh", mailboxController.refreshAllMailboxes);
router.post("/:id/refresh", mailboxController.refreshMailbox);
router.get("/:id/messages", mailboxController.listMailboxMessages);
router.delete("/:id", requireSuperAdmin, mailboxController.deleteMailbox);

module.exports = router;
