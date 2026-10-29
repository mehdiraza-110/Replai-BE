const db = require("../../config/db.config");
const suppression = require("../suppression.service");

const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const EMAIL_RE = /^[^\s@,;"]+@[^\s@,;"]+\.[^\s@,;"]+$/;
const MAX_IMPORT = 20000;
const REASONS = ["unsubscribed", "complained", "hard_bounce", "manual"];

const shape = (r) => ({ id: Number(r.id), email: r.email, reason: r.reason, source: r.source, campaignName: r.campaign_name, createdAt: r.created_at });

async function list(workspaceId, q = {}) {
  const page = Math.max(1, Number.parseInt(q.page, 10) || 1);
  const limit = Math.min(Math.max(Number.parseInt(q.limit, 10) || 50, 1), 200);
  const params = [workspaceId];
  let where = "s.workspace_id = $1";
  const term = String(q.search || "").trim().slice(0, 200);
  if (term) { params.push(`%${term.replace(/[%_\\]/g, "\\$&")}%`); where += ` AND s.email ILIKE $${params.length}`; }
  if (q.reason) { if (!REASONS.includes(q.reason)) throw bad("Unknown reason."); params.push(q.reason); where += ` AND s.reason = $${params.length}`; }
  const [rows, count] = await Promise.all([
    db.query(`SELECT s.*, c.name AS campaign_name FROM suppressions s LEFT JOIN campaigns c ON c.id = s.campaign_id WHERE ${where} ORDER BY s.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, (page - 1) * limit]),
    db.query(`SELECT COUNT(*)::int AS n FROM suppressions s WHERE ${where}`, params),
  ]);
  return { items: rows.rows.map(shape), page, limit, total: count.rows[0].n, totalPages: Math.max(1, Math.ceil(count.rows[0].n / limit)) };
}

const normalize = (raw) => String(raw ?? "").trim().toLowerCase().replace(/^"+|"+$/g, "");

/** Adds addresses (one or many). Domain-wide blocks are not supported, so anything without a full address is reported back. */
async function add(workspaceId, body = {}) {
  const raw = Array.isArray(body.emails) ? body.emails : String(body.emails ?? body.email ?? "").split(/[\s,;]+/);
  const emails = [...new Set(raw.map(normalize).filter(Boolean))];
  if (!emails.length) throw bad("Enter at least one email address.");
  if (emails.length > 1000) throw bad("Add at most 1,000 addresses at a time. Use Import for more.");
  const invalid = emails.filter((e) => !EMAIL_RE.test(e) || e.length > 350);
  const valid = emails.filter((e) => !invalid.includes(e));
  for (const email of valid) await suppression.addSuppression({ email, reason: "manual", source: "manual", workspaceId });
  return { added: valid.length, invalid };
}

async function remove(workspaceId, body = {}) {
  const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Number.isInteger);
  if (!ids.length) throw bad("Pick at least one address to remove.");
  if (ids.length > 5000) throw bad("Remove at most 5,000 at a time.");
  const { rowCount } = await db.query(`DELETE FROM suppressions WHERE workspace_id = $1 AND id = ANY($2::int[])`, [workspaceId, ids]);
  return { removed: rowCount };
}

const csvCell = (v) => { const s = String(v ?? ""); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : /^[=+\-@\t]/.test(s) ? `'${s}` : s; };

async function exportCsv(workspaceId) {
  const { rows } = await db.query(`SELECT email, reason, source, created_at FROM suppressions WHERE workspace_id = $1 ORDER BY id LIMIT 200000`, [workspaceId]);
  return ["email,reason,source,blocked_at", ...rows.map((r) => [r.email, r.reason, r.source, new Date(r.created_at).toISOString()].map(csvCell).join(","))].join("\n") + "\n";
}

/** Imports a CSV (or plain list). Uses the first column unless there is an "email" header. */
async function importCsv(workspaceId, text) {
  const lines = String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw bad("That file is empty.");
  const first = lines[0].split(",").map((c) => normalize(c));
  const emailCol = first.includes("email") ? first.indexOf("email") : 0;
  const body = first.includes("email") ? lines.slice(1) : lines;
  if (body.length > MAX_IMPORT) throw bad(`Import at most ${MAX_IMPORT.toLocaleString()} addresses at a time.`);
  const valid = new Set();
  const invalid = [];
  let invalidTotal = 0;
  for (const line of body) {
    const cell = normalize(line.split(",")[emailCol]);
    if (!cell) continue;
    if (EMAIL_RE.test(cell) && cell.length <= 350) valid.add(cell); else { invalidTotal++; if (invalid.length < 50) invalid.push(cell); }
  }
  const emails = [...valid];
  let added = 0;
  for (let i = 0; i < emails.length; i += 500) {
    const chunk = emails.slice(i, i + 500);
    const r = await db.query(
      `INSERT INTO suppressions (email, reason, source, workspace_id) SELECT e, 'manual', 'manual', $1 FROM unnest($2::text[]) e ON CONFLICT (workspace_id, email) DO NOTHING`,
      [workspaceId, chunk]
    );
    added += r.rowCount;
  }
  return { added, alreadyBlocked: emails.length - added, invalid, invalidCount: invalidTotal };
}

module.exports = { list, add, remove, exportCsv, importCsv };
