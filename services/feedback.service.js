const db = require("../config/db.config");
const realtime = require("./realtime.service");
const settings = require("./feedbackSettings.service");
const asana = require("./asana.service");
const storage = require("../utils/feedbackStorage.util");

// Support tickets. Anyone signed in can report; the platform team (super admins) triages. Everything that is not the
// ticket row itself (the automatic reply, notifications, the Asana task, transcription) is best-effort and never blocks it.

const STATUSES = ["pending", "in_review", "approved", "rejected", "resolved"];
const PAGE_SIZE = 25;
const AUTO_REPLY = (n) => `Thanks for reaching out. We have received your ticket #${n} and we are working on it. We will reply here as soon as we have an update.`;
const STATUS_NOTE = { pending: "is waiting for the team", in_review: "is being reviewed", approved: "was approved", rejected: "was not accepted", resolved: "was resolved" };

function httpError(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}) });
}
const notFound = () => httpError("That ticket does not exist.", 404);

const nameOf = (u) => [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.email || "Someone";

// ---- serializers -----------------------------------------------------------

function serialize(row, { staff = false } = {}) {
  const out = {
    id: row.id,
    ticketNumber: Number(row.ticket_number),
    issueName: row.issue_name,
    description: row.description,
    pageUrl: row.page_url,
    hasRecording: Boolean(row.recording_key),
    recordingBytes: row.recording_bytes === null || row.recording_bytes === undefined ? null : Number(row.recording_bytes),
    durationSeconds: row.duration_seconds,
    transcript: row.transcript,
    transcriptError: row.transcript_error,
    status: row.status,
    statusUpdatedAt: row.status_updated_at,
    createdAt: row.created_at,
  };
  // The sender never receives Asana fields or errors.
  if (staff) {
    out.asanaTaskUrl = row.asana_task_url;
    out.asanaTaskError = row.asana_task_error;
    out.reporter = { id: row.user_id, name: nameOf({ first_name: row.first_name, last_name: row.last_name, email: row.email }), email: row.email || null };
    if (row.workspace_name) out.workspaceName = row.workspace_name;
  }
  return out;
}

const serializeReply = (r) => ({ id: r.id, body: r.body, isStaff: r.is_staff, authorName: r.is_staff ? (r.author_id ? nameOf(r) : "Support team") : nameOf(r), createdAt: r.created_at });

const UNREAD_SQL = `(
  (f.status_updated_at IS NOT NULL AND f.status_updated_at > COALESCE(f.user_read_at, f.created_at))
  OR EXISTS (SELECT 1 FROM feedback_replies r WHERE r.feedback_id = f.id AND r.is_staff AND r.created_at > COALESCE(f.user_read_at, f.created_at))
)`;

// ---- access ----------------------------------------------------------------

async function loadTicket(id, actor) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw notFound();
  const { rows } = await db.query(
    `SELECT f.*, u.first_name, u.last_name, u.email, w.name AS workspace_name
     FROM feedback f JOIN users u ON u.id = f.user_id LEFT JOIN workspaces w ON w.id = f.workspace_id
     WHERE f.id = $1`,
    [id],
  );
  const row = rows[0];
  // Anyone who is neither the owner nor staff gets a 404, so ids reveal nothing.
  if (!row || (row.user_id !== actor.id && !actor.isStaff)) throw notFound();
  return { row, isOwner: row.user_id === actor.id };
}

async function staffIds() {
  const { rows } = await db.query(`SELECT id FROM users WHERE is_super_admin = TRUE AND COALESCE(is_deleted, FALSE) = FALSE`);
  return rows.map((r) => r.id);
}

// ---- notifications (live only; a missed push is caught by the badge poll) ---

function notifyNewTicket(ticket, reporter) {
  staffIds()
    .then((ids) => {
      for (const id of ids) {
        if (id === reporter.id) continue;
        realtime.emitToUser(id, "ticket:new", { id: ticket.id, ticketNumber: Number(ticket.ticket_number), title: ticket.issue_name.slice(0, 140), from: nameOf(reporter) });
      }
    })
    .catch((e) => console.error("Ticket notify failed:", e.message));
}

function notifyTicketOwner(ticket, actorId, { status = null, reply = false } = {}) {
  if (!ticket || ticket.user_id === actorId) return;
  const n = Number(ticket.ticket_number);
  realtime.emitToUser(ticket.user_id, "ticket:updated", {
    id: ticket.id,
    ticketNumber: n,
    title: status ? `Your ticket #${n} ${STATUS_NOTE[status] || "was updated"}` : reply ? `New reply on your ticket #${n}` : `Your ticket #${n} was updated`,
    status,
  });
}

// ---- tickets ---------------------------------------------------------------

