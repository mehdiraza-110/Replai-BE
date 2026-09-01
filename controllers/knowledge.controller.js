const knowledgeService = require("../services/knowledge.service");

async function listKnowledgeSources(req, res) {
  try {
    const data = await knowledgeService.list(req.query);

    res.status(200).json({
      success: true,
      message: "Knowledge sources fetched successfully",
      data,
    });
  } catch (error) {
    sendError(res, error, "Unable to fetch knowledge sources");
  }
}

async function createKnowledgeSource(req, res) {
  try {
    const data = await knowledgeService.create(req.body, req.file, req.user?.id || null);

    res.status(201).json({
      success: true,
      message: "Knowledge source created successfully",
      data,
    });
  } catch (error) {
    sendError(res, error, "Unable to create knowledge source");
  }
}

async function deleteKnowledgeSource(req, res) {
  try {
    const data = await knowledgeService.delete(Number(req.params.id));

    res.status(200).json({
      success: true,
      message: "Knowledge source deleted successfully",
      data,
    });
  } catch (error) {
    sendError(res, error, "Unable to delete knowledge source");
  }
}

function sendError(res, error, fallbackMessage) {
  res.status(error.statusCode || 500).json({
    success: false,
    message: error.message || fallbackMessage,
  });
}

module.exports = {
  listKnowledgeSources,
  createKnowledgeSource,
  deleteKnowledgeSource,
};
