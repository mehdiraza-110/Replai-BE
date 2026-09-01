const express = require("express");
const { upload } = require("../../config/multer.config");
const knowledgeController = require("../../controllers/knowledge.controller");

const router = express.Router();

router.get("/", knowledgeController.listKnowledgeSources);
router.post("/", upload.single("file"), knowledgeController.createKnowledgeSource);
router.delete("/:id", knowledgeController.deleteKnowledgeSource);

module.exports = router;