async function create(actor, input) {
  const issueName = String(input.issueName || "").trim();
  const description = String(input.description || "").trim();
  if (!issueName || issueName.length > 200) throw httpError("Give your ticket a title of up to 200 characters.", 400);
  if (description.length > 5000) throw httpError("The description can be up to 5,000 characters.", 400);

  const cfg = await settings.getConfig();
  let duration = null;
  if (input.durationSeconds !== undefined && input.durationSeconds !== null) {
    duration = Math.round(Number(input.durationSeconds));
    if (!Number.isFinite(duration) || duration < 0) throw httpError("That recording length is not valid.", 400);
    if (duration > cfg.maxDurationSeconds + 15) throw httpError(`Recordings can be up to ${Math.round(cfg.maxDurationSeconds / 60)} minutes long.`, 400);
  }
  const pageUrl = typeof input.pageUrl === "string" ? input.pageUrl.slice(0, 1000) : null;

  const { rows } = await db.query(
    `INSERT INTO feedback (user_id, workspace_id, issue_name, description, page_url, duration_seconds) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [actor.id, actor.workspaceId || null, issueName, description, pageUrl, duration],
  );
  const ticket = rows[0];

  try {
    await db.query(`INSERT INTO feedback_replies (feedback_id, author_id, is_staff, body) VALUES ($1, NULL, TRUE, $2)`, [ticket.id, AUTO_REPLY(ticket.ticket_number)]);
  } catch (e) {
    console.error("Ticket auto-reply failed:", e.message);
  }
  notifyNewTicket(ticket, actor);
  return serialize({ ...ticket, first_name: actor.first_name, last_name: actor.last_name, email: actor.email });
}

async function publicConfig() {
  const cfg = await settings.getConfig();
  return {
    maxHeight: cfg.maxHeight,
    maxDurationSeconds: cfg.maxDurationSeconds,
    transcription: cfg.transcription.provider === "openai" && Boolean(process.env.OPENAI_API_KEY),
    recordingAvailable: storage.isConfigured() || process.env.NODE_ENV !== "production",
  };
}

async function listMine(actor) {
  const { rows } = await db.query(
    `SELECT f.*, ${UNREAD_SQL} AS has_unread, (SELECT COUNT(*)::int FROM feedback_replies r WHERE r.feedback_id = f.id) AS reply_count
     FROM feedback f WHERE f.user_id = $1 ORDER BY f.created_at DESC LIMIT 200`,
    [actor.id],
  );
  return rows.map((r) => ({ ...serialize(r), replyCount: r.reply_count, hasUnread: r.has_unread }));
}

async function unreadCount(actor) {
  const { rows } = await db.query(`SELECT COUNT(*)::int AS count FROM feedback f WHERE f.user_id = $1 AND ${UNREAD_SQL}`, [actor.id]);
  return { count: rows[0].count };
}

// Tickets that arrived after `since` (the browser remembers when staff last opened the dashboard), not their own.
async function newForStaff(actor, since) {
  const date = since && !Number.isNaN(Date.parse(since)) ? new Date(since) : new Date(0);
  const { rows } = await db.query(`SELECT COUNT(*)::int AS count FROM feedback WHERE created_at > $1 AND user_id <> $2`, [date, actor.id]);
  return { count: rows[0].count };
}

async function inbox(query = {}) {
  const status = STATUSES.includes(query.status) ? query.status : null;
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const search = String(query.search || "").trim();
  const where = [];
  const params = [];
  if (status) { params.push(status); where.push(`f.status = $${params.length}`); }
  if (search) {
    params.push(`%${search.replace(/[%_\\]/g, "\\$&")}%`);
    const p = `$${params.length}`;
    where.push(`(f.issue_name ILIKE ${p} OR f.description ILIKE ${p} OR u.email ILIKE ${p} OR (COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) ILIKE ${p})`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const base = `FROM feedback f JOIN users u ON u.id = f.user_id LEFT JOIN workspaces w ON w.id = f.workspace_id`;

  const [items, total, counts] = await Promise.all([
    db.query(
      `SELECT f.*, u.first_name, u.last_name, u.email, w.name AS workspace_name, (SELECT COUNT(*)::int FROM feedback_replies r WHERE r.feedback_id = f.id) AS reply_count
       ${base} ${clause} ORDER BY f.created_at DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
      params,
    ),
    db.query(`SELECT COUNT(*)::int AS count ${base} ${clause}`, params),
    db.query(`SELECT status, COUNT(*)::int AS count FROM feedback GROUP BY status`),
  ]);
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  let all = 0;
  for (const r of counts.rows) { if (r.status in byStatus) byStatus[r.status] = r.count; all += r.count; }
  return {
    items: items.rows.map((r) => ({ ...serialize(r, { staff: true }), replyCount: r.reply_count })),
    total: total.rows[0].count,
    page,
    pageSize: PAGE_SIZE,
    counts: { all, ...byStatus },
  };
}

