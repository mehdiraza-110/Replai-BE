const db = require("../config/db.config");
const secretBox = require("../utils/secretBox.util");

// Asana tokens have their own key so rotating it never touches mailbox passwords.
const KEY_ENV = "ASANA_ENCRYPTION_KEY";
const encryptSecret = (v) => secretBox.encryptSecret(v, KEY_ENV);
const decryptSecret = (v) => secretBox.decryptSecret(v, KEY_ENV);

// Minimal Asana integration for support tickets: connect a personal access token, pick workspace/project/assignee,
// create a task. A connection is only readable and usable by the admin who made it; tokens are never returned or logged.

const BASE = "https://app.asana.com/api/1.0";
const TIMEOUT_MS = 20000;

function httpError(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}) });
}

class AsanaError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

const KIND_BY_STATUS = { 401: "needs_reconnect", 402: "plan", 403: "forbidden", 404: "not_found", 429: "rate_limited" };

async function request(token, method, path, { query, body } = {}, retried = false) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify({ data: body }) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new AsanaError("unavailable", "Asana could not be reached. Try again in a moment.", 0);
  }
  if (res.status === 429 && !retried) {
    const wait = Math.min(Number(res.headers.get("retry-after")) || 2, 10);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return request(token, method, path, { query, body }, true);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = json?.errors?.[0]?.message;
    throw new AsanaError(KIND_BY_STATUS[res.status] || "error", detail || `Asana returned an error (${res.status}).`, res.status);
  }
  return json;
}

// Offset pagination, capped so a huge workspace cannot loop forever.
async function listAll(token, path, query) {
  const out = [];
  let offset;
  for (let page = 0; page < 20; page++) {
    const json = await request(token, "GET", path, { query: { ...query, limit: 100, ...(offset ? { offset } : {}) } });
    out.push(...(json.data || []));
    offset = json.next_page?.offset;
    if (!offset) break;
  }
  return out;
}

const client = (token) => ({
  me: () => request(token, "GET", "/users/me", { query: { opt_fields: "name,email" } }).then((j) => j.data),
  workspaces: () => listAll(token, "/workspaces", { opt_fields: "name,is_organization" }),
  projects: (ws) => listAll(token, "/projects", { workspace: ws, archived: false, opt_fields: "name" }),
  users: (ws) => listAll(token, `/workspaces/${encodeURIComponent(ws)}/users`, { opt_fields: "name,email" }),
  createTask: (fields) => request(token, "POST", "/tasks", { query: { opt_fields: "permalink_url,name" }, body: fields }).then((j) => j.data),
});

// Asana problems reach the browser as 400, never 401: the app treats a 401 as "signed out".
function toHttp(error) {
  if (error instanceof AsanaError) {
    const msg = error.kind === "needs_reconnect" ? "Asana rejected the saved token. Paste a new one to reconnect." : error.message;
    return httpError(msg, 400, `ASANA_${error.kind.toUpperCase()}`);
  }
  return error;
}

const publicRow = (r) => ({ id: r.id, accountName: r.account_name, accountEmail: r.account_email, status: r.status, lastError: r.last_error || null });

async function ownConnections(userId) {
  const { rows } = await db.query(`SELECT * FROM asana_connections WHERE created_by = $1 ORDER BY created_at`, [userId]);
  return rows;
}

async function status(userId) {
  const rows = await ownConnections(userId);
  return { connected: rows.some((r) => r.status === "connected"), connections: rows.map(publicRow) };
}

async function connect(userId, token) {
  const clean = String(token || "").trim();
  if (clean.length < 20 || /\s/.test(clean)) throw httpError("Paste your Asana personal access token.", 400);
  let me;
  try {
    me = await client(clean).me();
  } catch (error) {
    if (error instanceof AsanaError && error.kind === "needs_reconnect") throw httpError("Asana did not accept that token. Check it and try again.", 400, "ASANA_BAD_TOKEN");
    throw toHttp(error);
  }
  const { rows } = await db.query(
    `INSERT INTO asana_connections (token_enc, account_gid, account_name, account_email, status, last_error, last_checked_at, created_by)
     VALUES ($1, $2, $3, $4, 'connected', NULL, NOW(), $5)
     ON CONFLICT (created_by, account_gid) WHERE account_gid IS NOT NULL
     DO UPDATE SET token_enc = EXCLUDED.token_enc, account_name = EXCLUDED.account_name, account_email = EXCLUDED.account_email,
                   status = 'connected', last_error = NULL, last_checked_at = NOW(), updated_at = NOW()
     RETURNING *`,
    [encryptSecret(clean), me.gid, me.name || null, me.email || null, userId],
  );
  return { ...(await status(userId)), connection: publicRow(rows[0]) };
}

