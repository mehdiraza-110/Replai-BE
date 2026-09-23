const campaignService = require("../services/campaign.service");

const ALLOWED_LEAD_FILE_EXTENSIONS = new Set(["csv", "xlsx", "xls", "txt"]);

async function listCampaigns(req, res) {
  try {
    const data = await campaignService.listCampaigns({
      page: req.query.page,
      limit: req.query.limit,
      search: req.query.search,
    });
    res.status(200).json({ success: true, message: "Campaigns fetched successfully", data });
  } catch (error) {
    sendError(res, error, "Unable to fetch campaigns");
  }
}

async function createCampaign(req, res) {
  try {
    const data = await campaignService.createCampaign({
      ...req.body,
      createdBy: req.user?.id ?? null,
    });
    res.status(200).json({ success: true, message: "Campaign created successfully", data });
  } catch (error) {
    sendError(res, error, "Unable to create campaign");
  }
}

async function parseLeadsFile(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Attach a CSV, XLSX, XLS, or TXT file under the 'file' field",
        code: "LEAD_FILE_REQUIRED",
        data: null,
      });
    }

    const extension = String(req.file.originalname || "").toLowerCase().split(".").pop();
    if (!ALLOWED_LEAD_FILE_EXTENSIONS.has(extension)) {
      return res.status(400).json({
        success: false,
        message: "Unsupported file type. Upload a .csv, .xlsx, .xls, or .txt file.",
        code: "LEAD_FILE_TYPE_UNSUPPORTED",
        data: null,
      });
    }

    const data = campaignService.parseLeadsFile(req.file.buffer, req.file.originalname);
    res.status(200).json({ success: true, message: "Lead file parsed successfully", data });
  } catch (error) {
    sendError(res, error, "Unable to parse lead file");
  }
}

async function listCampaignLeads(req, res) {
  try {
    const data = await campaignService.listCampaignLeads(req.params.id, {
      page: req.query.page,
      limit: req.query.limit,
      search: req.query.search,
    });
    res.status(200).json({ success: true, message: "Campaign leads fetched successfully", data });
  } catch (error) {
    sendError(res, error, "Unable to fetch campaign leads");
  }
}

function sendError(res, error, fallbackMessage) {
  res.status(error.statusCode || 500).json({
    success: false,
    message: error.message || fallbackMessage,
    code: error.code || "CAMPAIGN_REQUEST_FAILED",
    data: null,
  });
}

module.exports = {
  listCampaigns,
  createCampaign,
  parseLeadsFile,
  listCampaignLeads,
};
