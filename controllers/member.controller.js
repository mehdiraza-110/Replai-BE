const memberService = require("../services/member.service");
const { WorkspaceError } = require("../services/workspace.service");

function sendError(res, error, fallback) {
  if (error instanceof WorkspaceError) {
    return res.status(error.status).json({ success: false, message: error.message });
  }
  console.error(fallback, error);
  res.status(500).json({ success: false, message: fallback });
}

// The caller as seen by the member rules. "View as" arrives with role 'owner' already (see resolveContext).
const actorOf = (req) => ({ userId: req.user.id, role: req.workspace.role, isSuperAdmin: req.user.isSuperAdmin === true });

const memberController = {
  async list(req, res) {
    try {
      const data = await memberService.list(req.workspaceId, req.user.id);
      res.status(200).json({ success: true, data });
    } catch (error) {
      sendError(res, error, "We couldn't load the members. Please try again.");
    }
  },
  async add(req, res) {
    try {
      const data = await memberService.add(req.workspaceId, actorOf(req), req.body || {});
      res.status(201).json({ success: true, message: "Member added", data });
    } catch (error) {
      sendError(res, error, "We couldn't add this member. Please try again.");
    }
  },
  async update(req, res) {
    try {
      const data = await memberService.update(req.workspaceId, actorOf(req), req.params.userId, req.body || {});
      res.status(200).json({ success: true, message: "Member updated", data });
    } catch (error) {
      sendError(res, error, "We couldn't update this member. Please try again.");
    }
  },
  async remove(req, res) {
    try {
      await memberService.remove(req.workspaceId, actorOf(req), req.params.userId);
      res.status(200).json({ success: true, message: "Member removed" });
    } catch (error) {
      sendError(res, error, "We couldn't remove this member. Please try again.");
    }
  },
};

module.exports = memberController;
