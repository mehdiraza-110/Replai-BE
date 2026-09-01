const eventLogService = require("../services/eventLog.service");

async function listEventLogs(req, res) {
  try {
    const data = await eventLogService.list(req.query);

    res.status(200).json({
      success: true,
      message: "Event logs fetched successfully",
      data,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Unable to fetch event logs",
    });
  }
}

module.exports = {
  listEventLogs,
};
