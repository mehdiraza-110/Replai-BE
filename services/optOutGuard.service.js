const db = require("../config/db.config");

// Cold Email Agent setting: workspace_settings.cold_email.optOutFooter = { enabled, disabledAt, autoEnabledAt, autoReason }.
// No saved value means enabled (the behaviour every workspace had before this became a setting).
//
// A workspace that switched the footer off gets it switched back on automatically when its recent sending looks bad.
// The thresholds are the "wrong" tier of the warm-up safety tiers (warmup.service.js), measured on this workspace's own
// real (non-warm-up) first emails.
const WINDOW_DAYS = 7;
const MIN_SENDS = 100;
const BOUNCE_RATE = 0.05;
const COMPLAINT_RATE = 0.001;

async function isFooterEnabled(workspaceId) {
  const { rows } = await db.query(`SELECT cold_email->'optOutFooter'->>'enabled' AS enabled FROM workspace_settings WHERE workspace_id = $1`, [workspaceId]);
  return rows[0]?.enabled !== "false";
}

/** Sends, hard bounces and complaints since `since` (never earlier than the 7-day window). */
async function recentStats(workspaceId, since) {
  const { rows } = await db.query(
    `WITH w AS (SELECT GREATEST(NOW() - make_interval(days => $2), COALESCE($3::timestamptz, '-infinity'::timestamptz)) AS since)
     SELECT
       (SELECT COUNT(*)::int FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id, w
         WHERE cl.workspace_id = $1 AND cl.sent_at >= w.since AND COALESCE(c.is_warmup, FALSE) = FALSE) AS sent,
       (SELECT COUNT(*)::int FROM suppressions s LEFT JOIN campaigns c ON c.id = s.campaign_id, w
         WHERE s.workspace_id = $1 AND s.reason = 'hard_bounce' AND s.created_at >= w.since AND COALESCE(c.is_warmup, FALSE) = FALSE) AS bounced,
       (SELECT COUNT(*)::int FROM suppressions s LEFT JOIN campaigns c ON c.id = s.campaign_id, w
         WHERE s.workspace_id = $1 AND s.reason = 'complained' AND s.created_at >= w.since AND COALESCE(c.is_warmup, FALSE) = FALSE) AS complained`,
    [workspaceId, WINDOW_DAYS, since || null]
  );
  return rows[0];
}

/** Returns a plain-English reason when the numbers are bad enough to need the footer, else null. */
function breach({ sent, bounced, complained }) {
  if (sent < MIN_SENDS) return null;
  if (complained / sent > COMPLAINT_RATE) return `${complained} spam complaint${complained === 1 ? "" : "s"} in ${sent} emails (${((complained / sent) * 100).toFixed(2)}%)`;
  if (bounced / sent > BOUNCE_RATE) return `${bounced} hard bounces in ${sent} emails (${((bounced / sent) * 100).toFixed(1)}%)`;
  return null;
}

/** Checks one workspace whose footer is off and turns it back on if its sending has gone bad. Returns the reason, or null. */
async function evaluateWorkspace(workspaceId) {
  const { rows } = await db.query(`SELECT cold_email->'optOutFooter' AS footer FROM workspace_settings WHERE workspace_id = $1`, [workspaceId]);
  const footer = rows[0]?.footer;
  if (!footer || footer.enabled !== false) return null;

  // Only look at what happened since the owner last switched it off, so turning it off again is not instantly undone by old numbers.
  const reason = breach(await recentStats(workspaceId, footer.disabledAt));
  if (!reason) return null;

  const next = { enabled: true, disabledAt: footer.disabledAt || null, autoEnabledAt: new Date().toISOString(), autoReason: reason };
  const { rowCount } = await db.query(
    `UPDATE workspace_settings SET cold_email = jsonb_set(cold_email, '{optOutFooter}', $2::jsonb, TRUE), updated_at = NOW()
     WHERE workspace_id = $1 AND cold_email->'optOutFooter'->>'enabled' = 'false'`,
    [workspaceId, JSON.stringify(next)]
  );
  if (!rowCount) return null;
  await db.query(
    `INSERT INTO settings_audit (workspace_id, user_id, area, summary) VALUES ($1, NULL, 'cold_email', $2)`,
    [workspaceId, `Opt-out line turned back on automatically: ${reason}`.slice(0, 500)]
  );
  console.warn(`Workspace ${workspaceId}: opt-out line re-enabled automatically (${reason})`);
  return reason;
}

async function runTick() {
  const { rows } = await db.query(`SELECT workspace_id FROM workspace_settings WHERE cold_email->'optOutFooter'->>'enabled' = 'false'`);
  const turnedOn = [];
  for (const row of rows) {
    try {
      if (await evaluateWorkspace(row.workspace_id)) turnedOn.push(row.workspace_id);
    } catch (error) {
      console.error(`Opt-out guard failed for workspace ${row.workspace_id}:`, error.message);
    }
  }
  return { checked: rows.length, turnedOn };
}

module.exports = { isFooterEnabled, evaluateWorkspace, runTick, breach, WINDOW_DAYS, MIN_SENDS, BOUNCE_RATE, COMPLAINT_RATE };