async function ownConnection(userId, id) {
  const { rows } = await db.query(`SELECT * FROM asana_connections WHERE id = $1 AND created_by = $2`, [id, userId]).catch(() => ({ rows: [] }));
  if (!rows[0]) throw httpError("That Asana connection does not exist.", 404); // someone else's looks the same
  return rows[0];
}

// Runs a call with a stored connection; a 401 flips it to needs_reconnect.
async function withConnection(conn, fn) {
  if (conn.status === "needs_reconnect") throw httpError("Asana rejected the saved token. Paste a new one to reconnect.", 400, "ASANA_NEEDS_RECONNECT");
  try {
    return await fn(client(decryptSecret(conn.token_enc)));
  } catch (error) {
    if (error instanceof AsanaError && error.kind === "needs_reconnect") {
      await db.query(`UPDATE asana_connections SET status = 'needs_reconnect', last_error = $2, updated_at = NOW() WHERE id = $1`, [conn.id, error.message]);
    }
    throw toHttp(error);
  }
}

async function test(userId, id) {
  const conn = await ownConnection(userId, id);
  try {
    const me = await client(decryptSecret(conn.token_enc)).me();
    await db.query(`UPDATE asana_connections SET status = 'connected', last_error = NULL, account_name = $2, account_email = $3, last_checked_at = NOW() WHERE id = $1`, [id, me.name || conn.account_name, me.email || conn.account_email]);
  } catch (error) {
    if (error instanceof AsanaError && error.kind === "needs_reconnect") {
      await db.query(`UPDATE asana_connections SET status = 'needs_reconnect', last_error = $2, last_checked_at = NOW() WHERE id = $1`, [id, error.message]);
    }
    throw toHttp(error);
  }
  return status(userId);
}

async function disconnect(userId, id) {
  await ownConnection(userId, id);
  await db.query(`DELETE FROM asana_connections WHERE id = $1`, [id]);
  return status(userId);
}

// The caller's connections that can currently be used.
async function usable(userId) {
  const rows = (await ownConnections(userId)).filter((r) => r.status === "connected");
  if (!rows.length) throw httpError("Connect your Asana account first.", 400, "ASANA_NOT_CONNECTED");
  return rows;
}

// Tries each of the caller's connections until one answers.
async function firstWorking(userId, fn) {
  let lastError;
  for (const conn of await usable(userId)) {
    try {
      return await withConnection(conn, fn);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

const workspaces = (userId) => firstWorking(userId, (c) => c.workspaces()).then((list) => list.map((w) => ({ gid: w.gid, name: w.name, isOrganization: Boolean(w.is_organization) })));
const projects = (userId, ws) => firstWorking(userId, (c) => c.projects(ws)).then((list) => list.map((p) => ({ gid: p.gid, name: p.name })));
const users = (userId, ws) => firstWorking(userId, (c) => c.users(ws)).then((list) => list.map((u) => ({ gid: u.gid, name: u.name, email: u.email || null })));

// Throws unless one of the admin's connections can see this workspace.
async function assertWorkspaceReachable(userId, workspaceGid) {
  const list = await workspaces(userId);
  if (!list.some((w) => w.gid === workspaceGid)) throw httpError("Your Asana account cannot see that workspace.", 400);
  return list.find((w) => w.gid === workspaceGid);
}

// Called by the ticket flow with the admin who configured the target (not the reporter, who may not use Asana).
async function createFeedbackTask({ userId, workspaceGid, projectGid, assigneeGid, name, notes }) {
  let conn = null;
  for (const candidate of await usable(userId).catch(() => [])) {
    try {
      const list = await withConnection(candidate, (c) => c.workspaces());
      if (list.some((w) => w.gid === workspaceGid)) { conn = candidate; break; }
    } catch { /* try the next one */ }
  }
  if (!conn) throw httpError("The Asana workspace is no longer reachable. Pick another in the ticket settings.", 400);
  const task = await withConnection(conn, (c) => c.createTask({ name, notes, projects: [projectGid], ...(assigneeGid ? { assignee: assigneeGid } : {}) }));
  return { gid: task.gid, url: task.permalink_url || null };
}

module.exports = { status, connect, test, disconnect, workspaces, projects, users, assertWorkspaceReachable, createFeedbackTask };
