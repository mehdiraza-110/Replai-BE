const plusVibeService = require("../services/plusVibe.service");
const messageService = require("../services/message.service");
const eventLogService = require("../services/eventLog.service");

async function getConnection(req, res) {
  try {
    const data = await plusVibeService.getConnection();

    res.status(200).json({
      success: true,
      message: "PlusVibe connection fetched successfully",
      data,
    });
  } catch (error) {
    sendError(res, error, "Unable to fetch PlusVibe connection");
  }
}

async function saveConnection(req, res) {
  try {
    const data = await plusVibeService.saveConnection({
      ...req.body,
      createdBy: req.user?.id ?? null,
    });

    res.status(200).json({
      success: true,
      message: "PlusVibe connection saved successfully",
      data,
    });
  } catch (error) {
    sendError(res, error, "Unable to save PlusVibe connection");
  }
}

async function testConnection(req, res) {
  try {
    const data = await plusVibeService.testConnection(req.body);

    res.status(200).json({
      success: true,
      message: "PlusVibe connection tested successfully",
      data,
    });
  } catch (error) {
    sendError(res, error, "Unable to test PlusVibe connection");
  }
}

async function refreshConnection(req, res) {
  try {
    const data = await plusVibeService.refreshConnection();

    res.status(200).json({
      success: true,
      message: "PlusVibe connection refreshed successfully",
      data,
    });
  } catch (error) {
    sendError(res, error, "Unable to refresh PlusVibe connection");
  }
}

async function listInboxes(req, res) {
  try {
    const data = await plusVibeService.listInboxes();

    res.status(200).json({
      success: true,
      message: "PlusVibe inboxes fetched successfully",
      data,
      count: data.length,
    });
  } catch (error) {
    sendError(res, error, "Unable to fetch PlusVibe inboxes");
  }
}

async function listCampaigns(req, res) {
  try {
    const data = await plusVibeService.listCampaigns();

    res.status(200).json({
      success: true,
      message: "PlusVibe campaigns fetched successfully",
      data,
      count: data.length,
    });
  } catch (error) {
    sendError(res, error, "Unable to fetch PlusVibe campaigns");
  }
}

async function syncCampaigns(req, res) {
  try {
    const data = await plusVibeService.syncCampaigns();

    res.status(200).json({
      success: true,
      message: "PlusVibe campaigns synced successfully",
      data,
      count: data.length,
    });
  } catch (error) {
    sendError(res, error, "Unable to sync PlusVibe campaigns");
  }
}

async function assignCampaignAgent(req, res) {
  try {
    const data = await plusVibeService.assignCampaignAgent(req.params.id, req.body.aiAgentId);

    res.status(200).json({
      success: true,
      message: "Campaign AI agent assignment saved successfully",
      data,
    });
  } catch (error) {
    sendError(res, error, "Unable to assign AI agent to campaign");
  }
}

async function receiveWebhook(req, res) {
  try {
    const data = await plusVibeService.recordWebhook(req.body);
    messageService.generateDraftFromWebhook(req.body).catch(async (error) => {
      await eventLogService.record({
        eventType: "ai.draft.webhook_failed",
        source: "webhook",
        status: "Failed",
        threadId: req.body?.thread_id || req.body?.threadId || req.body?.data?.thread_id || null,
        errorMessage: error.message,
        metadata: { webhookEventId: data.id },
      });
    });

    res.status(202).json({
      success: true,
      message: "PlusVibe webhook received",
      data: {
        ...data,
        draftJob: { status: "Queued" },
      },
    });
  } catch (error) {
    sendError(res, error, "Unable to receive PlusVibe webhook");
  }
}

function sendError(res, error, fallbackMessage) {
  res.status(error.statusCode || 500).json({
    success: false,
    message: error.message || fallbackMessage,
    code: error.code || "PLUSVIBE_REQUEST_FAILED",
    data: null,
  });
}

module.exports = {
  getConnection,
  saveConnection,
  testConnection,
  refreshConnection,
  listInboxes,
  listCampaigns,
  syncCampaigns,
  assignCampaignAgent,
  receiveWebhook,
};
