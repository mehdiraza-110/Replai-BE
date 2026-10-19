const workspaceService = require("../services/workspace.service");
const jwtUtil = require("../utils/jwt.util");
const db = require("../config/db.config");

function sendError(res, error, fallback) {
  if (error instanceof workspaceService.WorkspaceError) {
    return res.status(error.status).json({ success: false, message: error.message });
  }
  console.error(fallback, error);
  res.status(500).json({ success: false, message: fallback });
}

// Re-issues the session cookie with the chosen workspace as the active one.
async function issueSession(req, res, workspaceId) {
  const { rows } = await db.query(
    `SELECT u.id, u.email,
            COALESCE(json_agg(json_build_object('id', r.id, 'name', r.name)) FILTER (WHERE r.id IS NOT NULL), '[]') AS roles
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     WHERE u.id = $1 GROUP BY u.id`,
    [req.user.id],
  );
  const user = rows[0];
  const token = await jwtUtil.createToken({ userId: user.id, email: user.email, roles: user.roles, workspaceId });
  res.cookie("token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 3600000,
  });
  return token;
}

const workspaceController = {
  // GET /workspaces/mine — the caller's workspaces and which one is active.
  async mine(req, res) {
    try {
      const workspaces = await workspaceService.listForUser(req.user.id);
      res.status(200).json({
        success: true,
        data: { workspaces, activeWorkspaceId: req.workspaceId, isSuperAdmin: req.user.isSuperAdmin },
      });
    } catch (error) {
      sendError(res, error, "We couldn't load your workspaces. Please try again.");
    }
  },

  // POST /workspaces — a new user creates their workspace (required before using the app).
  async create(req, res) {
    try {
      const workspace = await workspaceService.createWorkspace(req.user.id, req.body || {});
      const token = await issueSession(req, res, workspace.id);
      res.status(201).json({ success: true, message: "Workspace created", data: { workspace, token } });
    } catch (error) {
      sendError(res, error, "We couldn't create your workspace. Please try again.");
    }
  },

  // POST /workspaces/switch — change the active workspace.
  async switchTo(req, res) {
    try {
      const workspaceId = Number((req.body || {}).workspaceId);
      if (!Number.isInteger(workspaceId)) {
        return res.status(400).json({ success: false, message: "Choose a workspace to switch to." });
      }
      const workspace = await workspaceService.assertCanEnter(req.user.id, workspaceId);
      const token = await issueSession(req, res, workspace.id);
      res.status(200).json({ success: true, message: "Workspace switched", data: { workspace, token } });
    } catch (error) {
      sendError(res, error, "We couldn't switch workspaces. Please try again.");
    }
  },
};

module.exports = workspaceController;
