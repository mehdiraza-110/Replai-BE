const express = require("express");
const aiAgentController = require("../../controllers/aiAgent.controller");

const router = express.Router();

router.get("/", aiAgentController.listAgents);
router.post("/", aiAgentController.createAgent);
router.get("/:id", aiAgentController.getAgent);
router.patch("/:id", aiAgentController.updateAgent);
router.delete("/:id", aiAgentController.deleteAgent);

module.exports = router;
