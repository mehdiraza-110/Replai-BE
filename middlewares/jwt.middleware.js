const db = require('../config/db.config');
const jwtUtil = require('../utils/jwt.util');

const AuthGuard = (allowedRoutes = []) => async (req, res, next) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ message: 'Unauthorized: No token' });

  try {
    const decoded = jwtUtil.verifyToken(token);
    const roles = decoded.roles.map(r => r.name);

    const { rows: allowed } = await db.query(`
      SELECT DISTINCT ro.route
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN routes ro ON ro.id = rp.route_id
      WHERE r.name = ANY($1)
    `, [roles]);

    const dbRoutes = allowed.map(r => r.route);
    const allRoutes = new Set([...dbRoutes, ...allowedRoutes]);
    
    const requestedPath = req.path;
    const match = Array.from(allRoutes).some(route => {
      const regex = new RegExp('^' + route.replace(/:[^/]+/g, '[^/]+') + '$');
      return regex.test(requestedPath);
    });

    if (!match) return res.status(403).json({ message: 'Forbidden: No access to this route' });

    req.user = { id: decoded.userId, roles };
    next();
  } catch (err) {
    console.error('Auth error:', err);
    res.status(401).json({ message: 'Invalid or expired token' });
  }
};

module.exports = AuthGuard;
