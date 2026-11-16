const express = require('express');
const c = require('../../controllers/feedback.controller');

const router = express.Router();

// Mounted behind TicketUser + StaffOnly: only the platform team connects Asana for support tickets.
router.get('/status', c.asanaStatus);
router.post('/connect', c.asanaConnect);
router.post('/connections/:id/test', c.asanaTest);
router.delete('/connections/:id', c.asanaDisconnect);
router.get('/options', c.asanaWorkspaces);
router.get('/projects', c.asanaProjects);
router.get('/users', c.asanaUsers);

module.exports = router;
