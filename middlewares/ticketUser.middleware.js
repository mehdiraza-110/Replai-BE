const db = require('../config/db.config');
const jwtUtil = require('../utils/jwt.util');

// Support tickets belong to a person, not a workspace: anyone signed in can report, even before they have created one.
// Sets req.ticketUser { id, first_name, last_name, email, isStaff, workspaceId }. "Staff" is a platform super admin,
// checked against the database on every request so revoking applies immediately.
const TicketUser = async (req, res, next) => {
  const token = req.cookies && req.cookies.token;
  if (!token) return res.status(401).json({ success: false, message: 'Please sign in to continue.' });
  try {
    const decoded = jwtUtil.verifyToken(token);
    const { rows } = await db.query(
      `SELECT id, first_name, last_name, email, is_super_admin FROM users WHERE id = $1 AND COALESCE(is_deleted, FALSE) = FALSE`,
      [decoded.userId],
    );
    if (!rows[0]) return res.status(401).json({ success: false, message: 'Your session has expired. Please sign in again.' });
    const u = rows[0];
    req.ticketUser = { id: u.id, first_name: u.first_name, last_name: u.last_name, email: u.email, isStaff: u.is_super_admin === true, workspaceId: decoded.workspaceId || null };
    next();
  } catch (err) {
    if (err && (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError')) {
      return res.status(401).json({ success: false, message: 'Your session has expired. Please sign in again.' });
    }
    console.error('Ticket auth error:', err);
    res.status(500).json({ success: false, message: 'We could not verify your session. Please try again.' });
  }
};

const StaffOnly = (req, res, next) =>
  req.ticketUser && req.ticketUser.isStaff ? next() : res.status(403).json({ success: false, message: 'Only the support team can do this.' });

module.exports = { TicketUser, StaffOnly };
