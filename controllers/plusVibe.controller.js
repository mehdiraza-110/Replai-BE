const plusVibeService = require("../services/plusVibe.service");
const messageService = require("../services/message.service");
const eventLogService = require("../services/eventLog.service");

// Public origin of this API (behind a proxy, trust X-Forwarded-* headers; APP_BASE_URL wins when set).
function baseUrlOf(req) {
  if (process.env.APP_BASE_URL) return String(process.env.APP_BASE_URL).replace(/\/+$/, "");
  const proto = String(req.get("x-forwarded-proto") || req.protocol).split(",")[0].trim();
  return `${proto}://${req.get("x-forwarded-host") || req.get("host")}`;
}

function canManageWebhook(req) {
  return req.user?.isSuperAdmin === true || ["owner", "admin"].includes(req.workspace?.role);
}

// The webhook secret is only for owners/admins; plain members get the URL without ?token=.
function scrubSecret(req, data) {
  if (canManageWebhook(req) || !data || typeof data.webhookUrl !== "string") return data;
  return { ...data, webhookUrl: data.webhookUrl.replace(/([?&])token=[^&]*&?/, "$1").replace(/[?&]$/, "") };
}

async function getConnection(req, res) {
  try {
    const data = await plusVibeService.getConnection(req.workspaceId, { baseUrl: baseUrlOf(req) });

    res.status(200).json({
      success: true,
      message: "PlusVibe connection fetched successfully",
      data: scrubSecret(req, data),
    });
  } catch (error) {
    sendError(res, error, "Unable to fetch PlusVibe connection");
  }
}

async function saveConnection(req, res) {
  try {
    const data = await plusVibeService.saveConnection(req.workspaceId, {
      ...req.body,
      createdBy: req.user?.id ?? null,
      baseUrl: baseUrlOf(req),
    });

    res.status(200).json({
      success: true,
      message: "PlusVibe connection saved successfully",
      data: scrubSecret(req, data),
    });
  } catch (error) {
    sendError(res, error, "Unable to save PlusVibe connection");
  }
}

async function testConnection(req, res) {
  try {
    const data = await plusVibeService.testConnection(req.workspaceId, req.body);

    res.status(200).json({
      success: true,
      message: "PlusVibe connection tested successfully",
      data: scrubSecret(req, data),
    });
  } catch (error) {
    sendError(res, error, "Unable to test PlusVibe connection");
  }
}

async function refreshConnection(req, res) {
  try {
    const data = await plusVibeService.refreshConnection(req.workspaceId);

    res.status(200).json({
      success: true,
      message: "PlusVibe connection refreshed successfully",
      data: scrubSecret(req, data),
    });
  } catch (error) {
    sendError(res, error, "Unable to refresh PlusVibe connection");
  }
}

async function listInboxes(req, res) {
  try {
    const data = await plusVibeService.listInboxes(req.workspaceId);

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
    const data = await plusVibeService.listCampaigns(req.workspaceId);

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
    const data = await plusVibeService.syncCampaigns(req.workspaceId);

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
    const data = await plusVibeService.assignCampaignAgent(req.workspaceId, req.params.id, req.body.aiAgentId);

    res.status(200).json({
      success: true,
      message: "Campaign AI agent assignment saved successfully",
      data,
    });
  } catch (error) {
    sendError(res, error, "Unable to assign AI agent to campaign");
  }
}

async function rotateWebhookSecret(req, res) {
  if (!canManageWebhook(req)) {
    return res.status(403).json({ success: false, message: "Only workspace owners and admins can rotate the webhook secret.", data: null });
  }
  try {
    const data = await plusVibeService.rotateWebhookSecret(req.workspaceId, { baseUrl: baseUrlOf(req), userId: req.user?.id });
    res.status(200).json({ success: true, message: "Webhook secret rotated. Update the webhook URL in PlusVibe.", data });
  } catch (error) {
    sendError(res, error, "Unable to rotate the webhook secret");
  }
}

async function enforceWebhookSecret(req, res) {
  if (!canManageWebhook(req)) {
    return res.status(403).json({ success: false, message: "Only workspace owners and admins can change webhook protection.", data: null });
  }
  if (typeof req.body?.enforced !== "boolean") {
    return res.status(400).json({ success: false, message: "Send { enforced: true } or { enforced: false }.", data: null });
  }
  try {
    const data = await plusVibeService.setWebhookSecretEnforced(req.workspaceId, req.body.enforced, { baseUrl: baseUrlOf(req), userId: req.user?.id });
    res.status(200).json({
      success: true,
      message: req.body.enforced ? "Webhook token is now required." : "Webhook token is no longer required.",
      data,
    });
  } catch (error) {
    sendError(res, error, "Unable to change webhook protection");
  }
}

async function receiveWebhook(req, res) {
  try {
    // No session on the webhook: the tenant comes from the integration matched by the payload's PlusVibe
    // workspace id. Unmatched payloads throw here, before anything is written or any draft job is queued.
    const { appWorkspaceId, ...data } = await plusVibeService.recordWebhook(req.body, req.query?.token);
    // An active "PlusVibe reply" workflow handles the reply; otherwise (or if it fails before doing anything)
    // the built-in draft generation runs exactly as before.
    require("../services/workflowExecutor.service")
      .maybeRun({ workspaceId: appWorkspaceId, triggerType: "trigger.plusvibe_reply", event: { payload: req.body, webhookEventId: data.id } })
      .then((wf) => (wf.handled ? null : messageService.generateDraftFromWebhook(appWorkspaceId, req.body)))
      .catch(async (error) => {
      await eventLogService.record({
        eventType: "ai.draft.webhook_failed",
        source: "webhook",
        status: "Failed",
        appWorkspaceId,
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
  rotateWebhookSecret,
  enforceWebhookSecret,
};
