const ghlService = require("../services/ghl.service");

async function getConnection(req, res) {
  try {
    const data = await ghlService.getConnection();

    res.status(200).json({
      success: true,
      message: "GHL connection fetched successfully",
      data,
    });
  } catch (error) {
    sendError(res, error, "Unable to fetch GHL connection");
  }
}

async function saveConnection(req, res) {
  try {
    const data = await ghlService.saveConnection({
      ...req.body,
      createdBy: req.user?.id ?? null,
    });

    res.status(200).json({
      success: true,
      message: "GHL connection saved successfully",
      data,
    });
  } catch (error) {
    sendError(res, error, "Unable to save GHL connection");
  }
}

async function testConnection(req, res) {
  try {
    const data = await ghlService.testConnection(req.body);

    res.status(200).json({
      success: true,
      message: "GHL connection tested successfully",
      data,
    });
  } catch (error) {
    sendError(res, error, "Unable to test GHL connection");
  }
}

function sendError(res, error, fallbackMessage) {
  res.status(error.statusCode || 500).json({
    success: false,
    message: error.message || fallbackMessage,
    code: error.code || "GHL_REQUEST_FAILED",
    data: null,
  });
}

module.exports = {
  getConnection,
  saveConnection,
  testConnection,
};
