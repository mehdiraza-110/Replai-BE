const quotaService = require("../services/quota.service");
const orderService = require("../services/order.service");
const { WorkspaceError } = require("../services/workspace.service");

function sendError(res, error, fallback) {
  if (quotaService.isQuotaError(error)) return res.status(403).json(quotaService.errorBody(error));
  if (error instanceof WorkspaceError) return res.status(error.status).json({ success: false, message: error.message });
  console.error(fallback, error);
  res.status(500).json({ success: false, message: fallback });
}

// Owners and admins (and super admin "View as", which acts as owner) may create/cancel; members read only.
function requireManager(req, res) {
  if (req.viewingAs || ["owner", "admin"].includes(req.workspace.role)) return true;
  res.status(403).json({ success: false, message: "Only workspace owners and admins can place or cancel orders." });
  return false;
}

module.exports = {
  async list(req, res) {
    try {
      res.json({ success: true, data: await orderService.list(req.workspaceId) });
    } catch (e) { sendError(res, e, "We couldn't load your requests. Please try again."); }
  },
  async get(req, res) {
    try {
      res.json({ success: true, data: await orderService.get(req.workspaceId, req.params.id) });
    } catch (e) { sendError(res, e, "We couldn't load this request. Please try again."); }
  },
  async create(req, res) {
    if (!requireManager(req, res)) return;
    try {
      const data = await orderService.create(req.workspaceId, req.user.id, req.body || {});
      res.status(201).json({ success: true, message: "Request submitted", data });
    } catch (e) { sendError(res, e, "We couldn't submit your request. Please try again."); }
  },
  async cancel(req, res) {
    if (!requireManager(req, res)) return;
    try {
      const data = await orderService.cancel(req.workspaceId, req.params.id);
      res.json({ success: true, message: "Request cancelled", data });
    } catch (e) { sendError(res, e, "We couldn't cancel this request. Please try again."); }
  },
};
