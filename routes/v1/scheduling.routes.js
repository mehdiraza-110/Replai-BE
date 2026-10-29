const express = require("express");
const c = require("../../controllers/scheduling.controller");

const router = express.Router();

router.get("/availability", c.getAvailability);
router.put("/availability", c.saveAvailability);
router.get("/calendar", c.getCalendar);
router.post("/calendar/google/url", c.connectUrl);
router.delete("/calendar", c.disconnect);

module.exports = router;
