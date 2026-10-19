const express = require('express');
const router = express.Router();
const memberController = require('../../controllers/member.controller');

// Mounted behind TenantGuard. Any member may list; owner/admin checks for writes live in member.service.
router.get('/', memberController.list);
router.post('/', memberController.add);
router.patch('/:userId', memberController.update);
router.delete('/:userId', memberController.remove);

module.exports = router;
