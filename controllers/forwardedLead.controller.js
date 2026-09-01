const forwardedLeadService = require("../services/forwardedLead.service");

async function listForwardedLeads(req, res) {
  try {
    const data = await forwardedLeadService.list(req.query);

    res.status(200).json({
      success: true,
      message: "Forwarded leads fetched successfully",
      data,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Unable to fetch forwarded leads",
    });
  }
}

module.exports = {
  listForwardedLeads,
};
