const onboarding = require("../services/postalOnboarding.service");
const service = require("../services/emailAccounts.service");

function sendError(res, error, fallback) {
  const status = error.statusCode || 500;
  if (status >= 500 && status !== 503) console.error(fallback, error);
  res.status(status).json({ success: false, message: status >= 500 && status !== 503 ? fallback : error.message, code: error.code || "EMAIL_ACCOUNTS_FAILED", data: null });
}

const route = (message, handler) => async (req, res) => {
  try {
    res.status(200).json({ success: true, message, data: await handler(req) });
  } catch (error) {
    sendError(res, error, message);
  }
};

module.exports = {
  listInboxes: route("Unable to load inboxes", (req) => service.listInboxes(req.workspaceId, req.query)),
  updateInbox: route("Unable to update the inbox", (req) => service.updateInbox(req.workspaceId, req.params.id, req.body || {})),
  listDomains: route("Unable to load domains", (req) => service.listDomains(req.workspaceId, req.query)),
  domainDns: route("Unable to load the DNS records", (req) => service.domainDns(req.workspaceId, req.params.id)),
  setDkimSelector: route("Unable to save the DKIM selector", (req) => service.setDkimSelector(req.workspaceId, req.params.id, req.body?.dkimSelector)),
  applyDns: route("Unable to set up the DNS records", (req) => service.applyDns(req.workspaceId, req.params.id)),
  postalStatus: route("Unable to check the mail server setup", () => onboarding.readiness()),
  onboardDomains: route("Unable to onboard the domains", (req) =>
    onboarding.onboard(req.user.id, { ...(req.body || {}), workspaceId: req.user.isSuperAdmin && req.body?.workspaceId ? req.body.workspaceId : req.workspaceId })),
  syncPostal: route("Unable to read the mail server", (req) => onboarding.syncFromPostal(req.user.id, { workspaceId: req.workspaceId })),
  // Registers into the signed-in workspace unless a super admin names another one.
  bulkRegisterDomains: route("Unable to add domains", (req) =>
    service.bulkRegisterDomains(req.user.id, { ...(req.body || {}), workspaceId: req.user.isSuperAdmin && req.body?.workspaceId ? req.body.workspaceId : req.workspaceId })),
};
