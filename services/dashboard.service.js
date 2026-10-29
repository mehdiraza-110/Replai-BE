const db = require("../config/db.config");

const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const SIZES = ["s", "m", "l"];
const RANGES = [7, 30, 90];
const OUT_SENT = `m.direction = 'outbound' AND (m.author IS NULL OR m.author = 'campaign')`;

// Whole calendar days, matching the daily series: back=0 is the last `days` days including today, back=1 the period before.
const win = (col, back) => `${col} >= (CURRENT_DATE - ($2::int * ${back + 1} - 1))::timestamp AND ${col} < (CURRENT_DATE - $2::int * ${back} + 1)::timestamp`;

const counters = {
  emails_sent: (b) => `SELECT COUNT(*)::int AS n FROM messages m WHERE m.workspace_id = $1 AND ${OUT_SENT} AND ${win("m.created_at", b)}`,
  replies: (b) => `SELECT COUNT(*)::int AS n FROM messages m WHERE m.workspace_id = $1 AND m.direction = 'inbound' AND ${win("m.created_at", b)}`,
  positive_replies: (b) => `SELECT COUNT(DISTINCT (m.mailbox_id, m.thread_id))::int AS n FROM messages m
    JOIN sdr_thread_state s ON s.workspace_id = m.workspace_id AND s.mailbox_id = m.mailbox_id AND s.thread_id = m.thread_id AND s.interest IN ('high','very_high')
    WHERE m.workspace_id = $1 AND m.direction = 'inbound' AND ${win("m.created_at", b)}`,
  meetings_booked: (b) => `SELECT COUNT(*)::int AS n FROM sdr_bookings x WHERE x.workspace_id = $1 AND x.status = 'booked' AND ${win("x.created_at", b)}`,
  new_leads: (b) => `SELECT COUNT(DISTINCT lower(x.email))::int AS n FROM lead_contacts x WHERE x.workspace_id = $1 AND ${win("x.created_at", b)}`,
};

// Point-in-time numbers: no comparison period.
const snapshots = {
  open_tasks: `SELECT COUNT(*)::int AS n FROM crm_tasks WHERE workspace_id = $1 AND status = 'open' AND $2::int > 0`,
  overdue_tasks: `SELECT COUNT(*)::int AS n FROM crm_tasks WHERE workspace_id = $1 AND status = 'open' AND due_at < NOW() AND $2::int > 0`,
  active_inboxes: `SELECT COUNT(*)::int AS n FROM mailboxes WHERE workspace_id = $1 AND status = 'Active' AND $2::int > 0`,
  pipeline_value: `SELECT COALESCE(SUM(value), 0)::float AS n FROM crm_deals WHERE workspace_id = $1 AND stage NOT IN ('won','lost') AND $2::int > 0`,
  deals_won: `SELECT COALESCE(SUM(value), 0)::float AS n FROM crm_deals WHERE workspace_id = $1 AND stage = 'won' AND $2::int > 0`,
};

const CATALOG = [
  { key: "emails_sent", type: "stat", label: "Emails sent", description: "Campaign emails sent in the period.", defaultSize: "s" },
  { key: "replies", type: "stat", label: "Replies", description: "Replies received from prospects.", defaultSize: "s" },
  { key: "positive_replies", type: "stat", label: "Positive replies", description: "Conversations with high interest that replied in the period.", defaultSize: "s" },
  { key: "meetings_booked", type: "stat", label: "Meetings booked", description: "Calls the AI SDR or your team booked.", defaultSize: "s" },
  { key: "new_leads", type: "stat", label: "New leads", description: "People added to your lead library.", defaultSize: "s" },
  { key: "open_tasks", type: "stat", label: "Open tasks", description: "Tasks not yet done.", defaultSize: "s", snapshot: true },
  { key: "overdue_tasks", type: "stat", label: "Overdue tasks", description: "Open tasks past their due date.", defaultSize: "s", snapshot: true },
  { key: "active_inboxes", type: "stat", label: "Active inboxes", description: "Inboxes currently sending.", defaultSize: "s", snapshot: true },
  { key: "pipeline_value", type: "stat", label: "Open pipeline", description: "Total value of deals still in play.", defaultSize: "s", snapshot: true, format: "money" },
  { key: "deals_won", type: "stat", label: "Won deals", description: "Total value of won deals.", defaultSize: "s", snapshot: true, format: "money" },
  { key: "sent_vs_replies", type: "chart", label: "Emails sent and replies", description: "Daily sends and replies.", defaultSize: "l" },
  { key: "meetings_per_day", type: "chart", label: "Meetings booked per day", description: "Calls booked each day.", defaultSize: "m" },
  { key: "new_leads_per_day", type: "chart", label: "New leads per day", description: "People added each day.", defaultSize: "m" },
  { key: "upcoming_appointments", type: "list", label: "Upcoming appointments", description: "Your next booked calls.", defaultSize: "m" },
  { key: "tasks_due", type: "list", label: "Tasks due", description: "Open tasks, soonest first.", defaultSize: "m" },
  { key: "pipeline_by_stage", type: "list", label: "Pipeline by stage", description: "Deals and value in each stage.", defaultSize: "m" },
];
const BY_KEY = Object.fromEntries(CATALOG.map((w) => [w.key, w]));

