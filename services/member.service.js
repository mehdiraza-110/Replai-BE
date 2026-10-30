const crypto = require("crypto");
const db = require("../config/db.config");
const userService = require("./user.service");
const { WorkspaceError } = require("./workspace.service");
const emailService = require("./email.service");
const passwordResetService = require("./passwordReset.service");

const RANK = { member: 1, admin: 2, owner: 3 };
const PRODUCTS = ["auto_responder", "cold_mailer"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MEMBER_SELECT = `
  SELECT u.id AS user_id, u.email, u.first_name, u.last_name, wm.role, wm.permissions, wm.created_at
  FROM workspace_members wm
  JOIN users u ON u.id = wm.user_id AND COALESCE(u.is_deleted, FALSE) = FALSE`;

function shape(row, viewerId) {
  return {
    user_id: row.user_id,
    email: row.email,
    first_name: row.first_name,
    last_name: row.last_name,
    role: row.role,
    permissions: {
      auto_responder: row.permissions?.auto_responder !== false,
      cold_mailer: row.permissions?.cold_mailer !== false,
    },
    created_at: row.created_at,
    is_you: viewerId != null && Number(row.user_id) === Number(viewerId),
  };
}

function generatePassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let out = "";
  const bytes = crypto.randomBytes(12);
  for (let i = 0; i < 12; i++) out += chars[bytes[i] % chars.length];
  return out;
}

// actor = { userId, role: 'owner'|'admin'|'member'|null, isSuperAdmin }. A super admin may do anything.
function actorRank(actor) {
  return actor.isSuperAdmin ? 99 : RANK[actor.role] || 0;
}

function assertCanManage(actor) {
  if (actorRank(actor) < RANK.admin) {
    throw new WorkspaceError("Only workspace owners and admins can manage members.", 403);
  }
}

function assertValidRole(role) {
  if (!RANK[role]) throw new WorkspaceError("Role must be admin or member.", 400);
}

// Only owners (or super admins) may hand out admin/owner; admins may only deal with plain members.
function assertCanGrantRole(actor, role) {
  if (role === "owner" && !(actor.isSuperAdmin || actor.role === "owner")) {
    throw new WorkspaceError("Only a workspace owner can make someone an owner.", 403);
  }
  if (role === "admin" && actorRank(actor) < RANK.owner) {
    throw new WorkspaceError("Only a workspace owner can add or promote admins.", 403);
  }
}

function assertCanTouch(actor, targetRole) {
  if (targetRole !== "member" && actorRank(actor) < RANK.owner) {
    throw new WorkspaceError("Only a workspace owner can change or remove an admin or owner.", 403);
  }
}

// Builds a full permissions object. Never grants a product the workspace itself doesn't have.
function normalizePermissions(workspace, input, base) {
  const flags = { auto_responder: workspace.auto_responder_enabled !== false, cold_mailer: workspace.cold_mailer_enabled !== false };
  if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input))) {
    throw new WorkspaceError("Permissions must be an object like { auto_responder: true, cold_mailer: false }.", 400);
  }
  const out = {};
  for (const p of PRODUCTS) {
    const given = input && input[p] !== undefined ? input[p] : undefined;
    if (given !== undefined && typeof given !== "boolean") {
      throw new WorkspaceError(`Permission "${p}" must be true or false.`, 400);
    }
    if (given === true && !flags[p]) {
      const label = p === "cold_mailer" ? "Cold Mailer" : "Auto Responder";
      throw new WorkspaceError(`${label} isn't enabled for this workspace, so it can't be granted to a member.`, 400);
    }
    const start = given !== undefined ? given : base ? base[p] !== false : true;
    out[p] = start && flags[p];
  }
  return out;
}

async function getWorkspaceRow(workspaceId, client = db) {
  const { rows } = await client.query(
    `SELECT id, name, slug, auto_responder_enabled, cold_mailer_enabled FROM workspaces WHERE id = $1 AND is_deleted = FALSE`,
    [workspaceId],
  );
  if (!rows[0]) throw new WorkspaceError("That workspace no longer exists.", 404);
  return rows[0];
}

async function getMemberRow(workspaceId, userId, client = db) {
  const { rows } = await client.query(`${MEMBER_SELECT} WHERE wm.workspace_id = $1 AND wm.user_id = $2`, [workspaceId, userId]);
  return rows[0] || null;
}

function parseUserId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new WorkspaceError("That member could not be found.", 404);
  return id;
}

// Best-effort "you've been added" email. A newly created user also gets a 7-day "set your password" link
// (the temporary password itself is never emailed). Never throws.
async function sendAddedEmail({ email, workspaceName, role, created, userId }) {
  try {
    const paragraphs = [`You've been added to <strong>${emailService.escapeHtml(workspaceName)}</strong> on SendVybe as ${role === "admin" ? "an" : "a"} <strong>${emailService.escapeHtml(role)}</strong>.`];
    let cta = { label: "Sign in", url: emailService.appUrl("login") };
    let footnote = "";
    if (created) {
      const token = await passwordResetService.issueToken(userId, "invite");
      paragraphs.push("An account has been created for you. Set your password to get started.");
      cta = { label: "Set your password", url: emailService.appUrl(`reset-password?token=${token}`) };
      footnote = "This link is valid for 7 days. After that you can use \"Forgot password?\" on the sign-in page.";
    }
    const { html, text } = emailService.renderEmail({
      title: `You've been added to ${workspaceName}`,
      preheader: `You now have access to ${workspaceName} on SendVybe.`,
      paragraphs,
      cta,
      footnote,
    });
    await emailService.send({ to: email, subject: `You've been added to ${workspaceName}`, html, text, category: "member-added" });
  } catch (error) {
    console.error("Member added email failed:", error.message);
  }
}

