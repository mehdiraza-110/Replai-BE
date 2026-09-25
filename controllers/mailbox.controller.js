const mailboxService = require("../services/mailbox.service");

async function listMailboxes(req, res) {
  try {
    const data = await mailboxService.listMailboxes({
      page: req.query.page,
      limit: req.query.limit,
      search: req.query.search,
      domainId: req.query.domainId,
    });
    res.status(200).json({ success: true, message: "Mailboxes fetched successfully", data });
  } catch (error) {
    sendError(res, error, "Unable to fetch mailboxes");
  }
}

async function createMailboxes(req, res) {
  try {
    const data = await mailboxService.createMailboxes({
      ...req.body,
      createdBy: req.user?.id ?? null,
    });
    res.status(200).json({ success: true, message: "Mailbox creation started", data });
  } catch (error) {
    sendError(res, error, "Unable to create mailboxes");
  }
}

async function refreshMailbox(req, res) {
  try {
    const data = await mailboxService.refreshMailbox(req.params.id);
    res.status(200).json({ success: true, message: "Mailbox status refreshed", data });
  } catch (error) {
    sendError(res, error, "Unable to refresh mailbox status");
  }
}

async function refreshAllMailboxes(req, res) {
  try {
    const data = await mailboxService.refreshAllMailboxes();
    res.status(200).json({ success: true, message: "Mailbox statuses refreshed", data });
  } catch (error) {
    sendError(res, error, "Unable to refresh mailbox statuses");
  }
}

async function deleteMailbox(req, res) {
  try {
    const data = await mailboxService.deleteMailbox(req.params.id);
    res.status(200).json({ success: true, message: "Mailbox deleted successfully", data });
  } catch (error) {
    sendError(res, error, "Unable to delete mailbox");
  }
}

async function listMailboxMessages(req, res) {
  try {
    const data = await mailboxService.listMailboxMessages(req.params.id, {
      page: req.query.page,
      limit: req.query.limit,
    });
    res.status(200).json({ success: true, message: "Messages fetched successfully", data });
  } catch (error) {
    sendError(res, error, "Unable to fetch messages");
  }
}

function sendError(res, error, fallbackMessage) {
  res.status(error.statusCode || 500).json({
    success: false,
    message: error.message || fallbackMessage,
    code: error.code || "MAILBOX_REQUEST_FAILED",
    data: null,
  });
}

module.exports = {
  listMailboxes,
  createMailboxes,
  refreshMailbox,
  refreshAllMailboxes,
  deleteMailbox,
  listMailboxMessages,
};
