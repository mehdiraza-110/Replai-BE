const warmnet = require("../services/warmnet.service");
const { WorkspaceError } = require("../services/workspace.service");

function sendError(res, error, fallback) {
  if (error instanceof WorkspaceError) {
    return res.status(error.status).json({ success: false, message: error.message, ...(error.code ? { code: error.code } : {}) });
  }
  console.error(fallback, error);
  res.status(500).json({ success: false, message: fallback });
}

// Success status/message + data, uniform error handling (same shape as admin.controller).
const handle = (fallback, status, message, fn) => async (req, res) => {
  try {
    const data = await fn(req);
    const body = { success: true, ...(message ? { message } : {}) };
    if (data !== undefined) body.data = data;
    res.status(status).json(body);
  } catch (error) {
    sendError(res, error, fallback);
  }
};

const id = (req) => {
  const n = parseInt(req.params.id, 10);
  if (!Number.isInteger(n) || n < 1) throw new WorkspaceError("That item could not be found.", 404);
  return n;
};

module.exports = {
  overview: handle("We couldn't load the overview. Please try again.", 200, null, () => warmnet.overview()),
  trend: handle("We couldn't load the trend. Please try again.", 200, null, (req) => warmnet.trend(req.query.days)),
  getSettings: handle("We couldn't load the settings. Please try again.", 200, null, () => warmnet.getSettings()),
  updateSettings: handle("We couldn't save the settings. Please try again.", 200, "Settings saved", (req) => warmnet.updateSettings(req.body || {})),

  listMailboxes: handle("We couldn't load mailboxes. Please try again.", 200, null, (req) => warmnet.listMailboxes(req.query)),
  mailboxAction: handle("We couldn't apply that action. Please try again.", 200, "Done", (req) => warmnet.mailboxAction(req.body || {})),

  listDomains: handle("We couldn't load domains. Please try again.", 200, null, () => warmnet.listDomains()),
  registerDomains: handle("We couldn't register these domains. Please try again.", 200, "Domains registered", (req) => warmnet.registerDomains(req.user.id, req.body || {})),

  addMailboxes: handle("We couldn't add the inboxes. Please try again.", 201, "Inboxes added", (req) => warmnet.addMailboxes(req.user.id, { ...(req.body || {}), domainId: id(req) })),

  listMessages: handle("We couldn't load the activity. Please try again.", 200, null, (req) => warmnet.listMessages(req.query)),

  listSeeds: handle("We couldn't load seed inboxes. Please try again.", 200, null, async () => ({ items: await warmnet.listSeeds(), presets: warmnet.seedPresets() })),
  createSeed: handle("We couldn't add this seed inbox. Please try again.", 201, "Seed inbox added", (req) => warmnet.createSeed(req.body || {})),
  updateSeed: handle("We couldn't update this seed inbox. Please try again.", 200, "Seed inbox updated", (req) => warmnet.updateSeed(id(req), req.body || {})),
  removeSeed: handle("We couldn't remove this seed inbox. Please try again.", 200, "Seed inbox removed", async (req) => { await warmnet.removeSeed(id(req)); }),
  testSeed: handle("We couldn't test this seed inbox. Please try again.", 200, null, (req) => warmnet.testSeed(id(req))),

  listIps: handle("We couldn't load IPs. Please try again.", 200, null, async () => ({ items: await warmnet.listIps(), blocklists: require("../services/warmnetIp.service").blocklists() })),
  addIp: handle("We couldn't add this IP. Please try again.", 201, "IP added", (req) => warmnet.addIp(req.body || {})),
  removeIp: handle("We couldn't remove this IP. Please try again.", 200, "IP removed", async (req) => { await warmnet.removeIp(id(req)); }),
  checkIp: handle("We couldn't check this IP. Please try again.", 200, null, (req) => warmnet.checkIp(id(req))),
  checkAllIps: handle("We couldn't check the IPs. Please try again.", 200, null, () => warmnet.checkAllIps()),

  runTick: handle("We couldn't run the engine. Please try again.", 200, null, (req) => warmnet.runTick((req.body || {}).force === true)),
  pollSeeds: handle("We couldn't poll the seed inboxes. Please try again.", 200, null, () => warmnet.pollSeeds()),
};
