const jwtUtil = require('../utils/jwt.util');
const workspaceService = require('../services/workspace.service');
const apiTokens = require('../services/settings/apiTokens.service');

// Guards every tenant route: the caller must be signed in AND acting inside a workspace. On success it sets
//   req.user        { id, isSuperAdmin }
//   req.workspace   the active workspace (id, name, role, product flags...)
//   req.workspaceId shorthand every service query must filter on
// Unlike AuthGuard it does not consult the route/role permission table; access is decided by workspace membership
// (re-read from the DB each request, so removals and suspensions apply immediately).
const guard = (allowEnded) => async (req, res, next) => {
  const token = req.cookies && req.cookies.token;
  const bearer = !token && /^Bearer (sv_\w+)$/.exec(req.get('authorization') || '');
  if (!token && !bearer) return res.status(401).json({ success: false, message: 'Please sign in to continue.' });

  try {
    // An API token acts as the person who made it, inside the workspace it was made in. Browser sessions are unchanged.
    const decoded = bearer ? await apiTokens.resolve(bearer[1]) : jwtUtil.verifyToken(token);
    if (!decoded) return res.status(401).json({ success: false, message: 'That API token is not valid or was revoked.' });
    req.viaApiToken = Boolean(bearer);
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

    if (!allowEnded && ctx.workspace.plan && ctx.workspace.plan.ended && !ctx.isSuperAdmin) {
      return res.status(403).json({ success: false, code: 'TRIAL_ENDED', message: 'Your trial has ended. Contact support to continue.' });
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

const TenantGuard = guard(false);
// For /workspaces/current: still works after the trial ended so the app can show the "trial ended" notice.
const TenantGuardAllowEnded = guard(true);

// Same guard, but lets specific "METHOD /path" pairs through untouched (webhooks / OAuth callbacks that carry
// their own secret and have no browser session).
const tenantGuardExcept = (...publicRoutes) => (req, res, next) =>
  publicRoutes.includes(`${req.method} ${req.path}`) ? next() : TenantGuard(req, res, next);

// Gate a whole product. Super admin toggles these per workspace; "View as" bypasses nothing, it just acts as the owner.
const requireProduct = (product) => (req, res, next) => {
  const flag = product === 'cold_mailer' ? req.workspace.cold_mailer_enabled : req.workspace.auto_responder_enabled;
  const label = product === 'cold_mailer' ? 'Cold Mailer' : 'Auto Responder';
  if (flag === false) {
    return res.status(403).json({ success: false, message: `${label} isn't enabled for this workspace. Contact support to turn it on.` });
  }
  // Plain members are further limited by their own permissions. Owners/admins and super-admin "View as"
  // (which acts as owner) are not.
  if (!req.viewingAs && req.workspace.role === 'member' && req.workspace.permissions && req.workspace.permissions[product] === false) {
    return res.status(403).json({ success: false, message: `${label} isn't enabled for your account. Ask your workspace admin.` });
  }
  next();
};

// Only the platform team (super admin, also while "viewing as") may buy/add/remove domains and mailboxes.
// Everyone else requests them through Orders.
const requireSuperAdmin = (req, res, next) => {
  if (req.user && req.user.isSuperAdmin) return next();
  return res.status(403).json({
    success: false,
    code: 'SUPER_ADMIN_ONLY',
    message: 'Only the platform team can add or remove domains and mailboxes. Use Orders to request them.',
  });
};

module.exports = { requireSuperAdmin, TenantGuard, TenantGuardAllowEnded, tenantGuardExcept, requireProduct };
