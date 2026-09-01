const aiAgentService = require("../services/aiAgent.service");

async function listAgents(req, res) {
  try {
    const agents = await aiAgentService.listAgents();

    res.status(200).json({
      success: true,
      message: "AI agents fetched successfully",
      data: agents,
      count: agents.length,
    });
  } catch (error) {
    sendError(res, error, "Unable to fetch AI agents");
  }
}

async function getAgent(req, res) {
  try {
    const agent = await aiAgentService.getAgentById(req.params.id);

    if (!agent) {
      return res.status(404).json({
        success: false,
        message: "AI agent not found",
        data: null,
      });
    }

    res.status(200).json({
      success: true,
      message: "AI agent fetched successfully",
      data: agent,
    });
  } catch (error) {
    sendError(res, error, "Unable to fetch AI agent");
  }
}

async function createAgent(req, res) {
  try {
    const agent = await aiAgentService.createAgent({
      ...req.body,
      createdBy: req.user?.id ?? req.body.createdBy ?? null,
    });

    res.status(201).json({
      success: true,
      message: "AI agent created successfully",
      data: agent,
    });
  } catch (error) {
    sendError(res, error, "Unable to create AI agent");
  }
}

async function updateAgent(req, res) {
  try {
    const agent = await aiAgentService.updateAgent(req.params.id, req.body);

    res.status(200).json({
      success: true,
      message: "AI agent updated successfully",
      data: agent,
    });
  } catch (error) {
    sendError(res, error, "Unable to update AI agent");
  }
}

async function deleteAgent(req, res) {
  try {
    const deleted = await aiAgentService.deleteAgent(req.params.id);

    res.status(200).json({
      success: true,
      message: "AI agent deleted successfully",
      data: deleted,
    });
  } catch (error) {
    sendError(res, error, "Unable to delete AI agent");
  }
}

function sendError(res, error, fallbackMessage) {
  res.status(error.statusCode || 500).json({
    success: false,
    message: error.message || fallbackMessage,
    code: error.code || "AI_AGENT_REQUEST_FAILED",
    data: null,
  });
}

module.exports = {
  listAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent,
};
