const express = require('express');
const router = express.Router();
const workspaceController = require('../../controllers/workspace.controller');
const { TenantGuardAllowEnded: TenantGuard } = require('../../middlewares/tenant.middleware');
const AuthGuard = require('../../middlewares/jwt.middleware');

// Any signed-in user may list/create/switch their own workspaces (a brand-new user has none yet, so these
// can't depend on the role/route table).
router.get('/mine', AuthGuard(['/mine']), workspaceController.mine);
router.post('/', AuthGuard(['/']), workspaceController.create);
// These two need an active workspace (TenantGuard answers 403 WORKSPACE_REQUIRED otherwise).
router.get('/current', TenantGuard, workspaceController.current);
router.patch('/current', TenantGuard, workspaceController.updateCurrent);
router.post('/switch', AuthGuard(['/switch']), workspaceController.switchTo);

module.exports = router;
