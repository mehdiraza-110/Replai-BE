// System emails about orders, limits and trials. Everything here is best effort: nothing throws, nothing is awaited by
// the action that triggered it (callers use `fire`), and every message goes through email.service (SendGrid wrapper).
//
// De-duplication lives in workspace_email_notifications (workspace_id, key): `claim` inserts the key atomically, so
// two app instances (or two ticks) can never both send the same notice.
const db = require("../config/db.config");
const email = require("./email.service");

const { escapeHtml: esc, appUrl } = email;
const LIMIT_REACHED_WINDOW_HOURS = 24;
const LABELS = { ai_requests: "AI requests", domains: "Domains", mailboxes: "Mailboxes", emails: "Emails sent", workflows: "Workflows" };
const TYPE_LABELS = { domains: "Domains", mailboxes: "Mailboxes", limits: "More limits" };
const STATUS_TEXT = {
  approved: { subject: "approved", line: "has been approved. We are getting started on it." },
  in_progress: { subject: "in progress", line: "is now in progress. We are working on it." },
  fulfilled: { subject: "completed", line: "has been completed." },
  rejected: { subject: "declined", line: "has been declined." },
  cancelled: { subject: "cancelled", line: "has been cancelled." },
};

const pending = new Set();
const recentLimitClaims = new Map(); // in-process guard so a hot failing quota path does not hit the database each time

// Runs `fn` in the background; never throws; `flush()` lets tests wait for it.
function fire(fn) {
  const p = (async () => {
    try {
      await fn();
    } catch (error) {
      console.error("System email failed:", error.message);
    }
  })();
  pending.add(p);
  p.finally(() => pending.delete(p));
  return p;
}
async function flush() {
  while (pending.size) await Promise.all([...pending]);
}

const fmt = (n) => Number(n).toLocaleString("en-US");

async function workspaceInfo(workspaceId) {
  const { rows } = await db.query(`SELECT id, name, slug FROM workspaces WHERE id = $1`, [workspaceId]);
  return rows[0] || null;
}

// Owners and admins (or owners only) of one workspace. Only members of that workspace ever receive its emails.
async function managerEmails(workspaceId, roles = ["owner", "admin"]) {
  const { rows } = await db.query(
    `SELECT u.email FROM workspace_members m JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = $1 AND m.role = ANY($2::text[]) AND COALESCE(u.is_deleted, FALSE) = FALSE`,
    [workspaceId, roles],
  );
  return rows.map((r) => r.email);
}

async function superAdminEmails() {
  const { rows } = await db.query(`SELECT email FROM users WHERE is_super_admin = TRUE AND COALESCE(is_deleted, FALSE) = FALSE`);
  return rows.map((r) => r.email);
}

// Requester (if they still exist and belong to the workspace) plus the workspace owners.
async function requesterAndOwners(workspaceId, requesterId) {
  const list = await managerEmails(workspaceId, ["owner"]);
  if (requesterId) {
    const { rows } = await db.query(
      `SELECT u.email FROM workspace_members m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = $1 AND u.id = $2 AND COALESCE(u.is_deleted, FALSE) = FALSE`,
      [workspaceId, requesterId],
    );
    rows.forEach((r) => list.push(r.email));
  }
  return [...new Set(list.map((e) => e.toLowerCase()))];
}

// Claims a notification key for a workspace. Returns true when this caller should send. With windowHours the key can
// be claimed again once its previous claim is older than that; without it, a key is claimed once, ever.
async function claim(workspaceId, key, windowHours = null) {
  const sql = windowHours
    ? `INSERT INTO workspace_email_notifications (workspace_id, key) VALUES ($1, $2)
       ON CONFLICT (workspace_id, key) DO UPDATE SET sent_at = NOW()
       WHERE workspace_email_notifications.sent_at < NOW() - make_interval(hours => $3) RETURNING 1`
    : `INSERT INTO workspace_email_notifications (workspace_id, key) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1`;
  const { rows } = await db.query(sql, windowHours ? [workspaceId, key, windowHours] : [workspaceId, key]);
  return rows.length > 0;
}
async function release(workspaceId, key) {
  await db.query(`DELETE FROM workspace_email_notifications WHERE workspace_id = $1 AND key = $2`, [workspaceId, key]).catch(() => {});
}

