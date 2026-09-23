const sesInboundEmailService = require("../services/sesInboundEmail.service");

// Public — SNS posts here directly with no session/auth. Express is configured
// (see routes/v1/ses-inbound.routes.js) to parse this route's body as raw text,
// since SNS sends application/json content typed as text/plain.
async function receiveNotification(req, res) {
  try {
    const result = await sesInboundEmailService.handleSnsMessage(req.body);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    const status = error.statusCode || 500;
    res.status(status).json({ success: false, message: error.message || "Unable to process notification" });
  }
}

module.exports = { receiveNotification };
