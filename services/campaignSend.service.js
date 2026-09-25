const crypto = require("crypto");
const { SESv2Client, SendEmailCommand } = require("@aws-sdk/client-sesv2");
const db = require("../config/db.config");
const suppressionService = require("./suppression.service");

const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const sesClient = new SESv2Client({ region: AWS_REGION });

// How many leads a single mailbox may send in one tick. Kept deliberately small so a
// mailbox's daily_limit is spread across the whole sending window instead of bursting —
// the cron in index.js should run this every few minutes.
const MAX_SENDS_PER_MAILBOX_PER_TICK = 1;
const MAX_SEND_ATTEMPTS = 5;

class CampaignSendService {
  /**
   * Entry point for the send cron. Finds every Active campaign currently inside its
   * configured sending window/day, and for each one sends up to a small batch of
   * pending leads through the mailboxes assigned to that campaign.
   */
  async runTick() {
    const { rows: campaigns } = await db.query(
      `SELECT * FROM campaigns WHERE status = 'Active' AND is_deleted = FALSE`
    );

    const results = [];
    for (const campaign of campaigns) {
      if (!isWithinSendingWindow(campaign)) continue;
      try {
        results.push(await this.tickCampaign(campaign));
      } catch (error) {
        results.push({ campaignId: campaign.id, error: error.message });
      }
    }
    return results;
  }

  async tickCampaign(campaign) {
    const mailboxes = await this.getSendableMailboxes(campaign);
    if (mailboxes.length === 0) {
      return { campaignId: campaign.id, sent: 0, reason: "no_sendable_mailboxes" };
    }

    let sentCount = 0;
    for (const mailbox of mailboxes) {
      // Warmup sends draw from the permanent warmup-lane allowance (daily_limit/sent_today);
      // real campaigns draw from the separate market-lane allowance, which only unlocks once
      // a mailbox finishes ramping. See warmup.service.js tickMailbox.
      const remainingCapacity = campaign.is_warmup
        ? mailbox.daily_limit - mailbox.sent_today
        : mailbox.market_daily_limit - mailbox.market_sent_today;
      const batchSize = Math.max(0, Math.min(MAX_SENDS_PER_MAILBOX_PER_TICK, remainingCapacity));
      if (batchSize === 0) continue;

      const leads = await this.getPendingLeads(campaign.id, batchSize);
      for (const lead of leads) {
        const outcome = await this.sendToLead(campaign, mailbox, lead);
        if (outcome.sent) sentCount += 1;
      }
    }

    return { campaignId: campaign.id, sent: sentCount };
  }

  async getSendableMailboxes(campaign) {
    const mode = campaign.mailbox_mode === "specific" ? "specific" : "all";
    const params = [];
    let mailboxFilter = "";
    if (mode === "specific") {
      params.push(campaign.mailbox_ids);
      mailboxFilter = `AND m.id = ANY($${params.length}::int[])`;
    }

    const capacityFilter = campaign.is_warmup
      ? "m.sent_today < m.daily_limit"
      : "m.market_daily_limit > 0 AND m.market_sent_today < m.market_daily_limit";

    const { rows } = await db.query(
      `SELECT m.*, d.status AS domain_status, d.configuration_set_name
       FROM mailboxes m
       JOIN domains d ON d.id = m.domain_id AND d.is_deleted = FALSE
       WHERE m.is_deleted = FALSE
         AND m.status = 'Active'
         AND d.status = 'Verified'
         AND ${capacityFilter}
         ${mailboxFilter}
       ORDER BY m.sent_today ASC, m.id ASC`,
      params
    );
    return rows;
  }

  async getPendingLeads(campaignId, limit) {
    const { rows } = await db.query(
      `SELECT * FROM campaign_leads
       WHERE campaign_id = $1 AND status = 'Pending' AND send_attempts < $2
       ORDER BY id ASC
       LIMIT $3`,
      [campaignId, MAX_SEND_ATTEMPTS, limit]
    );
    return rows;
  }

