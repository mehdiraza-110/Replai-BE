const express = require("express");
const replier = require("../../services/replier.service");
const quotaService = require("../../services/quota.service");

const router = express.Router();

const canEdit = (req) => Boolean(req.user?.isSuperAdmin) || ["owner", "admin"].includes(req.workspace?.role);

const handle = (message, handler, { write = false } = {}) => async (req, res) => {
  if (write && !canEdit(req)) {
    return res.status(403).json({ success: false, message: "Only workspace owners and admins can change the Replier.", code: "FORBIDDEN", data: null });
  }
  try {
    res.status(200).json({ success: true, message, data: await handler(req) });
  } catch (error) {
    if (quotaService.isQuotaError(error)) return res.status(403).json(quotaService.errorBody(error));
    const status = error.statusCode || 500;
    if (status >= 500) console.error(message, error);
    res.status(status).json({ success: false, message: status >= 500 ? message : error.message, code: "REPLIER_REQUEST_FAILED", data: null });
  }
};

// agentId "sdr" is the built-in AI SDR; a number is a legacy agent.
const agentOf = (req) => (req.params.agentId === "sdr" ? null : req.params.agentId);

router.get("/coverage", handle("Unable to load campaigns", (req) => replier.coverage(req.workspaceId)));
router.put("/campaigns/:campaignId/agent", handle("Unable to assign the agent", (req) => replier.assignCampaign(req.workspaceId, req.params.campaignId, req.body?.agentId ?? null), { write: true }));
router.get("/agents/:agentId/reply-types", handle("Unable to load reply types", (req) => replier.list(req.workspaceId, agentOf(req))));
router.put("/agents/:agentId/reply-types", handle("Unable to save reply types", (req) => replier.save(req.workspaceId, agentOf(req), req.body?.replyTypes), { write: true }));

module.exports = router;
