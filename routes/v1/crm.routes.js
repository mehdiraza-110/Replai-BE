const express = require("express");
const c = require("../../controllers/crm.controller");

const router = express.Router();

router.get("/members", c.listMembers);
router.get("/tasks", c.listTasks);
router.post("/tasks", c.createTask);
router.patch("/tasks/:id", c.updateTask);
router.delete("/tasks/:id", c.deleteTask);
router.get("/companies", c.listCompanies);
router.post("/companies", c.createCompany);
router.patch("/companies/:id", c.updateCompany);
router.delete("/companies/:id", c.deleteCompany);
router.get("/deals", c.listDeals);
router.post("/deals", c.createDeal);
router.patch("/deals/:id", c.updateDeal);
router.delete("/deals/:id", c.deleteDeal);
router.get("/notes", c.listNotes);
router.post("/notes", c.createNote);
router.delete("/notes/:id", c.deleteNote);
router.get("/people", c.listPeople);
router.get("/appointments", c.listAppointments);
router.patch("/appointments/:id", c.updateAppointment);
router.get("/scheduled", c.listScheduled);
router.get("/submissions", c.listSubmissions);

router.get("/dashboard/catalog", c.dashboardCatalog);
router.get("/dashboard/data", c.dashboardData);
router.get("/dashboard/views", c.listViews);
router.post("/dashboard/views", c.createView);
router.patch("/dashboard/views/:id", c.updateView);
router.delete("/dashboard/views/:id", c.deleteView);

module.exports = router;
