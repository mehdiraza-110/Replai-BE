const db = require('../config/db.config');
const jwtUtil = require('../utils/jwt.util');

// Platform-level access (super admin portal). Independent of the route/role table, and checked against the DB
// so revoking is_super_admin applies immediately.
const SuperAdminGuard = async (req, res, next) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ message: 'Unauthorized: No token' });

  try {
    const decoded = jwtUtil.verifyToken(token);
    const { rows } = await db.query(
      `SELECT id, is_super_admin FROM users WHERE id = $1 AND COALESCE(is_deleted, FALSE) = FALSE`,
      [decoded.userId],
    );
    if (!rows[0]) return res.status(401).json({ message: 'Invalid or expired token' });
    if (rows[0].is_super_admin !== true) {
      return res.status(403).json({ message: 'Only a super admin can do this.' });
    }
    req.user = { id: rows[0].id, isSuperAdmin: true };
    next();
  } catch (err) {
    console.error('Super admin auth error:', err);
    res.status(401).json({ message: 'Invalid or expired token' });
  }
};

module.exports = SuperAdminGuard;
