const quotaService = require("../services/quota.service");
const warmupService = require("../services/warmup.service");

async function listStrategies(req, res) {
  try {
    const data = await warmupService.listStrategies(req.workspaceId);
    res.status(200).json({ success: true, message: "Warmup strategies fetched successfully", data });
  } catch (error) {
    sendError(res, error, "Unable to fetch warmup strategies");
  }
}

async function getSummary(req, res) {
  try {
    const data = await warmupService.getSummary(req.workspaceId);
    res.status(200).json({ success: true, message: "Warmup summary fetched successfully", data });
  } catch (error) {
    sendError(res, error, "Unable to fetch warmup summary");
  }
}

async function createStrategy(req, res) {
  try {
    const { applyTo, ...strategyPayload } = req.body;
    const strategy = await warmupService.createStrategy({ ...strategyPayload, createdBy: req.user?.id ?? null, workspaceId: req.workspaceId });
    const assignment = applyTo ? await warmupService.assignStrategy(strategy.id, applyTo, req.workspaceId) : null;
    res.status(200).json({ success: true, message: "Warmup strategy created", data: { strategy, assignedCount: assignment?.assignedCount ?? 0 } });
  } catch (error) {
    sendError(res, error, "Unable to create warmup strategy");
  }
}

async function assignStrategy(req, res) {
  try {
    const data = await warmupService.assignStrategy(req.params.id, req.body, req.workspaceId);
    res.status(200).json({ success: true, message: "Warmup strategy assigned", data });
  } catch (error) {
    sendError(res, error, "Unable to assign warmup strategy");
  }
}

async function generateAiSchedule(req, res) {
  try {
    const data = await warmupService.generateAiSchedule({ ...req.body, workspaceId: req.workspaceId });
    res.status(200).json({ success: true, message: "AI ramp schedule generated", data });
  } catch (error) {
    sendError(res, error, "Unable to generate AI ramp schedule");
  }
}

async function runTick(req, res) {
  try {
    const data = await warmupService.runTick(req.workspaceId);
    res.status(200).json({ success: true, message: "Warmup engine tick complete", data });
  } catch (error) {
    sendError(res, error, "Unable to run warmup engine tick");
  }
}

function sendError(res, error, fallbackMessage) {
  if (quotaService.isQuotaError(error)) return res.status(403).json(quotaService.errorBody(error));
  res.status(error.statusCode || 500).json({
    success: false,
    message: error.message || fallbackMessage,
    code: error.code || "WARMUP_REQUEST_FAILED",
    data: null,
  });
}

module.exports = {
  listStrategies,
  getSummary,
  createStrategy,
  assignStrategy,
  generateAiSchedule,
  runTick,
};
