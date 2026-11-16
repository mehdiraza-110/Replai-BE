const express = require('express');
const c = require('../../controllers/feedback.controller');
const { StaffOnly } = require('../../middlewares/ticketUser.middleware');

const router = express.Router();

// Mounted behind TicketUser. Fixed paths come BEFORE the /:id routes so they are never swallowed by them.
// The two upload routes take the raw body (video / audio), so they sit behind no body parser: express.json only
// parses application/json, and these arrive as video/* or audio/*.
router.get('/config', c.config);
router.get('/settings', StaffOnly, c.getSettings);
router.put('/settings', StaffOnly, c.putSettings);
router.get('/mine', c.mine);
router.get('/mine/unread', c.mineUnread);
router.get('/inbox', StaffOnly, c.inbox);
router.get('/staff/new', StaffOnly, c.newForStaff);
router.post('/transcribe', c.transcribe);
router.post('/', c.create);

router.get('/:id/thread', c.thread);
router.post('/:id/replies', c.reply);
router.put('/:id/status', StaffOnly, c.status);
router.put('/:id/recording', c.recording);
router.put('/:id/transcript', c.transcript);
router.post('/:id/asana', c.asanaTask);
router.get('/:id/recording-url', c.recordingUrl);

module.exports = router;