  async sendToLead(campaign, mailbox, lead) {
    // Belt-and-suspenders: campaign creation already filters known suppressions at
    // import time, but a lead could opt out (or a new bounce/complaint land) any time
    // between then and now — re-check immediately before every send.
    if (await suppressionService.isSuppressed(lead.email)) {
      await db.query(`UPDATE campaign_leads SET status = 'Suppressed' WHERE id = $1`, [lead.id]);
      return { sent: false, reason: "suppressed" };
    }

    const subject = personalize(campaign.subject, lead);
    const body = personalize(campaign.body, lead);
    const listUnsubscribeHeaders = suppressionService.buildListUnsubscribeHeaders({ email: lead.email, campaignId: campaign.id });
    const fromAddress = mailbox.display_name ? `"${escapeHeaderValue(mailbox.display_name)}" <${mailbox.email}>` : mailbox.email;

    const { raw, messageId: rfcMessageId } = buildRawMimeMessage({
      from: fromAddress,
      to: lead.email,
      subject,
      body,
      extraHeaders: listUnsubscribeHeaders,
    });

    try {
      const command = new SendEmailCommand({
        FromEmailAddress: fromAddress,
        Destination: { ToAddresses: [lead.email] },
        Content: { Raw: { Data: raw } },
        ConfigurationSetName: mailbox.configuration_set_name || undefined,
        // Tags come back on bounce/complaint SNS events so sesBounceComplaint.service.js
        // can attribute them to the right campaign for suppression/audit purposes.
        EmailTags: [{ Name: "campaign_id", Value: String(campaign.id) }],
      });
      const response = await sesClient.send(command);

      await db.query(
        `UPDATE campaign_leads SET status = 'Sent', sent_at = NOW(), mailbox_id = $2, ses_message_id = $3, rfc_message_id = $4
         WHERE id = $1`,
        [lead.id, mailbox.id, response.MessageId || null, rfcMessageId]
      );
      await db.query(
        campaign.is_warmup
          ? `UPDATE mailboxes SET sent_today = sent_today + 1, last_sent_at = NOW(), updated_at = NOW() WHERE id = $1`
          : `UPDATE mailboxes SET market_sent_today = market_sent_today + 1, last_sent_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [mailbox.id]
      );
      await db.query(
        `UPDATE campaigns SET sent_today = sent_today + 1, sent_total = sent_total + 1, updated_at = NOW() WHERE id = $1`,
        [campaign.id]
      );
      // Record the send in the mailbox's app-native inbox too, so the "open inbox" view
      // shows the full thread (what we sent + any reply), not just replies.
      await db.query(
        `INSERT INTO messages (mailbox_id, direction, campaign_id, campaign_lead_id, thread_id, message_id, from_address, to_address, subject, body_text)
         VALUES ($1, 'outbound', $2, $3, $4, $5, $6, $7, $8, $9)`,
        [mailbox.id, campaign.id, lead.id, threadIdFor(mailbox.id, lead.email), rfcMessageId, mailbox.email, lead.email, subject, body]
      );

      return { sent: true };
    } catch (error) {
      const attempts = lead.send_attempts + 1;
      const status = attempts >= MAX_SEND_ATTEMPTS ? "Failed" : "Pending";
      await db.query(
        `UPDATE campaign_leads SET status = $2, send_attempts = $3, last_error = $4 WHERE id = $1`,
        [lead.id, status, attempts, error.message || String(error)]
      );
      return { sent: false, reason: "send_error", error: error.message };
    }
  }
}

/**
 * Is "now" (converted into the campaign's own timezone) inside the configured
 * sending window and on one of the configured sending days?
 */
function isWithinSendingWindow(campaign, now = new Date()) {
  const timezone = campaign.timezone || "UTC";
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
  } catch {
    return false;
  }

  const weekday = parts.find((p) => p.type === "weekday")?.value;
  const hour = parts.find((p) => p.type === "hour")?.value;
  const minute = parts.find((p) => p.type === "minute")?.value;
  if (!weekday || hour === undefined || minute === undefined) return false;

  const sendingDays = Array.isArray(campaign.sending_days) ? campaign.sending_days : [];
  if (sendingDays.length > 0 && !sendingDays.includes(weekday)) return false;

  const currentMinutes = Number(hour) * 60 + Number(minute);
  const [startH, startM] = String(campaign.window_start || "00:00").split(":").map(Number);
  const [endH, endM] = String(campaign.window_end || "23:59").split(":").map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
}

/** Simple {{firstName}}-style template substitution against lead fields. */
function personalize(text, lead) {
  const values = {
    firstName: lead.first_name || firstNameFromFullName(lead.full_name) || "",
    lastName: lead.last_name || "",
    fullName: lead.full_name || "",
    company: lead.company || "",
    role: lead.role || "",
  };
  return String(text || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => (key in values ? values[key] : match));
}

function firstNameFromFullName(fullName) {
  if (!fullName) return null;
  return String(fullName).trim().split(/\s+/)[0] || null;
}

function escapeHeaderValue(value) {
  return String(value || "").replace(/["\r\n]/g, "");
}

function buildRawMimeMessage({ from, to, subject, body, extraHeaders = {} }) {
  const messageId = `<${crypto.randomUUID()}@replyos>`;
  const headerLines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    `Message-ID: ${messageId}`,
    ...Object.entries(extraHeaders).map(([key, value]) => `${key}: ${value}`),
  ];
  return { raw: Buffer.from(`${headerLines.join("\r\n")}\r\n\r\n${body}`, "utf8"), messageId };
}

/** Deterministic thread key shared by outbound sends and inbound replies for a given mailbox+lead. */
function threadIdFor(mailboxId, leadEmail) {
  return `${mailboxId}:${String(leadEmail || "").trim().toLowerCase()}`;
}

function encodeSubject(subject) {
  const text = String(subject || "");
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

module.exports = new CampaignSendService();
// Shared with services/inbox.service.js so a unified-inbox reply is built and threaded
// exactly like a campaign send, rather than duplicating the MIME/thread-id logic.
module.exports.buildRawMimeMessage = buildRawMimeMessage;
module.exports.threadIdFor = threadIdFor;
module.exports.sesClient = sesClient;
