const express = require("express");
const aiModelController = require("../../controllers/aiModel.controller");

const router = express.Router();

router.get("/", aiModelController.getModels);

module.exports = router;
