const express = require("express");
const c = require("../../controllers/emailAccounts.controller");
const { requireSuperAdmin } = require("../../middlewares/tenant.middleware");

const router = express.Router();

router.get("/inboxes", c.listInboxes);
router.patch("/inboxes/:id", c.updateInbox);
router.get("/domains", c.listDomains);
router.get("/domains/:id/dns", c.domainDns);
router.patch("/domains/:id/dkim", requireSuperAdmin, c.setDkimSelector);
router.post("/domains/:id/apply-dns", requireSuperAdmin, c.applyDns);
// Onboarding hundreds of domains is platform work: it creates inboxes and queues them for warm-up.
router.get("/postal/status", requireSuperAdmin, c.postalStatus);
router.post("/domains/onboard", requireSuperAdmin, c.onboardDomains);
router.post("/domains/sync-postal", requireSuperAdmin, c.syncPostal);
router.post("/domains/bulk", requireSuperAdmin, c.bulkRegisterDomains);

module.exports = router;
