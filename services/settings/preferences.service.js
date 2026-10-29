const db = require("../../config/db.config");

const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v, max) => String(v ?? "").trim().slice(0, max);
const bool = (v, field) => { if (typeof v !== "boolean") throw bad(`${field} must be on or off.`); return v; };
const hhmm = (v, field) => { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v))) throw bad(`${field} must be a time like 09:30.`); return String(v); };
const zone = (v) => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: String(v) }); return String(v); } catch { throw bad("That time zone isn't recognised."); }
};
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

// ---- Personal preferences (one row per user) ------------------------------------------------------------------
const SOUNDS = { ringtone: ["classic", "soft", "bright", "off"], message: ["chime", "pop", "off"], escalation: ["alert", "double", "off"], positive: ["success", "sparkle", "off"] };
const THEMES = ["light", "dark", "system"];

const NOTIFICATION_DEFAULTS = {
  desktop: false,
  sounds: { enabled: true, ringtone: "classic", message: "chime", escalation: "alert", positive: "success" },
  interrupts: { calls: true, textReplies: true, escalations: true, positiveReplies: true, paymentProblems: true },
  quiet: { enabled: false, from: "22:00", to: "08:00", timezone: "UTC" },
};
const APPEARANCE_DEFAULTS = { theme: "system", sidebar: { hidden: [], groupNames: {}, order: {} } };
// Pages that can never be hidden, so nobody loses the way back to Settings.
const ALWAYS_VISIBLE = ["settings/profile", "dashboard"];

// Fills in defaults key by key. A default of {} means a free-form map (group names, page order), so saved keys are kept as they are.
const merge = (defaults, saved) => {
  const out = {};
  for (const [k, v] of Object.entries(defaults)) {
    if (isObj(v) && Object.keys(v).length === 0) out[k] = isObj(saved?.[k]) ? saved[k] : {};
    else out[k] = isObj(v) ? merge(v, isObj(saved?.[k]) ? saved[k] : {}) : saved?.[k] !== undefined ? saved[k] : v;
  }
  return out;
};

function cleanNotifications(input, current) {
  if (!isObj(input)) throw bad("Notification settings must be an object.");
  const next = JSON.parse(JSON.stringify(current));
  if (input.desktop !== undefined) next.desktop = bool(input.desktop, "Desktop notifications");
  if (input.sounds !== undefined) {
    if (!isObj(input.sounds)) throw bad("Sound settings must be an object.");
    if (input.sounds.enabled !== undefined) next.sounds.enabled = bool(input.sounds.enabled, "Sounds");
    for (const [key, allowed] of Object.entries(SOUNDS)) {
      if (input.sounds[key] === undefined) continue;
      if (!allowed.includes(input.sounds[key])) throw bad(`Pick one of: ${allowed.join(", ")}.`);
      next.sounds[key] = input.sounds[key];
    }
  }
  if (input.interrupts !== undefined) {
    if (!isObj(input.interrupts)) throw bad("Interruption settings must be an object.");
    for (const key of Object.keys(NOTIFICATION_DEFAULTS.interrupts)) if (input.interrupts[key] !== undefined) next.interrupts[key] = bool(input.interrupts[key], key);
  }
  if (input.quiet !== undefined) {
    if (!isObj(input.quiet)) throw bad("Quiet hours must be an object.");
    const q = input.quiet;
    if (q.enabled !== undefined) next.quiet.enabled = bool(q.enabled, "Quiet hours");
    if (q.from !== undefined) next.quiet.from = hhmm(q.from, "Quiet hours start");
    if (q.to !== undefined) next.quiet.to = hhmm(q.to, "Quiet hours end");
    if (q.timezone !== undefined) next.quiet.timezone = zone(q.timezone);
    if (next.quiet.enabled && next.quiet.from === next.quiet.to) throw bad("Quiet hours can't start and end at the same time.");
  }
  return next;
}

