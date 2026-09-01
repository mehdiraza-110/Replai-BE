const notificationService = require("../services/notification.service");

async function listNotifications(req, res) {
  try {
    const data = await notificationService.list(req.query);

    res.status(200).json({
      success: true,
      message: "Notifications fetched successfully",
      data,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Unable to fetch notifications",
    });
  }
}

module.exports = {
  listNotifications,
};
