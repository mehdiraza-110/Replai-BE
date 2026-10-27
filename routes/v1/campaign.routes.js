const express = require("express");
const campaignController = require("../../controllers/campaign.controller");
const { leadFileUpload } = require("../../config/multer.config");

// Parsed leads travel back to the server as JSON when the campaign is created, so this cap is lower than the Leads import.
const CAMPAIGN_LEAD_FILE_MAX_MB = 25;

const router = express.Router();

router.get("/", campaignController.listCampaigns);
router.post("/", campaignController.createCampaign);
router.post("/parse-leads", leadFileUpload(CAMPAIGN_LEAD_FILE_MAX_MB), campaignController.parseLeadsFile);
router.delete("/:id", campaignController.deleteCampaign);
router.get("/:id/leads", campaignController.listCampaignLeads);
router.post("/:id/leads", campaignController.addCampaignLeads);
router.post("/:id/leads/remove", campaignController.removeCampaignLeads);
router.get("/:id", campaignController.getCampaign);
router.patch("/:id", campaignController.updateCampaign);

module.exports = router;
