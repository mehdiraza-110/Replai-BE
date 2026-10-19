const adminService = require("../services/admin.service");
const memberService = require("../services/member.service");
const { WorkspaceError } = require("../services/workspace.service");

function sendError(res, error, fallback) {
  if (error instanceof WorkspaceError) {
    return res.status(error.status).json({ success: false, message: error.message });
  }
  console.error(fallback, error);
  res.status(500).json({ success: false, message: fallback });
}

const actorOf = (req) => ({ userId: req.user.id, role: null, isSuperAdmin: true });

// Wraps a handler: success status/message + data, uniform error handling.
const handle = (fallback, status, message, fn) => async (req, res) => {
  try {
    const data = await fn(req);
    const body = { success: true, ...(message ? { message } : {}) };
    if (data !== undefined) body.data = data;
    res.status(status).json(body);
  } catch (error) {
    sendError(res, error, fallback);
  }
};

module.exports = {
  listWorkspaces: handle("We couldn't load workspaces. Please try again.", 200, null, (req) => adminService.listWorkspaces(req.query)),
  createWorkspace: handle("We couldn't create the workspace. Please try again.", 201, "Workspace created", (req) => adminService.createWorkspace(req.body || {})),
  getWorkspace: handle("We couldn't load this workspace. Please try again.", 200, null, (req) => adminService.getWorkspace(req.params.id)),
  updateWorkspace: handle("We couldn't update this workspace. Please try again.", 200, "Workspace updated", (req) => adminService.updateWorkspace(req.params.id, req.body || {})),
  deleteWorkspace: handle("We couldn't delete this workspace. Please try again.", 200, "Workspace deleted", async (req) => { await adminService.deleteWorkspace(req.params.id); }),

  addMember: handle("We couldn't add this member. Please try again.", 201, "Member added", async (req) => {
    const id = await adminService.assertWorkspace(req.params.id);
    return memberService.add(id, actorOf(req), req.body || {});
  }),
  updateMember: handle("We couldn't update this member. Please try again.", 200, "Member updated", async (req) => {
    const id = await adminService.assertWorkspace(req.params.id);
    return memberService.update(id, actorOf(req), req.params.userId, req.body || {});
  }),
  removeMember: handle("We couldn't remove this member. Please try again.", 200, "Member removed", async (req) => {
    const id = await adminService.assertWorkspace(req.params.id);
    await memberService.remove(id, actorOf(req), req.params.userId);
  }),

  listUsers: handle("We couldn't load users. Please try again.", 200, null, (req) => adminService.listUsers(req.query)),
  updateUser: handle("We couldn't update this user. Please try again.", 200, "User updated", (req) => adminService.updateUser(req.user.id, req.params.id, req.body || {})),

  analytics: handle("We couldn't load analytics. Please try again.", 200, null, (req) => adminService.analytics(req.query)),
};