async function thread(actor, id) {
  const { row, isOwner } = await loadTicket(id, actor);
  const { rows } = await db.query(
    `SELECT r.*, u.first_name, u.last_name, u.email FROM feedback_replies r LEFT JOIN users u ON u.id = r.author_id WHERE r.feedback_id = $1 ORDER BY r.created_at, r.id`,
    [id],
  );
  if (isOwner) await db.query(`UPDATE feedback SET user_read_at = NOW() WHERE id = $1`, [id]);
  return { feedback: serialize(row, { staff: actor.isStaff }), replies: rows.map(serializeReply) };
}

async function addReply(actor, id, bodyRaw) {
  const body = String(bodyRaw || "").trim();
  if (!body || body.length > 4000) throw httpError("Write a reply of up to 4,000 characters.", 400);
  const { row, isOwner } = await loadTicket(id, actor);
  const staffReply = actor.isStaff && !isOwner;

  const { rows } = await db.query(`INSERT INTO feedback_replies (feedback_id, author_id, is_staff, body) VALUES ($1,$2,$3,$4) RETURNING *`, [id, actor.id, staffReply, body]);
  if (staffReply) {
    if (row.status === "pending") {
      await db.query(`UPDATE feedback SET status = 'in_review', status_updated_at = NOW(), status_updated_by = $2 WHERE id = $1`, [id, actor.id]);
    }
    notifyTicketOwner(row, actor.id, { reply: true });
  } else {
    await db.query(`UPDATE feedback SET user_read_at = NOW() WHERE id = $1`, [id]);
  }
  return serializeReply({ ...rows[0], first_name: actor.first_name, last_name: actor.last_name, email: actor.email });
}

async function setStatus(actor, id, status, messageRaw) {
  if (!STATUSES.includes(status)) throw httpError("That status is not valid.", 400);
  const message = String(messageRaw || "").trim();
  if (message.length > 4000) throw httpError("The message can be up to 4,000 characters.", 400);
  const { row } = await loadTicket(id, actor);
  const changed = row.status !== status;

  if (changed) {
    await db.query(`UPDATE feedback SET status = $2, status_updated_at = NOW(), status_updated_by = $3 WHERE id = $1`, [id, status, actor.id]);
  }
  if (message) {
    await db.query(`INSERT INTO feedback_replies (feedback_id, author_id, is_staff, body) VALUES ($1,$2,TRUE,$3)`, [id, actor.id, message]);
  }
  // One notification to the owner: the status change if there is one, otherwise the message.
  if (changed) notifyTicketOwner(row, actor.id, { status });
  else if (message) notifyTicketOwner(row, actor.id, { reply: true });
  return { id, status, replied: Boolean(message) };
}

// ---- recording + transcript ------------------------------------------------

const EXT = { "video/webm": "webm", "video/mp4": "mp4" };

async function saveRecording(actor, id, req) {
  const { row } = await loadOwn(actor, id);
  const mime = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (!EXT[mime]) throw httpError("Recordings must be WebM or MP4 video.", 415);
  const bytes = Number(req.headers["content-length"]);
  if (!Number.isFinite(bytes) || bytes <= 0) throw httpError("The recording is empty.", 400);
  if (bytes > settings.MAX_VIDEO_BYTES) throw httpError("That recording is too large (300 MB maximum).", 413);

  const ext = EXT[mime];
  let store;
  let key;
  if (storage.isConfigured()) {
    const cfg = await settings.getConfig();
    const prefix = cfg.s3Prefix || process.env.AWS_S3_FEEDBACK_PREFIX || "feedback";
    key = `${prefix}/${actor.id}/${id}.${ext}`;
    await storage.putStream(key, req, bytes, mime);
    store = "s3";
  } else if (process.env.NODE_ENV !== "production") {
    // Local development: accept and discard the bytes so the whole flow can be tried without a bucket.
    req.resume();
    await new Promise((resolve) => req.on("end", resolve).on("error", resolve));
    key = `dev-placeholder/${id}.${ext}`;
    store = "local";
  } else {
    throw httpError("Screen recordings are not available right now.", 409);
  }
  await db.query(`UPDATE feedback SET recording_key = $2, recording_store = $3, recording_mime = $4, recording_bytes = $5 WHERE id = $1`, [id, key, store, mime, bytes]);
  return { ok: true };
}

async function loadOwn(actor, id) {
  const found = await loadTicket(id, { ...actor, isStaff: false });
  return found;
}

async function readBody(req, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw httpError("That audio is too large.", 413);
    chunks.push(chunk);
  }
  if (!size) throw httpError("The audio is empty.", 400);
  return Buffer.concat(chunks);
}

