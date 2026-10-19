const db = require("../config/db.config");

class WorkspaceError extends Error {
  constructor(message, status = 400, code = undefined) {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}

function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "workspace";
}

const MEMBERSHIP_SELECT = `
  SELECT w.id, w.name, w.slug, w.type, w.status, w.auto_responder_enabled, w.cold_mailer_enabled,
         wm.role, wm.permissions
  FROM workspace_members wm
  JOIN workspaces w ON w.id = wm.workspace_id
  WHERE wm.user_id = $1 AND w.is_deleted = FALSE
  ORDER BY wm.created_at, w.id`;

const workspaceService = {
  WorkspaceError,

  async listForUser(userId) {
    const { rows } = await db.query(MEMBERSHIP_SELECT, [userId]);
    return rows;
  },

  async getWorkspace(workspaceId) {
    const { rows } = await db.query(
      `SELECT id, name, slug, type, status, auto_responder_enabled, cold_mailer_enabled
       FROM workspaces WHERE id = $1 AND is_deleted = FALSE`,
      [workspaceId],
    );
    return rows[0] || null;
  },

  // Decides which workspace a request acts in. `preferredId` is the one stored in the session; sessions issued
  // before workspaces existed have none, so they fall back to the user's first membership (no forced re-login).
  // A super admin may act inside any workspace by passing `viewAsId` ("View as").
  async resolveContext(userId, preferredId, viewAsId) {
    const { rows: userRows } = await db.query(
      `SELECT is_super_admin FROM users WHERE id = $1 AND COALESCE(is_deleted, FALSE) = FALSE`,
      [userId],
    );
    if (!userRows[0]) return null;
    const isSuperAdmin = userRows[0].is_super_admin === true;

    if (isSuperAdmin && viewAsId) {
      const target = await this.getWorkspace(viewAsId);
      if (!target) throw new WorkspaceError("That workspace no longer exists.", 404);
      return { isSuperAdmin, viewingAs: true, workspace: { ...target, role: "owner", permissions: {} } };
    }

    const memberships = await this.listForUser(userId);
    const active = memberships.find((m) => m.id === Number(preferredId)) || memberships[0] || null;
    return { isSuperAdmin, viewingAs: false, workspace: active, memberships };
  },

  // Full detail of the active workspace for GET/PATCH /workspaces/current. `ctxWorkspace` is req.workspace
  // (carries the caller's role and permissions; "View as" gives role owner).
  async getDetail(ctxWorkspace, viewingAs) {
    const { rows } = await db.query(
      `SELECT id, name, slug, type, status, auto_responder_enabled, cold_mailer_enabled, platform_ai_enabled, created_at
       FROM workspaces WHERE id = $1 AND is_deleted = FALSE`,
      [ctxWorkspace.id],
    );
    if (!rows[0]) throw new WorkspaceError("That workspace no longer exists.", 404);
    return {
      ...rows[0],
      role: ctxWorkspace.role,
      permissions: {
        auto_responder: ctxWorkspace.permissions?.auto_responder !== false,
        cold_mailer: ctxWorkspace.permissions?.cold_mailer !== false,
      },
      viewingAs: viewingAs === true,
    };
  },

  async renameWorkspace(ctxWorkspace, viewingAs, name) {
    if (ctxWorkspace.role !== "owner") throw new WorkspaceError("Only the workspace owner can rename the workspace.", 403);
    const cleanName = String(name || "").trim();
    if (cleanName.length < 2) throw new WorkspaceError("Workspace name must be at least 2 characters.");
    if (cleanName.length > 120) throw new WorkspaceError("Workspace name must be 120 characters or fewer.");
    await db.query(`UPDATE workspaces SET name = $2, updated_at = NOW() WHERE id = $1`, [ctxWorkspace.id, cleanName]);
    return this.getDetail(ctxWorkspace, viewingAs);
  },

  async createWorkspace(userId, { name, type }) {
    const cleanName = String(name || "").trim();
    if (cleanName.length < 2) throw new WorkspaceError("Workspace name must be at least 2 characters.");
    if (cleanName.length > 120) throw new WorkspaceError("Workspace name must be 120 characters or fewer.");
    const workspaceType = type === "individual" ? "individual" : "organization";

    const client = await db.getClient();
    try {
      await client.query("BEGIN");
      let slug = slugify(cleanName);
      const { rows: taken } = await client.query(`SELECT 1 FROM workspaces WHERE slug = $1`, [slug]);
      if (taken.length) slug = `${slug}-${Math.random().toString(36).slice(2, 7)}`;

      const { rows } = await client.query(
        `INSERT INTO workspaces (name, slug, type, created_by) VALUES ($1, $2, $3, $4)
         RETURNING id, name, slug, type, status, auto_responder_enabled, cold_mailer_enabled`,
        [cleanName, slug, workspaceType, userId],
      );
      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [rows[0].id, userId],
      );
      await client.query("COMMIT");
      return { ...rows[0], role: "owner" };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  // Membership check used before putting a workspace id into a session. Super admins may enter any workspace.
  async assertCanEnter(userId, workspaceId) {
    const ctx = await this.resolveContext(userId, null, null);
    if (!ctx) throw new WorkspaceError("Your account could not be found. Please sign in again.", 401);
    if (ctx.isSuperAdmin) {
      const target = await this.getWorkspace(workspaceId);
      if (!target) throw new WorkspaceError("That workspace no longer exists.", 404);
      return target;
    }
    const match = ctx.memberships.find((m) => m.id === Number(workspaceId));
    if (!match) throw new WorkspaceError("You are not a member of that workspace.", 403);
    return match;
  },
};

module.exports = workspaceService;
