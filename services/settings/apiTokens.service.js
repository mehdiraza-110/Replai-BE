const crypto = require("crypto");
const db = require("../../config/db.config");

const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const MAX_ACTIVE = 20;
const KINDS = ["personal", "workspace"];
const hash = (token) => crypto.createHash("sha256").update(token).digest("hex");

const shape = (r) => ({
  id: Number(r.id), kind: r.kind, name: r.name, prefix: r.prefix, createdAt: r.created_at, lastUsedAt: r.last_used_at,
  createdBy: r.created_by ? r.created_by.trim() : null, mine: r.mine,
});

/** Tokens the caller may see: their own personal tokens, or the workspace's keys. */
async function list(workspaceId, userId, kind) {
  if (!KINDS.includes(kind)) throw bad("Unknown token type.");
  const { rows } = await db.query(
    `SELECT t.*, NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') AS created_by, (t.user_id = $2) AS mine
     FROM api_tokens t LEFT JOIN users u ON u.id = t.user_id
     WHERE t.workspace_id = $1 AND t.kind = $3 AND t.revoked_at IS NULL AND ($3 = 'workspace' OR t.user_id = $2) ORDER BY t.id DESC`,
    [workspaceId, userId, kind]
  );
  return rows.map(shape);
}

/** Creates a token and returns the plain value, the only time it is ever available. */
async function create(workspaceId, userId, kind, name) {
  if (!KINDS.includes(kind)) throw bad("Unknown token type.");
  const label = String(name ?? "").trim().slice(0, 120);
  if (!label) throw bad("Give the token a name so you can recognise it later.");
  const { rows: count } = await db.query(
    `SELECT COUNT(*)::int AS n FROM api_tokens WHERE workspace_id = $1 AND revoked_at IS NULL AND kind = $2 AND ($2 = 'workspace' OR user_id = $3)`,
    [workspaceId, kind, userId]
  );
  if (count[0].n >= MAX_ACTIVE) throw bad(`You can have at most ${MAX_ACTIVE} active tokens. Revoke one you no longer use.`);
  const token = `sv_${kind === "workspace" ? "ws" : "pt"}_${crypto.randomBytes(24).toString("hex")}`;
  const { rows } = await db.query(
    `INSERT INTO api_tokens (workspace_id, user_id, kind, name, prefix, token_hash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *, TRUE AS mine`,
    [workspaceId, userId, kind, label, token.slice(0, 12), hash(token)]
  );
  return { token, item: shape(rows[0]) };
}

async function revoke(workspaceId, userId, id, { canManageWorkspace }) {
  const { rows } = await db.query(`SELECT kind, user_id FROM api_tokens WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL`, [workspaceId, Number(id)]);
  if (!rows[0]) throw bad("That token doesn't exist or was already revoked.", 404);
  if (rows[0].kind === "personal" ? rows[0].user_id !== userId : !canManageWorkspace) throw bad("You can't revoke that token.", 403);
  await db.query(`UPDATE api_tokens SET revoked_at = NOW() WHERE id = $1`, [Number(id)]);
  return { revoked: true };
}

/** For the request guard: who a bearer token acts as, or null. Touches last-used at most once a minute. */
async function resolve(token) {
  if (typeof token !== "string" || !/^sv_(ws|pt)_[0-9a-f]{48}$/.test(token)) return null;
  const { rows } = await db.query(
    `SELECT t.id, t.user_id, t.workspace_id, t.last_used_at FROM api_tokens t JOIN users u ON u.id = t.user_id AND COALESCE(u.is_deleted, FALSE) = FALSE
     WHERE t.token_hash = $1 AND t.revoked_at IS NULL`,
    [hash(token)]
  );
  if (!rows[0]) return null;
  if (!rows[0].last_used_at || Date.now() - new Date(rows[0].last_used_at).getTime() > 60000) {
    db.query(`UPDATE api_tokens SET last_used_at = NOW() WHERE id = $1`, [rows[0].id]).catch(() => {});
  }
  return { userId: rows[0].user_id, workspaceId: rows[0].workspace_id };
}

module.exports = { list, create, revoke, resolve };
