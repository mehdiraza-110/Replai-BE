const quotaService = require("../services/quota.service");
const domainService = require("../services/domain.service");

async function listAvailableHostedZones(req, res) {
  try {
    const data = await domainService.listHostedZoneDomains(req.workspaceId);
    res.status(200).json({ success: true, message: "Hosted zones fetched successfully", data });
  } catch (error) {
    sendError(res, error, "Unable to fetch Route53 hosted zones");
  }
}

async function listDomains(req, res) {
  try {
    const data = await domainService.listDomains({
      page: req.query.page,
      limit: req.query.limit,
      search: req.query.search,
      workspaceId: req.workspaceId,
    });
    res.status(200).json({ success: true, message: "Domains fetched successfully", data });
  } catch (error) {
    sendError(res, error, "Unable to fetch domains");
  }
}

async function onboardDomains(req, res) {
  try {
    const domains = Array.isArray(req.body.domains) ? req.body.domains : [];
    if (!domains.length) {
      return res.status(400).json({
        success: false,
        message: "Provide a non-empty 'domains' array",
        code: "DOMAINS_REQUIRED",
        data: null,
      });
    }

    const data = await domainService.onboardDomains(domains, req.user?.id ?? null, req.workspaceId);
    res.status(200).json({ success: true, message: "Domain onboarding started", data });
  } catch (error) {
    sendError(res, error, "Unable to onboard domains");
  }
}

async function onboardExternalDomain(req, res) {
  try {
    const domain = String(req.body.domain || "").trim().toLowerCase();
    if (!domain) {
      return res.status(400).json({
        success: false,
        message: "Provide a 'domain' to onboard",
        code: "DOMAIN_REQUIRED",
        data: null,
      });
    }

    const data = await domainService.onboardExternalDomain(domain, req.user?.id ?? null, req.workspaceId);
    res.status(200).json({ success: true, message: "Domain onboarding started", data });
  } catch (error) {
    sendError(res, error, "Unable to onboard domain");
  }
}

async function refreshDomainStatus(req, res) {
  try {
    const data = await domainService.refreshDomainStatus(req.params.domain, req.workspaceId);
    res.status(200).json({ success: true, message: "Domain status refreshed", data });
  } catch (error) {
    sendError(res, error, "Unable to refresh domain status");
  }
}

async function refreshAllDomains(req, res) {
  try {
    const data = await domainService.refreshAllDomains(req.workspaceId);
    res.status(200).json({ success: true, message: "Domain statuses refreshed", data });
  } catch (error) {
    sendError(res, error, "Unable to refresh domain statuses");
  }
}

async function getAccountStatus(req, res) {
  try {
    const data = await domainService.getAccountStatus(req.workspaceId);
    res.status(200).json({ success: true, message: "SES account status fetched successfully", data });
  } catch (error) {
    sendError(res, error, "Unable to fetch SES account status");
  }
}

async function requestProductionAccess(req, res) {
  try {
    const data = await domainService.requestProductionAccess({
      ...req.body,
      createdBy: req.user?.id ?? null,
      workspaceId: req.workspaceId,
    });
    res.status(200).json({ success: true, message: "Production access request submitted", data });
  } catch (error) {
    sendError(res, error, "Unable to submit production access request");
  }
}

async function deleteDomain(req, res) {
  try {
    const data = await domainService.deleteDomain(req.params.id, req.workspaceId);
    res.status(200).json({ success: true, message: "Domain deleted successfully", data });
  } catch (error) {
    sendError(res, error, "Unable to delete domain");
  }
}

async function getReputationTrend(req, res) {
  try {
    const data = await domainService.getReputationTrend({ days: req.query.days, workspaceId: req.workspaceId });
    res.status(200).json({ success: true, message: "Reputation trend fetched successfully", data });
  } catch (error) {
    sendError(res, error, "Unable to fetch reputation trend");
  }
}

function sendError(res, error, fallbackMessage) {
  if (quotaService.isQuotaError(error)) return res.status(403).json(quotaService.errorBody(error));
  res.status(error.statusCode || 500).json({
    success: false,
    message: error.message || fallbackMessage,
    code: error.code || "DOMAIN_REQUEST_FAILED",
    data: null,
  });
}

module.exports = {
  listAvailableHostedZones,
  listDomains,
  onboardDomains,
  onboardExternalDomain,
  refreshDomainStatus,
  refreshAllDomains,
  getAccountStatus,
  requestProductionAccess,
  getReputationTrend,
  deleteDomain,
};
