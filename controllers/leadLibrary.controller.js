const leadLibraryService = require("../services/leadLibrary.service");

const ALLOWED_FILE_EXTENSIONS = new Set(["csv", "xlsx", "xls", "txt"]);

function handler(fallbackMessage, successMessage, run) {
  return async (req, res) => {
    try {
      const data = await run(req, res);
      if (data !== undefined) res.status(200).json({ success: true, message: successMessage, data });
    } catch (error) {
      if (res.headersSent) return res.end();
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.statusCode ? error.message : fallbackMessage,
        code: error.code || "LEAD_LIBRARY_REQUEST_FAILED",
        data: null,
      });
      if (!error.statusCode) console.error(`[lead-library] ${fallbackMessage}:`, error);
    }
  };
}

function canManageLists(req) {
  return req.user?.isSuperAdmin === true || ["owner", "admin"].includes(req.workspace?.role);
}

const ctx = (req) => ({ workspaceId: req.workspaceId, userId: req.user?.id ?? null });

module.exports = {
  getStats: handler("Unable to load lead stats", "Lead stats fetched", (req) => leadLibraryService.getStats(req.workspaceId)),

  listLists: handler("Unable to load lead lists", "Lead lists fetched", (req) =>
    leadLibraryService.listLists({ ...req.query, workspaceId: req.workspaceId })),

  createList: handler("Unable to create the list", "List created", (req) =>
    leadLibraryService.createList({ name: req.body?.name, description: req.body?.description, ...ctx(req) })),

  updateList: handler("Unable to update the list", "List updated", (req) =>
    leadLibraryService.updateList(req.params.id, { name: req.body?.name, description: req.body?.description, workspaceId: req.workspaceId })),

  deleteList: handler("Unable to delete the list", "List deleted", (req) => {
    if (!canManageLists(req)) {
      throw Object.assign(new Error("Only workspace owners and admins can delete lead lists."), { statusCode: 403, code: "LEAD_LIST_FORBIDDEN" });
    }
    return leadLibraryService.deleteList(req.params.id, { workspaceId: req.workspaceId });
  }),

  listContacts: handler("Unable to load leads", "Leads fetched", (req) =>
    leadLibraryService.listContacts({ ...req.query, workspaceId: req.workspaceId })),

  getContact: handler("Unable to load the lead", "Lead fetched", (req) =>
    leadLibraryService.getContact(req.params.id, { workspaceId: req.workspaceId })),

  addContacts: handler("Unable to add leads", "Leads added", (req) =>
    leadLibraryService.addContacts({ listId: req.body?.listId, contacts: req.body?.contacts, emails: req.body?.emails, ...ctx(req) })),

  importFile: handler("Unable to import that file", "Lead file imported", (req) => {
    if (!req.file) {
      throw Object.assign(new Error("Attach a CSV, XLSX, XLS, or TXT file under the 'file' field."), { statusCode: 400, code: "LEAD_FILE_REQUIRED" });
    }
    const extension = String(req.file.originalname || "").toLowerCase().split(".").pop();
    if (!ALLOWED_FILE_EXTENSIONS.has(extension)) {
      throw Object.assign(new Error("Unsupported file type. Upload a .csv, .xlsx, .xls, or .txt file."), { statusCode: 400, code: "LEAD_FILE_TYPE_UNSUPPORTED" });
    }
    return leadLibraryService.importFile({
      buffer: req.file.buffer,
      fileName: req.file.originalname,
      listId: req.body?.listId || null,
      newListName: req.body?.newListName,
      ...ctx(req),
    });
  }),

  updateContact: handler("Unable to update the lead", "Lead updated", (req) =>
    leadLibraryService.updateContact(req.params.id, req.body || {}, { workspaceId: req.workspaceId })),

  deleteContacts: handler("Unable to delete leads", "Leads deleted", (req) =>
    leadLibraryService.deleteContacts(req.body?.selection, { workspaceId: req.workspaceId })),

  moveContacts: handler("Unable to move leads", "Leads updated", (req) =>
    leadLibraryService.moveContacts(req.body?.selection, {
      targetListId: req.body?.targetListId,
      mode: req.body?.mode === "move" ? "move" : "copy",
      workspaceId: req.workspaceId,
    })),

  summarizeSelection: handler("Unable to count leads", "Selection counted", (req) =>
    leadLibraryService.summarizeSelection({ listIds: req.body?.listIds, contacts: req.body?.contacts, workspaceId: req.workspaceId })),

  exportContacts: handler("Unable to export leads", "Leads exported", async (req, res) => {
    res.status(200);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`);
    await leadLibraryService.streamCsv({ ...req.query, workspaceId: req.workspaceId }, res);
    res.end();
  }),
};
