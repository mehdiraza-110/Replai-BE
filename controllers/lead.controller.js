const leadService = require("../services/lead.service");

async function listPositiveLeads(req, res) {
  try {
    const data = await leadService.listPositiveLeads(req.query);

    res.status(200).json({
      success: true,
      message: "Positive leads fetched successfully",
      data,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Unable to fetch leads",
    });
  }
}

module.exports = {
  listPositiveLeads,
};