const DEFAULT_WIDGETS = [
  { key: "emails_sent", size: "s" }, { key: "replies", size: "s" }, { key: "positive_replies", size: "s" }, { key: "meetings_booked", size: "s" },
  { key: "sent_vs_replies", size: "l" }, { key: "upcoming_appointments", size: "m" }, { key: "tasks_due", size: "m" },
];

function cleanWidgets(input) {
  if (!Array.isArray(input)) throw bad("Widgets must be a list.");
  if (input.length > 30) throw bad("A view can hold at most 30 widgets.");
  const seen = new Set();
  return input.map((w) => {
    const def = BY_KEY[w?.key];
    if (!def) throw bad(`Unknown widget: ${String(w?.key).slice(0, 40)}.`);
    if (seen.has(def.key)) throw bad(`${def.label} is already on this view.`);
    seen.add(def.key);
    return { key: def.key, size: SIZES.includes(w.size) ? w.size : def.defaultSize };
  });
}

const viewShape = (r) => ({ id: Number(r.id), name: r.name, widgets: r.widgets, isDefault: r.is_default, updatedAt: r.updated_at });

async function listViews(workspaceId, userId) {
  let { rows } = await db.query(`SELECT * FROM dashboard_views WHERE workspace_id = $1 ORDER BY is_default DESC, id`, [workspaceId]);
  if (!rows.length) {
    await db.query(`INSERT INTO dashboard_views (workspace_id, name, widgets, is_default, created_by) VALUES ($1, 'Overview', $2::jsonb, TRUE, $3) ON CONFLICT DO NOTHING`, [workspaceId, JSON.stringify(DEFAULT_WIDGETS), userId || null]);
    ({ rows } = await db.query(`SELECT * FROM dashboard_views WHERE workspace_id = $1 ORDER BY is_default DESC, id`, [workspaceId]));
  }
  return rows.map(viewShape);
}

const viewName = (value) => {
  const name = String(value ?? "").trim().slice(0, 120);
  if (!name) throw bad("Give the view a name.");
  return name;
};

async function createView(workspaceId, userId, body = {}) {
  const name = viewName(body.name);
  const widgets = cleanWidgets(body.widgets ?? DEFAULT_WIDGETS);
  try {
    const { rows } = await db.query(`INSERT INTO dashboard_views (workspace_id, name, widgets, created_by) VALUES ($1,$2,$3::jsonb,$4) RETURNING *`, [workspaceId, name, JSON.stringify(widgets), userId]);
    return viewShape(rows[0]);
  } catch (error) {
    if (error.code === "23505") throw bad("You already have a view with that name.", 409);
    throw error;
  }
}

async function updateView(workspaceId, id, body = {}) {
  const sets = [];
  const params = [workspaceId, Number(id)];
  if (body.name !== undefined) { params.push(viewName(body.name)); sets.push(`name = $${params.length}`); }
  if (body.widgets !== undefined) { params.push(JSON.stringify(cleanWidgets(body.widgets))); sets.push(`widgets = $${params.length}::jsonb`); }
  if (body.isDefault === true) {
    await db.query(`UPDATE dashboard_views SET is_default = FALSE WHERE workspace_id = $1 AND is_default AND id <> $2`, [workspaceId, Number(id)]);
    sets.push("is_default = TRUE");
  }
  if (!sets.length) throw bad("Nothing to update.");
  try {
    const { rows } = await db.query(`UPDATE dashboard_views SET ${sets.join(", ")}, updated_at = NOW() WHERE workspace_id = $1 AND id = $2 RETURNING *`, params);
    if (!rows[0]) throw bad("View not found.", 404);
    return viewShape(rows[0]);
  } catch (error) {
    if (error.code === "23505") throw bad("You already have a view with that name.", 409);
    throw error;
  }
}

async function deleteView(workspaceId, id) {
  const { rows } = await db.query(`SELECT is_default FROM dashboard_views WHERE workspace_id = $1 AND id = $2`, [workspaceId, Number(id)]);
  if (!rows[0]) throw bad("View not found.", 404);
  if (rows[0].is_default) throw bad("The default view can't be deleted. Make another view the default first.");
  await db.query(`DELETE FROM dashboard_views WHERE workspace_id = $1 AND id = $2`, [workspaceId, Number(id)]);
  return { deleted: true };
}