const memberService = {
  async list(workspaceId, viewerId) {
    const { rows } = await db.query(`${MEMBER_SELECT} WHERE wm.workspace_id = $1 ORDER BY wm.created_at, u.id`, [workspaceId]);
    return rows.map((r) => shape(r, viewerId));
  },

  async add(workspaceId, actor, body = {}) {
    assertCanManage(actor);
    const email = String(body.email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new WorkspaceError("Enter a valid email address.", 400);
    const role = body.role === undefined ? "member" : body.role;
    if (role !== "admin" && role !== "member" && !(role === "owner" && actor.isSuperAdmin)) {
      throw new WorkspaceError("Role must be admin or member.", 400);
    }
    assertCanGrantRole(actor, role);
    const workspace = await getWorkspaceRow(workspaceId);
    const permissions = normalizePermissions(workspace, body.permissions);

    const { rows: found } = await db.query(
      `SELECT id FROM users WHERE LOWER(email) = $1 AND COALESCE(is_deleted, FALSE) = FALSE ORDER BY id LIMIT 1`,
      [email],
    );
    let userId = found[0] && found[0].id;
    let temporaryPassword;
    let created = false;

    if (userId) {
      const existing = await getMemberRow(workspaceId, userId);
      if (existing) throw new WorkspaceError("This person is already a member of the workspace.", 409);
    } else {
      let password = body.password;
      if (password !== undefined && password !== null && password !== "") {
        if (typeof password !== "string" || password.length < 8) {
          throw new WorkspaceError("Password must be at least 8 characters.", 400);
        }
      } else {
        password = generatePassword();
        temporaryPassword = password;
      }
      const user = await userService.createUser({
        email,
        password,
        first_name: String(body.first_name || "").trim() || null,
        last_name: String(body.last_name || "").trim() || null,
      });
      userId = user.id;
      created = true;
    }

    try {
      await db.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role, permissions, invited_by) VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [workspaceId, userId, role, JSON.stringify(permissions), actor.userId],
      );
    } catch (error) {
      if (created) await db.query(`UPDATE users SET is_deleted = TRUE WHERE id = $1`, [userId]).catch(() => {});
      if (error.code === "23505") throw new WorkspaceError("This person is already a member of the workspace.", 409);
      throw error;
    }
    const member = shape(await getMemberRow(workspaceId, userId), actor.userId);
    await sendAddedEmail({ email, workspaceName: workspace.name, role, created, userId });
    return temporaryPassword ? { member, temporaryPassword } : { member };
  },

  async update(workspaceId, actor, targetIdRaw, body = {}) {
    assertCanManage(actor);
    const targetId = parseUserId(targetIdRaw);
    if (body.role === undefined && body.permissions === undefined) {
      throw new WorkspaceError("Nothing to update. Send a role or permissions.", 400);
    }
    const client = await db.getClient();
    try {
      await client.query("BEGIN");
      // Lock the owners of this workspace so concurrent demotions can't both pass the last-owner check.
      await client.query(`SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND role = 'owner' FOR UPDATE`, [workspaceId]);
      const target = await getMemberRow(workspaceId, targetId, client);
      if (!target) throw new WorkspaceError("That person is not a member of this workspace.", 404);
      assertCanTouch(actor, target.role);

      let newRole = target.role;
      if (body.role !== undefined && body.role !== target.role) {
        if (Number(actor.userId) === targetId) throw new WorkspaceError("You can't change your own role.", 400);
        assertValidRole(body.role);
        if (body.role === "owner" && !actor.isSuperAdmin && actor.role !== "owner") assertCanGrantRole(actor, "owner");
        assertCanGrantRole(actor, body.role);
        if (target.role === "owner" && body.role !== "owner") {
          const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'`, [workspaceId]);
          if (rows[0].n <= 1) throw new WorkspaceError("A workspace must keep at least one owner. Make someone else an owner first.", 409);
        }
        newRole = body.role;
      }
      let permissions = target.permissions;
      if (body.permissions !== undefined) {
        const workspace = await getWorkspaceRow(workspaceId, client);
        permissions = normalizePermissions(workspace, body.permissions, target.permissions);
      }
      await client.query(
        `UPDATE workspace_members SET role = $3, permissions = $4::jsonb WHERE workspace_id = $1 AND user_id = $2`,
        [workspaceId, targetId, newRole, JSON.stringify(permissions)],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return shape(await getMemberRow(workspaceId, targetId), actor.userId);
  },

  async remove(workspaceId, actor, targetIdRaw) {
    assertCanManage(actor);
    const targetId = parseUserId(targetIdRaw);
    const client = await db.getClient();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND role = 'owner' FOR UPDATE`, [workspaceId]);
      const target = await getMemberRow(workspaceId, targetId, client);
      if (!target) throw new WorkspaceError("That person is not a member of this workspace.", 404);
      const self = Number(actor.userId) === targetId;
      if (!self) assertCanTouch(actor, target.role);
      if (target.role === "owner") {
        const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'`, [workspaceId]);
        if (rows[0].n <= 1) {
          throw new WorkspaceError(
            self ? "You are the last owner, so you can't leave. Make someone else an owner first." : "A workspace must keep at least one owner.",
            409,
          );
        }
      }
      await client.query(`DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, targetId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};

module.exports = memberService;
