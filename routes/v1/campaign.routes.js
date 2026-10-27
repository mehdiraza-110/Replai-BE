const express = require("express");
const campaignController = require("../../controllers/campaign.controller");
const { upload } = require("../../config/multer.config");

const router = express.Router();

router.get("/", campaignController.listCampaigns);
router.post("/", campaignController.createCampaign);
router.post("/parse-leads", upload.single("file"), campaignController.parseLeadsFile);
router.delete("/:id", campaignController.deleteCampaign);
router.get("/:id/leads", campaignController.listCampaignLeads);
router.post("/:id/leads", campaignController.addCampaignLeads);
router.post("/:id/leads/remove", campaignController.removeCampaignLeads);
router.get("/:id", campaignController.getCampaign);
router.patch("/:id", campaignController.updateCampaign);

module.exports = router;
