const express = require('express');
const router = express.Router();
const admin = require('../../controllers/admin.controller');

// Mounted behind SuperAdminGuard (platform level, no workspace needed).
router.get('/workspaces', admin.listWorkspaces);
router.post('/workspaces', admin.createWorkspace);
router.get('/workspaces/:id', admin.getWorkspace);
router.patch('/workspaces/:id', admin.updateWorkspace);
router.delete('/workspaces/:id', admin.deleteWorkspace);
router.post('/workspaces/:id/trial', admin.startTrial);
router.post('/workspaces/:id/usage/reset', admin.resetUsage);

router.post('/workspaces/:id/members', admin.addMember);
router.patch('/workspaces/:id/members/:userId', admin.updateMember);
router.delete('/workspaces/:id/members/:userId', admin.removeMember);

router.post('/workspaces/:id/assign-domains', admin.assignDomains);

router.get('/domains', admin.listDomains);
router.post('/domains/assign/preview', admin.previewAssignDomains);
router.post('/domains/assign', admin.assignDomainsTo);
router.get('/domains/:id', admin.getDomain);

router.get('/orders', admin.listOrders);
router.get('/orders/count', admin.countOrders);
router.get('/orders/:id', admin.getOrder);
router.patch('/orders/:id', admin.updateOrder);
router.post('/orders/:id/apply-limits', admin.applyLimits);

router.get('/users', admin.listUsers);
router.patch('/users/:id', admin.updateUser);

router.get('/analytics', admin.analytics);

module.exports = router;
