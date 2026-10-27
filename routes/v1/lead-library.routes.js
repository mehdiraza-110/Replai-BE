const express = require("express");
const controller = require("../../controllers/leadLibrary.controller");

const router = express.Router();
const { leadFileUpload } = require("../../config/multer.config");

// Imports are parsed in memory, so they are capped. Keep in step with the limit shown in the app.
const LEAD_IMPORT_MAX_MB = 50;

router.get("/stats", controller.getStats);

router.get("/lists", controller.listLists);
router.post("/lists", controller.createList);
router.patch("/lists/:id", controller.updateList);
router.delete("/lists/:id", controller.deleteList);

router.get("/contacts", controller.listContacts);
router.get("/contacts/export", controller.exportContacts);
router.post("/contacts", controller.addContacts);
router.post("/contacts/import", leadFileUpload(LEAD_IMPORT_MAX_MB), controller.importFile);
router.post("/contacts/delete", controller.deleteContacts);
router.post("/contacts/move", controller.moveContacts);
router.post("/contacts/summary", controller.summarizeSelection);
router.get("/contacts/:id", controller.getContact);
router.patch("/contacts/:id", controller.updateContact);

module.exports = router;
