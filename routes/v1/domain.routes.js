const express = require("express");
const domainController = require("../../controllers/domain.controller");

const router = express.Router();

router.get("/hosted-zones", domainController.listAvailableHostedZones);
router.get("/account-status", domainController.getAccountStatus);
router.get("/reputation-trend", domainController.getReputationTrend);
router.post("/account-status/request", domainController.requestProductionAccess);
router.get("/", domainController.listDomains);
router.post("/onboard", domainController.onboardDomains);
router.post("/onboard-external", domainController.onboardExternalDomain);
router.post("/refresh", domainController.refreshAllDomains);
router.post("/:domain/refresh", domainController.refreshDomainStatus);
router.delete("/:id", domainController.deleteDomain);

module.exports = router;
