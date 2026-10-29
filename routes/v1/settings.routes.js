const express = require("express");
const c = require("../../controllers/settings.controller");

const router = express.Router();

router.get("/preferences", c.getPreferences);
router.patch("/preferences", c.updatePreferences);
router.get("/workspace", c.getWorkspace);
router.patch("/workspace", c.updateWorkspace);
router.get("/audit", c.listAudit);

router.get("/tokens", c.listTokens);
router.post("/tokens", c.createToken);
router.delete("/tokens/:id", c.revokeToken);

router.get("/templates", c.listTemplates);
router.post("/templates", c.createTemplate);
router.patch("/templates/:id", c.updateTemplate);
router.delete("/templates/:id", c.deleteTemplate);

router.get("/custom-fields", c.listFields);
router.post("/custom-fields", c.createField);
router.patch("/custom-fields/:id", c.updateField);
router.delete("/custom-fields/:id", c.deleteField);

router.get("/outcomes", c.listOutcomes);
router.post("/outcomes", c.createOutcome);
router.patch("/outcomes/:id", c.updateOutcome);
router.delete("/outcomes/:id", c.deleteOutcome);

router.get("/snapshots", c.listSnapshots);
router.post("/snapshots", c.captureSnapshot);
router.post("/snapshots/:id/apply", c.applySnapshot);
router.delete("/snapshots/:id", c.deleteSnapshot);

router.get("/blocklist", c.listBlocklist);
router.post("/blocklist", c.addBlocklist);
router.post("/blocklist/remove", c.removeBlocklist);
router.post("/blocklist/import", c.importBlocklist);
router.get("/blocklist/export", c.exportBlocklist);

router.get("/billing", c.billing);

module.exports = router;
