const messageService = require("../services/message.service");

async function listConversations(req, res) {
  try {
    const data = await messageService.listConversations(req.workspaceId, req.query);

    res.status(200).json({
      success: true,
      message: "Conversations fetched successfully",
      data,
    });
  } catch (error) {
    sendError(res, error, "Unable to fetch conversations");
  }
}

async function getConversation(req, res) {
  try {
    const data = await messageService.getConversation(req.workspaceId, req.params.threadId);

    res.status(200).json({
      success: true,
      message: "Conversation fetched successfully",
      data,
    });
  } catch (error) {
    sendError(res, error, "Unable to fetch conversation");
  }
}

async function sendManualReply(req, res) {
  try {
    const data = await messageService.sendManualReply(req.workspaceId, req.params.threadId, req.body);

    res.status(200).json({
      success: true,
      message: "Reply sent successfully",
      data,
    });
  } catch (error) {
    sendError(res, error, "Unable to send reply");
  }
}

async function generateDraft(req, res) {
  try {
    const data = await messageService.generateDraft(req.workspaceId, req.params.threadId, req.body);

    res.status(200).json({
      success: true,
      message: "AI draft generated successfully",
      data,
    });
  } catch (error) {
    sendError(res, error, "Unable to generate AI draft");
  }
}

async function approveDraft(req, res) {
  try {
    const data = await messageService.approveDraft(req.workspaceId, req.params.draftId, req.body);

    res.status(200).json({
      success: true,
      message: "AI draft approved and sent successfully",
      data,
    });
  } catch (error) {
    sendError(res, error, "Unable to approve AI draft");
  }
}

async function rejectDraft(req, res) {
  try {
    const data = await messageService.rejectDraft(req.workspaceId, req.params.draftId);

    res.status(200).json({
      success: true,
      message: "AI draft rejected successfully",
      data,
    });
  } catch (error) {
    sendError(res, error, "Unable to reject AI draft");
  }
}

function sendError(res, error, fallbackMessage) {
  res.status(error.statusCode || 500).json({
    success: false,
    message: error.message || fallbackMessage,
  });
}

module.exports = {
  listConversations,
  getConversation,
  sendManualReply,
  generateDraft,
  approveDraft,
  rejectDraft,
};
