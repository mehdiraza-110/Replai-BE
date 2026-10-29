const prefs = require("../services/settings/preferences.service");
const tokens = require("../services/settings/apiTokens.service");
const library = require("../services/settings/library.service");
const blocklist = require("../services/settings/blocklist.service");
const billing = require("../services/settings/billing.service");

function sendError(res, error, fallback) {
  const status = error.statusCode || 500;
  if (status >= 500) console.error(fallback, error);
  res.status(status).json({ success: false, message: status >= 500 ? fallback : error.message, code: "SETTINGS_FAILED", data: null });
}

const forbid = (message) => Object.assign(new Error(message), { statusCode: 403 });
const canManage = (req) => req.user.isSuperAdmin || ["owner", "admin"].includes(req.workspace.role);
const needAdmin = (req) => { if (!canManage(req)) throw forbid("Only workspace owners and admins can change this."); };
const needSession = (req) => { if (req.viaApiToken) throw forbid("Sign in to the app to manage API tokens. A token can't create or revoke tokens."); };

const route = (message, handler, { admin = false } = {}) => async (req, res) => {
  try {
    if (admin) needAdmin(req);
    res.status(200).json({ success: true, message, data: await handler(req) });
  } catch (error) {
    sendError(res, error, message);
  }
};

const ws = (req) => req.workspaceId;
const uid = (req) => req.user.id;

module.exports = {
  getPreferences: route("Unable to load your preferences", (req) => prefs.getPreferences(uid(req))),
  updatePreferences: route("Unable to save your preferences", (req) => prefs.updatePreferences(uid(req), req.body || {})),
  getWorkspace: route("Unable to load workspace settings", (req) => prefs.getWorkspaceSettings(ws(req))),
  updateWorkspace: route("Unable to save workspace settings", (req) => prefs.updateWorkspaceSettings(ws(req), uid(req), req.body || {}), { admin: true }),
  listAudit: route("Unable to load the history", (req) => prefs.listAudit(ws(req), req.query.area || "sharing")),

  listTokens: route("Unable to load tokens", (req) => { needSession(req); return tokens.list(ws(req), uid(req), req.query.kind || "personal"); }),
  createToken: route("Unable to create the token", (req) => {
    needSession(req);
    if (req.body?.kind === "workspace") needAdmin(req);
    return tokens.create(ws(req), uid(req), req.body?.kind || "personal", req.body?.name);
  }),
  revokeToken: route("Unable to revoke the token", (req) => { needSession(req); return tokens.revoke(ws(req), uid(req), req.params.id, { canManageWorkspace: canManage(req) }); }),

  listTemplates: route("Unable to load templates", (req) => library.listTemplates(ws(req), uid(req), req.query)),
  createTemplate: route("Unable to save the template", (req) => library.createTemplate(ws(req), uid(req), req.body || {})),
  updateTemplate: route("Unable to save the template", (req) => library.updateTemplate(ws(req), uid(req), req.params.id, req.body || {}, { canManage: canManage(req) })),
  deleteTemplate: route("Unable to delete the template", (req) => library.deleteTemplate(ws(req), uid(req), req.params.id, { canManage: canManage(req) })),

  listFields: route("Unable to load custom fields", (req) => library.listFields(ws(req), req.query.entity)),
  createField: route("Unable to create the field", (req) => library.createField(ws(req), req.body || {}), { admin: true }),
  updateField: route("Unable to update the field", (req) => library.updateField(ws(req), req.params.id, req.body || {}), { admin: true }),
  deleteField: route("Unable to delete the field", (req) => library.deleteField(ws(req), req.params.id), { admin: true }),

  listOutcomes: route("Unable to load outcomes", (req) => library.listOutcomes(ws(req))),
  createOutcome: route("Unable to create the outcome", (req) => library.createOutcome(ws(req), req.body || {}), { admin: true }),
  updateOutcome: route("Unable to update the outcome", (req) => library.updateOutcome(ws(req), req.params.id, req.body || {}), { admin: true }),
  deleteOutcome: route("Unable to delete the outcome", (req) => library.deleteOutcome(ws(req), req.params.id), { admin: true }),

  listSnapshots: route("Unable to load snapshots", (req) => library.listSnapshots(ws(req))),
  captureSnapshot: route("Unable to save the snapshot", (req) => library.captureSnapshot(ws(req), uid(req), req.body || {}), { admin: true }),
  applySnapshot: route("Unable to apply the snapshot", (req) => library.applySnapshot(ws(req), uid(req), req.params.id), { admin: true }),
  deleteSnapshot: route("Unable to delete the snapshot", (req) => library.deleteSnapshot(ws(req), req.params.id), { admin: true }),

  listBlocklist: route("Unable to load the blocklist", (req) => blocklist.list(ws(req), req.query)),
  addBlocklist: route("Unable to add to the blocklist", (req) => blocklist.add(ws(req), req.body || {})),
  removeBlocklist: route("Unable to remove from the blocklist", (req) => blocklist.remove(ws(req), req.body || {})),
  importBlocklist: route("Unable to import the file", (req) => blocklist.importCsv(ws(req), req.body?.text)),
  async exportBlocklist(req, res) {
    try {
      const csv = await blocklist.exportCsv(ws(req));
      res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="blocklist.csv"' }).status(200).send(csv);
    } catch (error) {
      sendError(res, error, "Unable to export the blocklist");
    }
  },

  billing: route("Unable to load billing", (req) => billing.summary(req.workspace)),
};
