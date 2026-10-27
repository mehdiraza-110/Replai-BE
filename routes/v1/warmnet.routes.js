const express = require("express");
const c = require("../../controllers/warmnet.controller");

// Mounted at /admin/warmnet behind the super admin guard.
const router = express.Router();

router.get("/overview", c.overview);
router.get("/trend", c.trend);
router.get("/settings", c.getSettings);
router.patch("/settings", c.updateSettings);

router.get("/mailboxes", c.listMailboxes);
router.post("/mailboxes/action", c.mailboxAction);

router.get("/domains", c.listDomains);
router.post("/domains/register", c.registerDomains);

router.get("/messages", c.listMessages);

router.get("/seeds", c.listSeeds);
router.post("/seeds", c.createSeed);
router.patch("/seeds/:id", c.updateSeed);
router.delete("/seeds/:id", c.removeSeed);
router.post("/seeds/:id/test", c.testSeed);

router.get("/ips", c.listIps);
router.post("/ips", c.addIp);
router.post("/ips/check", c.checkAllIps);
router.post("/ips/:id/check", c.checkIp);
router.delete("/ips/:id", c.removeIp);

router.post("/engine/tick", c.runTick);
router.post("/engine/poll-seeds", c.pollSeeds);

module.exports = router;
