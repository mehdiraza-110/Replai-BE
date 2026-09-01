const analyticsService = require("../services/analytics.service");

async function getOverview(req, res) {
  try {
    const data = await analyticsService.getOverview(req.query);

    res.status(200).json({
      success: true,
      message: "Analytics fetched successfully",
      data,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Unable to fetch analytics",
    });
  }
}

module.exports = {
  getOverview,
};