function cleanAppearance(input, current) {
  if (!isObj(input)) throw bad("Appearance settings must be an object.");
  const next = JSON.parse(JSON.stringify(current));
  if (input.theme !== undefined) { if (!THEMES.includes(input.theme)) throw bad("Theme must be light, dark or system."); next.theme = input.theme; }
  if (input.sidebar !== undefined) {
    const s = input.sidebar;
    if (!isObj(s)) throw bad("Sidebar settings must be an object.");
    if (s.hidden !== undefined) {
      if (!Array.isArray(s.hidden) || s.hidden.length > 60) throw bad("Hidden pages must be a short list.");
      const hidden = [...new Set(s.hidden.map((p) => str(p, 80)))].filter(Boolean);
      if (hidden.some((p) => ALWAYS_VISIBLE.includes(p))) throw bad("The Dashboard and Settings can't be hidden.");
      next.sidebar.hidden = hidden;
    }
    if (s.groupNames !== undefined) {
      if (!isObj(s.groupNames) || Object.keys(s.groupNames).length > 20) throw bad("Group names must be a short list.");
      next.sidebar.groupNames = Object.fromEntries(Object.entries(s.groupNames).map(([k, v]) => [str(k, 40), str(v, 40)]).filter(([k, v]) => k && v));
    }
    if (s.order !== undefined) {
      if (!isObj(s.order) || Object.keys(s.order).length > 20) throw bad("Page order must be a short list.");
      next.sidebar.order = Object.fromEntries(Object.entries(s.order).map(([k, v]) => {
        if (!Array.isArray(v) || v.length > 40) throw bad("Page order must be a list of pages.");
        return [str(k, 40), [...new Set(v.map((p) => str(p, 80)).filter(Boolean))]];
      }));
    }
  }
  return next;
}

async function getPreferences(userId) {
  const { rows } = await db.query(`SELECT notifications, appearance FROM user_preferences WHERE user_id = $1`, [userId]);
  return { notifications: merge(NOTIFICATION_DEFAULTS, rows[0]?.notifications), appearance: merge(APPEARANCE_DEFAULTS, rows[0]?.appearance), soundOptions: SOUNDS };
}

async function updatePreferences(userId, body = {}) {
  if (body.notifications === undefined && body.appearance === undefined) throw bad("Nothing to update.");
  const current = await getPreferences(userId);
  const notifications = body.notifications !== undefined ? cleanNotifications(body.notifications, current.notifications) : current.notifications;
  const appearance = body.appearance !== undefined ? cleanAppearance(body.appearance, current.appearance) : current.appearance;
  await db.query(
    `INSERT INTO user_preferences (user_id, notifications, appearance) VALUES ($1, $2::jsonb, $3::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET notifications = EXCLUDED.notifications, appearance = EXCLUDED.appearance, updated_at = NOW()`,
    [userId, JSON.stringify(notifications), JSON.stringify(appearance)]
  );
  return { notifications, appearance, soundOptions: SOUNDS };
}

// ---- Workspace settings (one row per workspace; owner/admin write) ---------------------------------------------
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const ANALYZER_TYPES = ["discovery", "interview", "sales", "podcast", "coaching"];
const LANGUAGES = ["en-US", "en-GB", "en-AU"];

const WORKSPACE_DEFAULTS = {
  color: "#2d6fa1",
  conferencing: { type: "google_meet", staticUrl: "" },
  sharing: { communication: false },
  coldEmail: { schedule: { from: "09:00", to: "17:00", timezone: "America/New_York", days: ["Mon", "Tue", "Wed", "Thu", "Fri"] } },
  callAnalyzer: { language: "en-US", frameworks: Object.fromEntries(ANALYZER_TYPES.map((t) => [t, ""])) },
};

async function audit(workspaceId, userId, area, summary) {
  await db.query(`INSERT INTO settings_audit (workspace_id, user_id, area, summary) VALUES ($1,$2,$3,$4)`, [workspaceId, userId, area, summary.slice(0, 500)]);
}

async function getWorkspaceSettings(workspaceId) {
  const { rows } = await db.query(`SELECT color, conferencing, sharing, cold_email, call_analyzer FROM workspace_settings WHERE workspace_id = $1`, [workspaceId]);
  const r = rows[0] || {};
  return {
    color: r.color || WORKSPACE_DEFAULTS.color,
    colorConfigured: Boolean(r.color),
    conferencing: merge(WORKSPACE_DEFAULTS.conferencing, r.conferencing),
    sharing: merge(WORKSPACE_DEFAULTS.sharing, r.sharing),
    coldEmail: merge(WORKSPACE_DEFAULTS.coldEmail, r.cold_email),
    callAnalyzer: merge(WORKSPACE_DEFAULTS.callAnalyzer, r.call_analyzer),
    // False until someone saves a schedule, so new campaigns keep using the browser's time zone until then.
    coldEmailConfigured: isObj(r.cold_email) && Object.keys(r.cold_email).length > 0,
    weekdays: WEEKDAYS,
  };
}

function httpsUrl(value) {
  const text = str(value, 500);
  let url;
  try { url = new URL(text); } catch { throw bad("Enter a full link that starts with https://."); }
  if (url.protocol !== "https:") throw bad("The meeting link must start with https://.");
  return url.toString();
}

