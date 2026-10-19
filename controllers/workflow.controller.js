const workflowService = require("../services/workflow.service");

function sendError(res, error, fallback) {
  if (error instanceof workflowService.WorkflowError) {
    return res.status(error.status).json({
      success: false,
      message: error.message,
      data: error.problems ? { problems: error.problems } : null,
    });
  }
  console.error(fallback, error);
  res.status(500).json({ success: false, message: fallback });
}

// Reads are open to every member; writes need owner/admin (a super admin acting in the workspace counts too).
function requireWriter(req, res) {
  if (req.user?.isSuperAdmin || ["owner", "admin"].includes(req.workspace?.role)) return true;
  res.status(403).json({ success: false, message: "Only workspace owners and admins can change workflows." });
  return false;
}

function parseId(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(404).json({ success: false, message: "Workflow not found." });
    return null;
  }
  return id;
}

async function list(req, res) {
  try {
    res.json({ success: true, message: "Workflows fetched successfully", data: await workflowService.list(req.workspaceId) });
  } catch (error) {
    sendError(res, error, "We could not load your workflows. Please try again.");
  }
}

async function meta(req, res) {
  try {
    res.json({ success: true, message: "Workflow options fetched successfully", data: await workflowService.meta(req.workspaceId) });
  } catch (error) {
    sendError(res, error, "We could not load the workflow options. Please try again.");
  }
}

async function create(req, res) {
  if (!requireWriter(req, res)) return;
  try {
    const data = await workflowService.create(req.workspaceId, req.user?.id, req.body || {});
    res.status(201).json({ success: true, message: "Workflow created", data });
  } catch (error) {
    sendError(res, error, "We could not create the workflow. Please try again.");
  }
}

async function get(req, res) {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    res.json({ success: true, message: "Workflow fetched successfully", data: await workflowService.get(req.workspaceId, id) });
  } catch (error) {
    sendError(res, error, "We could not load the workflow. Please try again.");
  }
}

async function update(req, res) {
  if (!requireWriter(req, res)) return;
  const id = parseId(req, res);
  if (id === null) return;
  try {
    const draft = req.query.draft === "true" || req.query.draft === "1";
    const data = await workflowService.update(req.workspaceId, id, req.body || {}, { draft });
    res.json({ success: true, message: "Workflow saved", data });
  } catch (error) {
    sendError(res, error, "We could not save the workflow. Please try again.");
  }
}

async function remove(req, res) {
  if (!requireWriter(req, res)) return;
  const id = parseId(req, res);
  if (id === null) return;
  try {
    await workflowService.remove(req.workspaceId, id);
    res.json({ success: true, message: "Workflow deleted", data: null });
  } catch (error) {
    sendError(res, error, "We could not delete the workflow. Please try again.");
  }
}

async function test(req, res) {
  if (!requireWriter(req, res)) return;
  const id = parseId(req, res);
  if (id === null) return;
  try {
    const data = await workflowService.test(req.workspaceId, id, req.body?.sample);
    res.json({ success: true, message: "Test run finished (nothing was sent or saved)", data });
  } catch (error) {
    sendError(res, error, "We could not run the test. Please try again.");
  }
}

async function runs(req, res) {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    res.json({ success: true, message: "Runs fetched successfully", data: await workflowService.listRuns(req.workspaceId, id, req.query.limit) });
  } catch (error) {
    sendError(res, error, "We could not load the runs. Please try again.");
  }
}

module.exports = { list, meta, create, get, update, remove, test, runs };
