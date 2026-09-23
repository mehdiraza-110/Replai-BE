const sesBounceComplaintService = require("../services/sesBounceComplaint.service");

// Public — SNS posts here directly with no session/auth, same as ses-inbound.
async function receiveNotification(req, res) {
  try {
    const result = await sesBounceComplaintService.handleSnsMessage(req.body);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    const status = error.statusCode || 500;
    res.status(status).json({ success: false, message: error.message || "Unable to process notification" });
  }
}

module.exports = { receiveNotification };
