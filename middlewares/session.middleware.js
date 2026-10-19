const jwtUtil = require('../utils/jwt.util');

// Needs only a valid session cookie: no route-permission table, no workspace. Sets req.user = { id }.
// (Use TenantGuard for anything that acts inside a workspace.)
const SessionGuard = (req, res, next) => {
  const token = req.cookies && req.cookies.token;
  if (!token) return res.status(401).json({ success: false, message: 'Please sign in to continue.' });

  try {
    const decoded = jwtUtil.verifyToken(token);
    req.user = { id: decoded.userId };
    req.session = { workspaceId: decoded.workspaceId || null };
    next();
  } catch (err) {
    res.status(401).json({ success: false, message: 'Your session has expired. Please sign in again.' });
  }
};

module.exports = SessionGuard;