async function speechToText(buffer, mime) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw httpError("Transcription is not set up.", 409);
  const form = new FormData();
  form.append("model", "whisper-1");
  form.append("file", new Blob([buffer], { type: mime || "audio/webm" }), `audio.${/mp4|m4a/.test(mime || "") ? "mp4" : "webm"}`);
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(120000) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw httpError(json?.error?.message || "The transcription service returned an error.", 502);
  return String(json?.text || "").trim();
}

// Audio for the voice-message option: transcribe and store nothing.
async function transcribeOnly(req) {
  const cfg = await settings.getConfig();
  if (cfg.transcription.provider === "internal") return { text: "", skipped: true };
  const mime = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  const text = await speechToText(await readBody(req, settings.MAX_AUDIO_BYTES), mime);
  return { text };
}

// Audio-only copy of a screen recording. Never fails the ticket: a problem is stored on it instead.
async function saveTranscript(actor, id, req) {
  await loadOwn(actor, id);
  const cfg = await settings.getConfig();
  // Without a speech key (or when the team chose internal only) the recording is kept and no transcript is attempted.
  if (cfg.transcription.provider === "internal" || !process.env.OPENAI_API_KEY) return { text: "", skipped: true };
  try {
    const mime = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    const text = await speechToText(await readBody(req, settings.MAX_AUDIO_BYTES), mime);
    await db.query(`UPDATE feedback SET transcript = $2, transcript_error = NULL WHERE id = $1`, [id, text || null]);
    return { text };
  } catch (e) {
    await db.query(`UPDATE feedback SET transcript_error = $2 WHERE id = $1`, [id, String(e.message).slice(0, 500)]).catch(() => {});
    return { text: "", error: true };
  }
}

async function recordingUrl(actor, id, download) {
  const { row } = await loadTicket(id, actor);
  if (!row.recording_key) throw httpError("This ticket has no recording.", 404);
  const filename = `ticket-${row.ticket_number}.${EXT[row.recording_mime] || "webm"}`;
  if (row.recording_store === "local") {
    return { url: null, placeholder: true, filename, title: row.issue_name, durationSeconds: row.duration_seconds };
  }
  return { url: await storage.signedUrl(row.recording_key, { filename, download }), filename, title: row.issue_name, durationSeconds: row.duration_seconds };
}

// ---- Asana task ------------------------------------------------------------

const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

async function createAsanaTask(actor, id) {
  const { row } = await loadOwn(actor, id);
  if (row.asana_task_gid) return { asanaTaskUrl: row.asana_task_url };

  const fail = async (message) => {
    await db.query(`UPDATE feedback SET asana_task_error = $2 WHERE id = $1`, [id, String(message).slice(0, 500)]).catch(() => {});
  };

  const cfg = (await settings.getConfig()).asana;
  if (!cfg.workspaceGid || !cfg.projectGid || !cfg.connectionUserId) {
    const message = "Asana tasks for tickets are not set up yet. Choose a workspace and project in the ticket settings.";
    await fail(message);
    throw httpError(message, 409);
  }

  const reporter = nameOf(actor);
  const appUrl = String(process.env.APP_FRONTEND_URL || "https://app.sendvybe.com").replace(/\/+$/, "");
  const parts = [
    row.description,
    row.transcript && !String(row.description || "").includes(row.transcript) ? `Transcript:\n${row.transcript}` : "",
    row.page_url ? `Page: ${row.page_url}` : "",
    row.recording_key
      ? `Screen recording${row.duration_seconds ? ` (${mmss(row.duration_seconds)})` : ""}${row.recording_store === "local" ? " (dummy, no storage configured)" : ""}: ${appUrl}/app/feedback/${row.id}/recording`
      : "",
    `Reported by ${reporter} through SendVybe.`,
  ].filter((p) => p && String(p).trim());

  try {
    const task = await asana.createFeedbackTask({
      userId: cfg.connectionUserId,
      workspaceGid: cfg.workspaceGid,
      projectGid: cfg.projectGid,
      assigneeGid: cfg.assigneeGid,
      name: row.issue_name.slice(0, 200),
      notes: parts.join("\n\n").slice(0, 10000),
    });
    await db.query(`UPDATE feedback SET asana_task_gid = $2, asana_task_url = $3, asana_task_error = NULL WHERE id = $1`, [id, task.gid, task.url]);
    return { asanaTaskUrl: task.url };
  } catch (e) {
    await fail(e.message);
    throw e;
  }
}

module.exports = {
  STATUSES, create, publicConfig, listMine, unreadCount, newForStaff, inbox, thread, addReply, setStatus,
  saveRecording, saveTranscript, transcribeOnly, recordingUrl, createAsanaTask,
};
