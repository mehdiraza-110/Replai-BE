const express = require("express");
const c = require("../../controllers/ai.controller");

const router = express.Router();

router.get("/chat", c.chatList);
router.post("/chat/messages", c.chatSend);
router.get("/chat/:id", c.chatGet);
router.delete("/chat/:id", c.chatDelete);

router.get("/calls", c.callList);
router.post("/calls", c.callCreate);
router.get("/calls/:id", c.callGet);
router.post("/calls/:id/reanalyze", c.callReanalyze);
router.delete("/calls/:id", c.callDelete);

router.get("/sites", c.siteList);
router.post("/sites", c.siteCreate);
router.get("/sites/:id", c.siteGet);
router.delete("/sites/:id", c.siteDelete);
router.patch("/sites/:id", c.siteRename);
router.post("/sites/:id/revise", c.siteRevise);
router.post("/sites/:id/regenerate", c.siteRegenerate);
router.get("/sites/:id/versions", c.siteVersions);
router.post("/sites/:id/versions/:versionId/restore", c.siteRestore);
router.post("/sites/:id/publish", c.sitePublish);
router.post("/sites/:id/unpublish", c.siteUnpublish);
router.put("/sites/:id/domain", c.siteSetDomain);
router.post("/sites/:id/domain/check", c.siteCheckDomain);

router.post("/reports/growth-plan/prefill", c.growthPrefill);
router.get("/reports/:kind", c.reportList);
router.post("/reports/:kind", c.reportCreate);
router.get("/reports/:kind/:id", c.reportGet);
router.post("/reports/:kind/:id/retry", c.reportRetry);
router.delete("/reports/:kind/:id", c.reportDelete);

module.exports = router;
