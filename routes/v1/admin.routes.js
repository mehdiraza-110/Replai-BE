const express = require('express');
const router = express.Router();
const admin = require('../../controllers/admin.controller');

// Mounted behind SuperAdminGuard (platform level, no workspace needed).
router.get('/workspaces', admin.listWorkspaces);
router.post('/workspaces', admin.createWorkspace);
router.get('/workspaces/:id', admin.getWorkspace);
router.patch('/workspaces/:id', admin.updateWorkspace);
router.delete('/workspaces/:id', admin.deleteWorkspace);

router.post('/workspaces/:id/members', admin.addMember);
router.patch('/workspaces/:id/members/:userId', admin.updateMember);
router.delete('/workspaces/:id/members/:userId', admin.removeMember);

router.get('/users', admin.listUsers);
router.patch('/users/:id', admin.updateUser);

router.get('/analytics', admin.analytics);

module.exports = router;
