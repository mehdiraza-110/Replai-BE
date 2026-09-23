const express = require("express");
const campaignController = require("../../controllers/campaign.controller");
const { upload } = require("../../config/multer.config");

const router = express.Router();

router.get("/", campaignController.listCampaigns);
router.post("/", campaignController.createCampaign);
router.post("/parse-leads", upload.single("file"), campaignController.parseLeadsFile);
router.get("/:id/leads", campaignController.listCampaignLeads);

module.exports = router;
