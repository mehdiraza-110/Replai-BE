const reviewService = require("../services/review.service");

async function listReviews(req, res) {
  try {
    const data = await reviewService.list(req.query);

    res.status(200).json({
      success: true,
      message: "Human review queue fetched successfully",
      data,
    });
  } catch (error) {
    sendError(res, error, "Unable to fetch human review queue");
  }
}

async function countReviews(req, res) {
  try {
    const data = await reviewService.count();

    res.status(200).json({
      success: true,
      message: "Human review count fetched successfully",
      data,
    });
  } catch (error) {
    sendError(res, error, "Unable to fetch human review count");
  }
}

function sendError(res, error, fallbackMessage) {
  res.status(error.statusCode || 500).json({
    success: false,
    message: error.message || fallbackMessage,
  });
}

module.exports = {
  listReviews,
  countReviews,
};
