const quotaService = require("../services/quota.service");
const domainService = require("../services/domain.service");

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
  listDomains,
  refreshDomainStatus,
  refreshAllDomains,
  getReputationTrend,
  deleteDomain,
};
