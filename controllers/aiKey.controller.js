const aiKeyService = require("../services/aiKey.service");

function sendError(res, error, fallbackMessage) {
  const status = error.statusCode || 500;
  if (status >= 500 && !error.statusCode) console.error("AI keys error:", error);
  res.status(status).json({
    success: false,
    message: error.statusCode ? error.message : fallbackMessage,
    code: error.code || "AI_KEYS_REQUEST_FAILED",
    data: null,
  });
}

function canManage(req) {
  return req.user?.isSuperAdmin === true || ["owner", "admin"].includes(req.workspace?.role);
}

function denyUnlessManager(req, res) {
  if (canManage(req)) return false;
  res.status(403).json({ success: false, message: "Only workspace owners and admins can manage AI keys.", data: null });
  return true;
}

async function list(req, res) {
  try {
    const data = await aiKeyService.listForWorkspace(req.workspaceId);
    res.status(200).json({ success: true, message: "AI keys fetched successfully", data });
  } catch (error) {
    sendError(res, error, "Unable to fetch AI keys");
  }
}

async function save(req, res) {
  if (denyUnlessManager(req, res)) return;
  try {
    const data = await aiKeyService.saveKey(req.workspaceId, req.params.provider, req.body?.apiKey, req.user?.id ?? null);
    res.status(200).json({ success: true, message: "AI key saved successfully", data });
  } catch (error) {
    sendError(res, error, "Unable to save the AI key");
  }
}

async function remove(req, res) {
  if (denyUnlessManager(req, res)) return;
  try {
    const data = await aiKeyService.deleteKey(req.workspaceId, req.params.provider);
    res.status(200).json({ success: true, message: "AI key removed successfully", data });
  } catch (error) {
    sendError(res, error, "Unable to remove the AI key");
  }
}

async function test(req, res) {
  if (denyUnlessManager(req, res)) return;
  try {
    const data = await aiKeyService.testKey(req.workspaceId, req.params.provider);
    res.status(200).json({ success: true, message: data.message, data });
  } catch (error) {
    sendError(res, error, "Unable to test the AI key");
  }
}

module.exports = { list, save, remove, test, canManage };