async function updateWorkspaceSettings(workspaceId, userId, body = {}) {
  const current = await getWorkspaceSettings(workspaceId);
  const next = JSON.parse(JSON.stringify(current));
  const changes = [];
  if (body.color !== undefined) {
    if (!/^#[0-9a-f]{6}$/i.test(String(body.color))) throw bad("Pick a colour like #2d6fa1.");
    next.color = String(body.color).toLowerCase();
  }
  if (body.conferencing !== undefined) {
    const c = body.conferencing;
    if (!isObj(c)) throw bad("Conferencing settings must be an object.");
    if (c.type !== undefined) { if (!["google_meet", "static"].includes(c.type)) throw bad("Meeting links are either generated by Google Meet or one fixed link."); next.conferencing.type = c.type; }
    if (c.staticUrl !== undefined) next.conferencing.staticUrl = c.staticUrl === "" ? "" : httpsUrl(c.staticUrl);
    if (next.conferencing.type === "static" && !next.conferencing.staticUrl) throw bad("Add the link to use for every meeting.");
    if (JSON.stringify(next.conferencing) !== JSON.stringify(current.conferencing)) changes.push(["conferencing", next.conferencing.type === "static" ? "Switched meetings to one fixed link" : "Switched meetings to Google Meet links"]);
  }
  if (body.sharing !== undefined) {
    if (!isObj(body.sharing)) throw bad("Sharing settings must be an object.");
    if (body.sharing.communication !== undefined) next.sharing.communication = bool(body.sharing.communication, "Communication sharing");
    if (next.sharing.communication !== current.sharing.communication) changes.push(["sharing", next.sharing.communication ? "Turned communication sharing on" : "Turned communication sharing off"]);
  }
  if (body.coldEmail !== undefined) {
    const s = body.coldEmail?.schedule;
    if (!isObj(body.coldEmail) || !isObj(s)) throw bad("Send a default schedule.");
    if (s.from !== undefined) next.coldEmail.schedule.from = hhmm(s.from, "Start time");
    if (s.to !== undefined) next.coldEmail.schedule.to = hhmm(s.to, "End time");
    if (s.timezone !== undefined) next.coldEmail.schedule.timezone = zone(s.timezone);
    if (s.days !== undefined) {
      if (!Array.isArray(s.days) || s.days.some((d) => !WEEKDAYS.includes(d))) throw bad("Days must be Mon to Sun.");
      next.coldEmail.schedule.days = WEEKDAYS.filter((d) => s.days.includes(d));
    }
    if (next.coldEmail.schedule.from >= next.coldEmail.schedule.to) throw bad("The sending window must end after it starts.");
    if (!next.coldEmail.schedule.days.length) throw bad("Pick at least one sending day.");
  }
  if (body.callAnalyzer !== undefined) {
    const a = body.callAnalyzer;
    if (!isObj(a)) throw bad("Call analyzer settings must be an object.");
    if (a.language !== undefined) { if (!LANGUAGES.includes(a.language)) throw bad("Pick English (US), (UK) or (AU)."); next.callAnalyzer.language = a.language; }
    if (a.frameworks !== undefined) {
      if (!isObj(a.frameworks)) throw bad("Frameworks must be an object.");
      for (const [type, text] of Object.entries(a.frameworks)) {
        if (!ANALYZER_TYPES.includes(type)) throw bad(`Unknown call type: ${str(type, 30)}.`);
        next.callAnalyzer.frameworks[type] = str(text, 6000);
      }
    }
  }
  await db.query(
    `INSERT INTO workspace_settings (workspace_id, color, conferencing, sharing, cold_email, call_analyzer) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb)
     ON CONFLICT (workspace_id) DO UPDATE SET color = EXCLUDED.color, conferencing = EXCLUDED.conferencing, sharing = EXCLUDED.sharing, cold_email = EXCLUDED.cold_email, call_analyzer = EXCLUDED.call_analyzer, updated_at = NOW()`,
    [workspaceId, next.color, JSON.stringify(next.conferencing), JSON.stringify(next.sharing), JSON.stringify(next.coldEmail), JSON.stringify(next.callAnalyzer)]
  );
  for (const [area, summary] of changes) await audit(workspaceId, userId, area, summary);
  return getWorkspaceSettings(workspaceId);
}

async function listAudit(workspaceId, area) {
  const { rows } = await db.query(
    `SELECT a.id, a.summary, a.created_at, NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') AS who, u.email
     FROM settings_audit a LEFT JOIN users u ON u.id = a.user_id WHERE a.workspace_id = $1 AND a.area = $2 ORDER BY a.id DESC LIMIT 50`,
    [workspaceId, str(area, 40)]
  );
  return rows.map((r) => ({ id: Number(r.id), summary: r.summary, at: r.created_at, who: r.who || r.email || "Someone" }));
}

module.exports = { getPreferences, updatePreferences, getWorkspaceSettings, updateWorkspaceSettings, listAudit, audit, NOTIFICATION_DEFAULTS, APPEARANCE_DEFAULTS, WORKSPACE_DEFAULTS, ANALYZER_TYPES };
