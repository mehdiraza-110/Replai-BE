const jwtUtil = require('../utils/jwt.util');
const workspaceService = require('../services/workspace.service');

// Guards every tenant route: the caller must be signed in AND acting inside a workspace. On success it sets
//   req.user        { id, isSuperAdmin }
//   req.workspace   the active workspace (id, name, role, product flags...)
//   req.workspaceId shorthand every service query must filter on
// Unlike AuthGuard it does not consult the route/role permission table; access is decided by workspace membership
// (re-read from the DB each request, so removals and suspensions apply immediately).
const TenantGuard = async (req, res, next) => {
  const token = req.cookies && req.cookies.token;
  if (!token) return res.status(401).json({ success: false, message: 'Please sign in to continue.' });

  try {
    const decoded = jwtUtil.verifyToken(token);
    const ctx = await workspaceService.resolveContext(
      decoded.userId,
      decoded.workspaceId,
      req.get('x-view-as-workspace'),
    );
    if (!ctx) return res.status(401).json({ success: false, message: 'Your session has expired. Please sign in again.' });
    if (!ctx.workspace) {
      return res.status(403).json({
        success: false,
        code: 'WORKSPACE_REQUIRED',
        message: 'Create a workspace to continue.',
      });
    }
    if (ctx.workspace.status === 'suspended' && !ctx.isSuperAdmin) {
      return res.status(403).json({ success: false, message: 'This workspace has been suspended. Please contact support.' });
    }

    req.user = { id: decoded.userId, isSuperAdmin: ctx.isSuperAdmin };
    req.workspace = ctx.workspace;
    req.workspaceId = ctx.workspace.id;
    req.viewingAs = ctx.viewingAs;
    next();
  } catch (err) {
    if (err instanceof workspaceService.WorkspaceError) {
      return res.status(err.status).json({ success: false, message: err.message });
    }
    if (err && (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError')) {
      return res.status(401).json({ success: false, message: 'Your session has expired. Please sign in again.' });
    }
    console.error('Tenant auth error:', err);
    res.status(500).json({ success: false, message: 'We could not verify your session. Please try again.' });
  }
};

// Same guard, but lets specific "METHOD /path" pairs through untouched (webhooks / OAuth callbacks that carry
// their own secret and have no browser session).
const tenantGuardExcept = (...publicRoutes) => (req, res, next) =>
  publicRoutes.includes(`${req.method} ${req.path}`) ? next() : TenantGuard(req, res, next);

// Gate a whole product. Super admin toggles these per workspace; "View as" bypasses nothing, it just acts as the owner.
const requireProduct = (product) => (req, res, next) => {
  const flag = product === 'cold_mailer' ? req.workspace.cold_mailer_enabled : req.workspace.auto_responder_enabled;
  if (flag === false) {
    const label = product === 'cold_mailer' ? 'Cold Mailer' : 'Auto Responder';
    return res.status(403).json({ success: false, message: `${label} isn't enabled for this workspace. Contact support to turn it on.` });
  }
  next();
};

module.exports = { TenantGuard, tenantGuardExcept, requireProduct };