// Claims `key`, sends, and gives the claim back when the send failed so a later run can retry.
async function sendOnce(workspaceId, key, windowHours, message) {
  if (!(await claim(workspaceId, key, windowHours))) return false;
  let result;
  try {
    result = await email.send(message);
  } catch (error) {
    await release(workspaceId, key);
    throw error;
  }
  if (!result || !result.ok) {
    await release(workspaceId, key);
    return false;
  }
  return true;
}

function describeOrder(order) {
  const d = order.details || {};
  if (order.type === "limits") {
    const label = LABELS[d.limitKey] || d.limitKey;
    return `${label}: raise the limit${d.currentLimit != null ? ` from ${fmt(d.currentLimit)}` : ""} to ${fmt(d.requestedLimit)}${d.period === "day" ? " per 24 hours" : ""}`;
  }
  const parts = [`${fmt(order.quantity)} ${order.type}`];
  if (d.mailboxesPerDomain) parts.push(`${d.mailboxesPerDomain} mailbox(es) per domain`);
  if (Array.isArray(d.preferredDomains) && d.preferredDomains.length) parts.push(`preferred domains: ${d.preferredDomains.slice(0, 10).join(", ")}`);
  return parts.join(", ");
}

const notesBlock = (notes) => (notes ? `<br><em>Note:</em> ${esc(notes).replace(/\n/g, "<br>")}` : "");

// ---- (a) new request -> every super admin ------------------------------------------------------------------------
async function orderCreated(order) {
  const ws = await workspaceInfo(order.workspace_id);
  const to = await superAdminEmails();
  if (!to.length) return;
  const wsName = ws ? ws.name : `Workspace ${order.workspace_id}`;
  const who = order.requested_by ? `${order.requested_by.name} (${order.requested_by.email})` : "a workspace member";
  const typeLabel = TYPE_LABELS[order.type] || order.type;
  const { html, text } = email.renderEmail({
    title: `New request: ${typeLabel} from ${wsName}`,
    preheader: `${wsName} requested ${describeOrder(order)}`,
    paragraphs: [
      `<strong>${esc(wsName)}</strong> sent a new <strong>${esc(typeLabel)}</strong> request.`,
      `${esc(describeOrder(order))}<br>Requested by ${esc(who)}.${notesBlock(order.details && order.details.notes)}`,
    ],
    cta: { label: "Review requests", url: appUrl("admin/orders") },
  });
  await email.send({ to, subject: `New ${typeLabel.toLowerCase()} request from ${wsName}`, html, text, category: "order_new" });
}

// ---- (b) status change / limits applied -> requester + owners -----------------------------------------------------
async function orderStatusChanged(order, status) {
  const t = STATUS_TEXT[status];
  if (!t) return;
  const ws = await workspaceInfo(order.workspace_id);
  const to = await requesterAndOwners(order.workspace_id, order.requested_by_id || (order.requested_by && order.requested_by.id));
  if (!to.length) return;
  const typeLabel = TYPE_LABELS[order.type] || order.type;
  const { html, text } = email.renderEmail({
    title: `Your ${typeLabel.toLowerCase()} request was ${t.subject}`,
    preheader: `${describeOrder(order)} ${t.line}`,
    paragraphs: [
      `Your request (${esc(describeOrder(order))}) for <strong>${esc(ws ? ws.name : "your workspace")}</strong> ${t.line}${notesBlock(order.admin_notes)}`,
    ],
    cta: { label: "View your requests", url: appUrl("mailer/orders") },
  });
  await email.send({ to, subject: `Your ${typeLabel.toLowerCase()} request was ${t.subject}`, html, text, category: "order_status" });
}

async function limitsApplied(order, from, to) {
  const ws = await workspaceInfo(order.workspace_id);
  const recipients = await requesterAndOwners(order.workspace_id, order.requested_by_id || (order.requested_by && order.requested_by.id));
  if (!recipients.length) return;
  const key = order.details && order.details.limitKey;
  const label = LABELS[key] || key;
  const per = order.details && order.details.period === "day" ? " per 24 hours" : "";
  const { html, text } = email.renderEmail({
    title: "Your limit was raised",
    preheader: `${label} is now ${fmt(to)}${per}`,
    paragraphs: [
      `Good news: the <strong>${esc(label)}</strong> limit for <strong>${esc(ws ? ws.name : "your workspace")}</strong> was raised from ${fmt(from)} to <strong>${fmt(to)}</strong>${per}.${notesBlock(order.admin_notes)}`,
    ],
    cta: { label: "Open dashboard", url: appUrl("mailer") },
  });
  await email.send({ to: recipients, subject: `Your ${label.toLowerCase()} limit was raised to ${fmt(to)}`, html, text, category: "order_limits_applied" });
}

