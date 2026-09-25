const inboxService = require("../services/inbox.service");

async function listThreads(req, res) {
  try {
    const data = await inboxService.listThreads({
      page: req.query.page,
      limit: req.query.limit,
      search: req.query.search,
      mailboxId: req.query.mailboxId,
      unreadOnly: req.query.unreadOnly === "true",
    });
    res.status(200).json({ success: true, message: "Threads fetched successfully", data });
  } catch (error) {
    sendError(res, error, "Unable to fetch threads");
  }
}

async function getThread(req, res) {
  try {
    const data = await inboxService.getThread(req.params.mailboxId, req.params.threadId);
    res.status(200).json({ success: true, message: "Thread fetched successfully", data });
  } catch (error) {
    sendError(res, error, "Unable to fetch thread");
  }
}

async function markThreadRead(req, res) {
  try {
    const data = await inboxService.markThreadRead(req.params.mailboxId, req.params.threadId);
    res.status(200).json({ success: true, message: "Thread marked as read", data });
  } catch (error) {
    sendError(res, error, "Unable to mark thread as read");
  }
}

async function sendReply(req, res) {
  try {
    const data = await inboxService.sendReply(req.params.mailboxId, req.params.threadId, { body: req.body?.body });
    res.status(200).json({ success: true, message: "Reply sent", data });
  } catch (error) {
    sendError(res, error, "Unable to send reply");
  }
}

function sendError(res, error, fallbackMessage) {
  res.status(error.statusCode || 500).json({
    success: false,
    message: error.message || fallbackMessage,
    code: error.code || "INBOX_REQUEST_FAILED",
    data: null,
  });
}

module.exports = { listThreads, getThread, markThreadRead, sendReply };
