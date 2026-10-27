const express = require("express");
const multer = require("multer");
const controller = require("../../controllers/leadLibrary.controller");

const router = express.Router();
// Imports are parsed in memory, so cap them well below the general 500MB upload limit.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

router.get("/stats", controller.getStats);

router.get("/lists", controller.listLists);
router.post("/lists", controller.createList);
router.patch("/lists/:id", controller.updateList);
router.delete("/lists/:id", controller.deleteList);

router.get("/contacts", controller.listContacts);
router.get("/contacts/export", controller.exportContacts);
router.post("/contacts", controller.addContacts);
router.post("/contacts/import", upload.single("file"), controller.importFile);
router.post("/contacts/delete", controller.deleteContacts);
router.post("/contacts/move", controller.moveContacts);
router.post("/contacts/summary", controller.summarizeSelection);
router.get("/contacts/:id", controller.getContact);
router.patch("/contacts/:id", controller.updateContact);

module.exports = router;
