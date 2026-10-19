const express = require('express');
const router = express.Router();
const workflowController = require('../../controllers/workflow.controller');

// Mounted at /workflows behind TenantGuard. Reads: any member. Writes: owner/admin (checked in the controller).
router.get('/meta', workflowController.meta); // before /:id
router.get('/', workflowController.list);
router.post('/', workflowController.create);
router.get('/:id', workflowController.get);
router.put('/:id', workflowController.update);
router.delete('/:id', workflowController.remove);
router.post('/:id/test', workflowController.test);
router.get('/:id/runs', workflowController.runs);

module.exports = router;
