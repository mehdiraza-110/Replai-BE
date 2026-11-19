// Alerts for a positive lead: email + SMS + in-app, once per lead.
//
// Who is told:
//   1. The people routed to the brand (campaign name pattern) in lead_alert_routes.
//   2. The copy-all people (lead_alert_routes with no pattern, plus GLOBAL_LEAD_ALERT_EMAILS) for every brand.
//   An address with no account still gets the email; one with an account also gets SMS (users.phone) and the push.
//
// Everything is best effort: this never throws and never blocks the reply pipeline that calls it.
const db = require("../config/db.config");
const emailService = require("./email.service");
const smsService = require("./sms.service");
const realtime = require("./realtime.service");
const eventLog = require("./eventLog.service");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function globalEmails() {
  return String(process.env.GLOBAL_LEAD_ALERT_EMAILS || "")
    .split(/[,;\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => EMAIL_RE.test(e));
}

/**
 * Returns [{ email, userId|null, phone|null, global }] with one entry per address.
 * Recipients come only from lead_alert_routes: the people set for this brand (campaign name) plus the rows with
 * no pattern, who get a copy of every brand (Chris). Workspace owners/admins are NOT alerted anymore.
 * GLOBAL_LEAD_ALERT_EMAILS still adds copy-all addresses.
 */
async function recipientsFor(campaignName) {
  const byEmail = new Map();
  const add = (row, isGlobal) => {
    const email = String(row.email).toLowerCase();
    const existing = byEmail.get(email);
    if (existing) { existing.global = existing.global || isGlobal; return; }
    byEmail.set(email, { email, userId: row.id ?? null, phone: row.phone || null, global: isGlobal });
  };

  const routes = await db.query(
    `SELECT r.email, r.campaign_pattern, u.id, u.phone
       FROM lead_alert_routes r
       LEFT JOIN users u ON LOWER(u.email) = LOWER(r.email) AND COALESCE(u.is_deleted, FALSE) = FALSE
      WHERE r.campaign_pattern IS NULL OR ($1::text IS NOT NULL AND $1 ILIKE r.campaign_pattern)`,
    [campaignName || null],
  );
  for (const r of routes.rows) if (EMAIL_RE.test(String(r.email || ""))) add(r, r.campaign_pattern == null);

  const extra = globalEmails();
  if (extra.length) {
    const found = await db.query(
      `SELECT id, email, phone FROM users WHERE LOWER(email) = ANY($1) AND COALESCE(is_deleted, FALSE) = FALSE`,
      [extra],
    );
    const known = new Set(found.rows.map((r) => r.email.toLowerCase()));
    for (const r of found.rows) add(r, true);
    for (const email of extra) if (!known.has(email)) add({ email }, true);
  }
  return [...byEmail.values()];
}

/** Claims the right to alert for this lead. False when this lead was already announced (or the claim failed). */
async function claim(workspaceId, leadKey) {
  const key = `positive_lead:${String(leadKey).slice(0, 100)}`;
  const { rowCount } = await db.query(
    `INSERT INTO workspace_email_notifications (workspace_id, key) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [workspaceId, key],
  );
  return rowCount > 0;
}

/**
 * @param {object} p
 * @param {number} p.workspaceId  app tenant id
 * @param {string} p.leadKey      stable id of the lead/thread, so a lead is announced once
 * @param {string} [p.leadName]
 * @param {string} p.leadEmail
 * @param {string} [p.subject]
 * @param {string} [p.reply]      what the lead wrote (shown trimmed)
 * @param {string} [p.campaignName]
 * @param {string} [p.source]     "native" | "plusvibe"
 */
async function notifyPositiveLead(p) {
  try {
    const workspaceId = p.workspaceId;
    if (!workspaceId || !p.leadKey) return { notified: false, reason: "missing_ids" };
    if (!(await claim(workspaceId, p.leadKey))) return { notified: false, reason: "already_notified" };

    const ws = await db.query(`SELECT name FROM workspaces WHERE id = $1`, [workspaceId]);
    const workspaceName = ws.rows[0]?.name || `Workspace ${workspaceId}`;
    const who = p.leadName && p.leadName !== p.leadEmail ? `${p.leadName} (${p.leadEmail})` : p.leadEmail;
    const preview = String(p.reply || "").replace(/\s+/g, " ").trim().slice(0, 300);
    const link = emailService.appUrl("inbox");

    // Platform notification (the bell in the workspace) + live push to everyone in that workspace.
    await eventLog.record({
      eventType: "lead.positive",
      source: p.source || "system",
      appWorkspaceId: workspaceId,
      workspaceName,
      campaignName: p.campaignName || null,
      leadEmail: p.leadEmail,
      threadId: String(p.leadKey).slice(0, 200),
      metadata: { leadName: p.leadName || null, preview },
    });

    const recipients = await recipientsFor(p.campaignName);
    const subject = `Positive lead in ${workspaceName}: ${p.leadName || p.leadEmail}`.slice(0, 200);
    const paragraphs = [
      `<strong>${emailService.escapeHtml(who)}</strong> replied positively${p.campaignName ? ` to <strong>${emailService.escapeHtml(p.campaignName)}</strong>` : ""} in <strong>${emailService.escapeHtml(workspaceName)}</strong>.`,
    ];
    if (p.subject) paragraphs.push(`Subject: ${emailService.escapeHtml(p.subject)}`);
    if (preview) paragraphs.push(`<em>${emailService.escapeHtml(preview)}</em>`);
    const { html } = emailService.renderEmail({ title: "New positive lead", preheader: subject, paragraphs, cta: { label: "Open the conversation", url: link } });
    const text = [`${who} replied positively${p.campaignName ? ` to ${p.campaignName}` : ""} in ${workspaceName}.`, p.subject ? `Subject: ${p.subject}` : "", preview ? `"${preview}"` : "", link].filter(Boolean).join("\n\n");
    const smsBody = `SendVybe: positive lead in ${workspaceName} - ${p.leadName || p.leadEmail}${p.campaignName ? ` (${p.campaignName})` : ""}. ${link}`;

    const result = { emailed: 0, texted: 0, pushed: 0 };
    for (const r of recipients) {
      // Per recipient so one bad address or number never hides the lead from the others.
      const mail = await emailService.send({ to: r.email, subject, text, html, category: "positive_lead" });
      if (mail.ok) result.emailed += 1;
      if (r.phone) {
        const sms = await smsService.send({ to: r.phone, body: smsBody });
        if (sms.ok) result.texted += 1;
      }
      if (r.userId) {
        realtime.emitToUser(r.userId, "lead:positive", { workspaceId, workspaceName, leadName: p.leadName || null, leadEmail: p.leadEmail, campaignName: p.campaignName || null });
        result.pushed += 1;
      }
    }
    return { notified: true, recipients: recipients.length, ...result };
  } catch (error) {
    console.error("Positive-lead alert failed:", error.message);
    return { notified: false, reason: "error", error: error.message };
  }
}

const POSITIVE_EVENTS = new Set(["ALL_POSITIVE_REPLIES", "LEAD_MARKED_AS_INTERESTED", "LEAD_INTERESTED", "LEAD_MEETING_BOOKED"]);
const POSITIVE_LABELS = new Set(["INTERESTED", "MEETING_REQUEST", "MEETING_BOOKED", "QUESTION"]);

/** True when a PlusVibe webhook payload says the lead replied positively. */
function isPositivePlusVibe(payload = {}) {
  const norm = (v) => String(v || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  return POSITIVE_EVENTS.has(norm(payload.webhook_event)) || POSITIVE_LABELS.has(norm(payload.label ?? payload.data?.label));
}

/** Announces a positive PlusVibe reply. Never throws. */
async function notifyPlusVibePositive(appWorkspaceId, payload = {}) {
  if (!isPositivePlusVibe(payload)) return { notified: false, reason: "not_positive" };
  const email = String(payload.email ?? payload.lead_email ?? "").trim().toLowerCase();
  if (!email) return { notified: false, reason: "no_lead" };
  const name = [payload.first_name, payload.last_name].filter(Boolean).join(" ").trim() || payload.lead_name || null;
  let campaignName = payload.campaign_name || null;
  const campaignId = payload.campaign_id ?? payload.camp_id;
  if (!campaignName && campaignId) {
    try {
      const { rows } = await db.query(`SELECT name FROM plusvibe_campaigns WHERE plusvibe_campaign_id = $1 AND workspace_id = $2 LIMIT 1`, [String(campaignId), appWorkspaceId]);
      campaignName = rows[0]?.name || null;
    } catch (_) { /* best effort */ }
  }
  return notifyPositiveLead({
    workspaceId: appWorkspaceId,
    leadKey: `plusvibe:${email}`,
    leadName: name,
    leadEmail: email,
    subject: payload.subject,
    reply: payload.text_body || payload.body || payload.reply || "",
    campaignName,
    source: "plusvibe",
  });
}

module.exports = { notifyPlusVibePositive, isPositivePlusVibe, notifyPositiveLead, recipientsFor, globalEmails };
