const aiModelService = require("../services/aiModel.service");

async function getModels(req, res) {
  try {
    const data = await aiModelService.getModels(req.query.provider);

    res.status(200).json({
      success: true,
      message: "AI models fetched successfully",
      data,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Unable to fetch AI models",
      code: error.code || "AI_MODELS_FETCH_FAILED",
      data: null,
    });
  }
}

module.exports = {
  getModels,
};
