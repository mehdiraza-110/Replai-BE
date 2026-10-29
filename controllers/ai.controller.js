const chat = require("../services/ai/chat.service");
const calls = require("../services/ai/callAnalyzer.service");
const reports = require("../services/ai/reports.service");
const sites = require("../services/ai/sites.service");
const quotaService = require("../services/quota.service");

const SLUGS = { "market-research": "market_research", offer: "offer", "growth-plan": "growth_plan" };

function sendError(res, error, fallback) {
  if (quotaService.isQuotaError(error)) return res.status(403).json(quotaService.errorBody(error));
  const status = error.statusCode || 500;
  if (status >= 500 && status !== 503) console.error(fallback, error);
  res.status(status).json({ success: false, message: status >= 500 && status !== 503 ? fallback : error.message, code: error.code && !/^\d+$/.test(String(error.code)) ? error.code : "AI_FAILED", data: null });
}

const route = (message, handler, ok = 200) => async (req, res) => {
  try {
    res.status(ok).json({ success: true, message, data: await handler(req) });
  } catch (error) {
    sendError(res, error, message);
  }
};

const ws = (req) => req.workspaceId;
const uid = (req) => req.user.id;
const kind = (req) => SLUGS[req.params.kind] || "";

module.exports = {
  chatList: route("Unable to load chats", (req) => chat.listThreads(ws(req), uid(req))),
  chatGet: route("Unable to load the chat", (req) => chat.getThread(ws(req), uid(req), req.params.id)),
  chatDelete: route("Unable to delete the chat", (req) => chat.deleteThread(ws(req), uid(req), req.params.id)),
  chatSend: route("Unable to send the message", (req) => chat.send(ws(req), uid(req), req.body || {})),

  callList: route("Unable to load calls", (req) => calls.list(ws(req), req.query)),
  callCreate: route("Unable to submit the call", (req) => calls.create(ws(req), uid(req), req.body || {}), 202),
  callGet: route("Unable to load the call", (req) => calls.get(ws(req), req.params.id)),
  callReanalyze: route("Unable to re-analyze the call", (req) => calls.reanalyze(ws(req), req.params.id), 202),
  callDelete: route("Unable to delete the call", (req) => calls.remove(ws(req), req.params.id)),

  reportList: route("Unable to load reports", (req) => reports.list(ws(req), kind(req), req.query)),
  reportCreate: route("Unable to start the report", (req) => reports.create(ws(req), uid(req), kind(req), req.body || {}), 202),
  reportGet: route("Unable to load the report", (req) => reports.get(ws(req), kind(req), req.params.id)),
  reportRetry: route("Unable to retry the report", (req) => reports.retry(ws(req), kind(req), req.params.id), 202),
  reportDelete: route("Unable to delete the report", (req) => reports.remove(ws(req), kind(req), req.params.id)),
  siteList: route("Unable to load sites", (req) => sites.list(ws(req))),
  siteCreate: route("Unable to start the site", (req) => sites.create(ws(req), uid(req), req.body || {}), 202),
  siteGet: route("Unable to load the site", (req) => sites.get(ws(req), req.params.id)),
  siteRevise: route("Unable to update the site", (req) => sites.revise(ws(req), req.params.id, req.body?.instruction), 202),
  siteRegenerate: route("Unable to rebuild the site", (req) => sites.regenerate(ws(req), req.params.id), 202),
  siteRename: route("Unable to rename the site", (req) => sites.rename(ws(req), req.params.id, req.body?.name)),
  siteVersions: route("Unable to load the history", (req) => sites.versions(ws(req), req.params.id)),
  siteRestore: route("Unable to restore that version", (req) => sites.restore(ws(req), req.params.id, req.params.versionId)),
  sitePublish: route("Unable to publish the site", (req) => sites.publish(ws(req), req.params.id)),
  siteUnpublish: route("Unable to unpublish the site", (req) => sites.unpublish(ws(req), req.params.id)),
  siteDelete: route("Unable to delete the site", (req) => sites.remove(ws(req), req.params.id)),
  siteSetDomain: route("Unable to connect the domain", (req) => sites.setDomain(ws(req), req.params.id, req.body?.domain)),
  siteCheckDomain: route("Unable to check the domain", (req) => sites.checkDomain(ws(req), req.params.id)),
  growthPrefill: route("Unable to read the transcript", (req) => reports.prefillGrowthPlan(ws(req), req.body?.transcript)),
};
