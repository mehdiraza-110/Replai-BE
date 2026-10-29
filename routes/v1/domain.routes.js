const express = require("express");
const domainController = require("../../controllers/domain.controller");

const { requireSuperAdmin } = require("../../middlewares/tenant.middleware");

const router = express.Router();

router.get("/reputation-trend", domainController.getReputationTrend);
router.get("/", domainController.listDomains);
router.post("/refresh", domainController.refreshAllDomains);
router.post("/:domain/refresh", domainController.refreshDomainStatus);
router.delete("/:id", requireSuperAdmin, domainController.deleteDomain);

module.exports = router;
