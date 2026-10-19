const express = require("express");
const domainController = require("../../controllers/domain.controller");

const { requireSuperAdmin } = require("../../middlewares/tenant.middleware");

const router = express.Router();

router.get("/hosted-zones", domainController.listAvailableHostedZones);
router.get("/account-status", domainController.getAccountStatus);
router.get("/reputation-trend", domainController.getReputationTrend);
router.post("/account-status/request", requireSuperAdmin, domainController.requestProductionAccess);
router.get("/", domainController.listDomains);
router.post("/onboard", requireSuperAdmin, domainController.onboardDomains);
router.post("/onboard-external", requireSuperAdmin, domainController.onboardExternalDomain);
router.post("/refresh", domainController.refreshAllDomains);
router.post("/:domain/refresh", domainController.refreshDomainStatus);
router.delete("/:id", requireSuperAdmin, domainController.deleteDomain);

module.exports = router;
