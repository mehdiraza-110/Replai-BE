const crm = require("../services/crm.service");
const dashboard = require("../services/dashboard.service");

function sendError(res, error, fallback) {
  const status = error.statusCode || 500;
  if (status >= 500) console.error(fallback, error);
  res.status(status).json({ success: false, message: status >= 500 ? fallback : error.message, code: error.code && !/^\d+$/.test(String(error.code)) ? error.code : "CRM_FAILED", data: null });
}

const route = (message, handler) => async (req, res) => {
  try {
    res.status(200).json({ success: true, message, data: await handler(req) });
  } catch (error) {
    sendError(res, error, message);
  }
};

const ws = (req) => req.workspaceId;

module.exports = {
  listTasks: route("Unable to load tasks", (req) => crm.listTasks(ws(req), { ...req.query, userId: req.user.id })),
  createTask: route("Unable to create the task", (req) => crm.createTask(ws(req), req.user.id, req.body || {})),
  updateTask: route("Unable to update the task", (req) => crm.updateTask(ws(req), req.params.id, req.body || {})),
  deleteTask: route("Unable to delete the task", (req) => crm.deleteTask(ws(req), req.params.id)),
  listCompanies: route("Unable to load companies", (req) => crm.listCompanies(ws(req), req.query)),
  createCompany: route("Unable to create the company", (req) => crm.createCompany(ws(req), req.user.id, req.body || {})),
  updateCompany: route("Unable to update the company", (req) => crm.updateCompany(ws(req), req.params.id, req.body || {})),
  deleteCompany: route("Unable to delete the company", (req) => crm.deleteCompany(ws(req), req.params.id)),
  listDeals: route("Unable to load deals", (req) => crm.listDeals(ws(req), req.query)),
  createDeal: route("Unable to create the deal", (req) => crm.createDeal(ws(req), req.user.id, req.body || {})),
  updateDeal: route("Unable to update the deal", (req) => crm.updateDeal(ws(req), req.params.id, req.body || {})),
  deleteDeal: route("Unable to delete the deal", (req) => crm.deleteDeal(ws(req), req.params.id)),
  listNotes: route("Unable to load notes", (req) => crm.listNotes(ws(req), req.query)),
  createNote: route("Unable to save the note", (req) => crm.createNote(ws(req), req.user.id, req.body || {})),
  deleteNote: route("Unable to delete the note", (req) => crm.deleteNote(ws(req), req.params.id)),
  listPeople: route("Unable to load people", (req) => crm.listPeople(ws(req), req.query)),
  listAppointments: route("Unable to load appointments", (req) => crm.listAppointments(ws(req), req.query)),
  updateAppointment: route("Unable to update the appointment", (req) => crm.updateAppointment(ws(req), req.params.id, req.body || {})),
  listScheduled: route("Unable to load scheduled messages", (req) => crm.listScheduled(ws(req), req.query)),
  listSubmissions: route("Unable to load lead submissions", (req) => crm.listSubmissions(ws(req), req.query)),
  listMembers: route("Unable to load members", (req) => crm.listMembers(ws(req))),

  dashboardCatalog: route("Unable to load widgets", () => ({ widgets: dashboard.CATALOG, ranges: dashboard.RANGES })),
  dashboardData: route("Unable to load the dashboard", (req) => dashboard.data(ws(req), req.query)),
  listViews: route("Unable to load views", (req) => dashboard.listViews(ws(req), req.user.id)),
  createView: route("Unable to create the view", (req) => dashboard.createView(ws(req), req.user.id, req.body || {})),
  updateView: route("Unable to update the view", (req) => dashboard.updateView(ws(req), req.params.id, req.body || {})),
  deleteView: route("Unable to delete the view", (req) => dashboard.deleteView(ws(req), req.params.id)),
};