// ---- (c) trial milestones -> owners and admins --------------------------------------------------------------------
async function trialMilestone(workspaceId, milestone, trialEndsAt) {
  // milestone: 7 | 3 | 1 (days before the end) or "ended"
  const key = milestone === "ended" ? "trial_ended" : `trial_ending_${milestone}`;
  const to = await managerEmails(workspaceId);
  if (!to.length) return false;
  const ws = await workspaceInfo(workspaceId);
  const name = ws ? ws.name : "your workspace";
  const ended = milestone === "ended";
  const when = trialEndsAt ? new Date(trialEndsAt).toUTCString().replace(/ GMT$/, " UTC") : "";
  const title = ended ? "Your trial has ended" : `Your trial ends in ${milestone} day${milestone === 1 ? "" : "s"}`;
  const { html, text } = email.renderEmail({
    title,
    preheader: ended ? `The trial of ${name} has ended.` : `The trial of ${name} ends ${when}.`,
    paragraphs: ended
      ? [`The trial of <strong>${esc(name)}</strong> has ended. Your data is safe. Contact us to continue using ReplyOS.`]
      : [`The trial of <strong>${esc(name)}</strong> ends on <strong>${esc(when)}</strong> (${milestone} day${milestone === 1 ? "" : "s"} from now).`, "Contact us before then if you want to keep going without interruption."],
    cta: { label: "Open ReplyOS", url: appUrl("mailer") },
  });
  return sendOnce(workspaceId, key, null, { to, subject: title, html, text, category: "trial" });
}

// ---- (d) limit reached -> owners and admins, once per limit per 24 hours ------------------------------------------
async function limitReached(workspaceId, kind, lim, resetsAt) {
  const memoKey = `${workspaceId}:${kind}`;
  const last = recentLimitClaims.get(memoKey);
  if (last && Date.now() - last < 10 * 60 * 1000) return false;
  recentLimitClaims.set(memoKey, Date.now());
  if (recentLimitClaims.size > 5000) recentLimitClaims.clear();
  const to = await managerEmails(workspaceId);
  if (!to.length) return false;
  const ws = await workspaceInfo(workspaceId);
  const name = ws ? ws.name : "your workspace";
  const label = LABELS[kind] || kind;
  const day = lim.period === "day";
  let resetLine = "";
  if (day) {
    const mins = resetsAt ? Math.max(1, Math.ceil((new Date(resetsAt).getTime() - Date.now()) / 60000)) : null;
    resetLine = mins
      ? ` It frees up again in about ${mins < 60 ? `${mins} minute${mins === 1 ? "" : "s"}` : `${Math.ceil(mins / 60)} hour${Math.ceil(mins / 60) === 1 ? "" : "s"}`}.`
      : " It is a rolling 24-hour limit and frees up as older usage ages out.";
  }
  const { html, text } = email.renderEmail({
    title: "Trial limit reached",
    preheader: `${label}: ${fmt(lim.limit)}${day ? " per 24 hours" : " in total"}`,
    paragraphs: [
      `<strong>${esc(name)}</strong> reached its limit for <strong>${esc(label)}</strong>: ${fmt(lim.limit)}${day ? " per 24 hours" : " in total"}.${esc(resetLine)}`,
      "You can ask for a higher limit from the Orders page.",
    ],
    cta: { label: "Request more", url: appUrl(`mailer/orders?request=limits&key=${encodeURIComponent(kind)}`) },
  });
  return sendOnce(workspaceId, `limit_reached:${kind}`, LIMIT_REACHED_WINDOW_HOURS, {
    to, subject: `Limit reached: ${label}`, html, text, category: "limit_reached",
  });
}

module.exports = {
  fire,
  flush,
  claim,
  managerEmails,
  superAdminEmails,
  orderCreated,
  orderStatusChanged,
  limitsApplied,
  trialMilestone,
  limitReached,
  _resetCache: () => recentLimitClaims.clear(),
};