// One row per day across the period, so empty days draw as zero rather than being skipped.
async function daily(workspaceId, days, table) {
  const { rows } = await db.query(
    `WITH d AS (SELECT generate_series(CURRENT_DATE - ($2::int - 1), CURRENT_DATE, INTERVAL '1 day')::date AS day)
     SELECT to_char(d.day, 'YYYY-MM-DD') AS date, ${table.cols} FROM d ${table.join} GROUP BY d.day ORDER BY d.day`,
    [workspaceId, days]
  );
  return rows.map((r) => ({ ...r, ...Object.fromEntries(table.keys.map((k) => [k, Number(r[k])])) }));
}

const SERIES = {
  sent_vs_replies: {
    keys: ["sent", "replies"],
    cols: `COUNT(m.id) FILTER (WHERE ${OUT_SENT})::int AS sent, COUNT(m.id) FILTER (WHERE m.direction = 'inbound')::int AS replies`,
    join: `LEFT JOIN messages m ON m.workspace_id = $1 AND m.created_at::date = d.day`,
  },
  meetings_per_day: { keys: ["meetings"], cols: `COUNT(x.id)::int AS meetings`, join: `LEFT JOIN sdr_bookings x ON x.workspace_id = $1 AND x.status = 'booked' AND x.created_at::date = d.day` },
  new_leads_per_day: { keys: ["leads"], cols: `COUNT(DISTINCT lower(x.email))::int AS leads`, join: `LEFT JOIN lead_contacts x ON x.workspace_id = $1 AND x.created_at::date = d.day` },
};

async function widgetData(workspaceId, key, days) {
  const def = BY_KEY[key];
  if (def.type === "stat") {
    if (snapshots[key]) return { value: Number((await db.query(snapshots[key], [workspaceId, days])).rows[0].n) };
    const [cur, prev] = await Promise.all([db.query(counters[key](0), [workspaceId, days]), db.query(counters[key](1), [workspaceId, days])]);
    return { value: Number(cur.rows[0].n), previous: Number(prev.rows[0].n) };
  }
  if (def.type === "chart") return { series: await daily(workspaceId, days, SERIES[key]) };
  if (key === "upcoming_appointments") {
    const { rows } = await db.query(`SELECT id, lead_name, lead_email, scheduled_start FROM sdr_bookings WHERE workspace_id = $1 AND status = 'booked' AND scheduled_start >= NOW() ORDER BY scheduled_start LIMIT 6`, [workspaceId]);
    return { rows: rows.map((r) => ({ id: r.id, title: r.lead_name || r.lead_email, at: r.scheduled_start })) };
  }
  if (key === "tasks_due") {
    const { rows } = await db.query(`SELECT id, title, due_at FROM crm_tasks WHERE workspace_id = $1 AND status = 'open' ORDER BY due_at ASC NULLS LAST, id DESC LIMIT 6`, [workspaceId]);
    return { rows: rows.map((r) => ({ id: Number(r.id), title: r.title, at: r.due_at, overdue: r.due_at !== null && new Date(r.due_at) < new Date() })) };
  }
  const { rows } = await db.query(`SELECT stage, COUNT(*)::int AS n, COALESCE(SUM(value), 0)::float AS value FROM crm_deals WHERE workspace_id = $1 GROUP BY stage`, [workspaceId]);
  const order = ["lead", "qualified", "meeting", "proposal", "won", "lost"];
  return { rows: order.map((stage) => ({ stage, count: rows.find((r) => r.stage === stage)?.n || 0, value: rows.find((r) => r.stage === stage)?.value || 0 })) };
}

/** Data for the requested widgets only (the page asks for the ones on the current view). */
async function data(workspaceId, { days = 30, widgets = "" } = {}) {
  const n = Number(days);
  if (!RANGES.includes(n)) throw bad("Date range must be 7, 30 or 90 days.");
  const keys = [...new Set(String(widgets).split(",").map((k) => k.trim()).filter(Boolean))];
  if (keys.length > 30) throw bad("Too many widgets.");
  for (const key of keys) if (!BY_KEY[key]) throw bad(`Unknown widget: ${key.slice(0, 40)}.`);
  const out = await Promise.all(keys.map(async (key) => [key, await widgetData(workspaceId, key, n)]));
  return { days: n, widgets: Object.fromEntries(out) };
}

module.exports = { CATALOG, DEFAULT_WIDGETS, RANGES, listViews, createView, updateView, deleteView, data, cleanWidgets };
