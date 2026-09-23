const suppressionService = require("../services/suppression.service");

async function listSuppressions(req, res) {
  try {
    const data = await suppressionService.listSuppressions({
      page: req.query.page,
      limit: req.query.limit,
      search: req.query.search,
    });
    res.status(200).json({ success: true, message: "Suppressions fetched successfully", data });
  } catch (error) {
    sendError(res, error, "Unable to fetch suppressions");
  }
}

async function createManualSuppression(req, res) {
  try {
    const email = req.body?.email;
    if (!email || !String(email).trim()) {
      return res.status(400).json({ success: false, message: "email is required", code: "EMAIL_REQUIRED", data: null });
    }
    const data = await suppressionService.addSuppression({ email, reason: "manual", source: "manual" });
    res.status(200).json({ success: true, message: "Address suppressed", data });
  } catch (error) {
    sendError(res, error, "Unable to add suppression");
  }
}

function sendError(res, error, fallbackMessage) {
  const status = error.statusCode || 500;
  res.status(status).json({ success: false, message: error.message || fallbackMessage, code: error.code, data: null });
}

module.exports = { listSuppressions, createManualSuppression };
