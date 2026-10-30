const crypto = require("crypto");
const db = require("../config/db.config");
const suppressionService = require("./suppression.service");
const { sendRawEmail } = require("./mailTransport.service");
const quotaService = require("./quota.service");
const leadVerifyService = require("./leadVerify.service");
const { renderMessage, hasUnresolvedPlaceholders, buildRawMimeMessage } = require("../utils/emailTemplate.util");

// How many leads a single mailbox may send in one tick. Kept deliberately small so a
// mailbox's daily_limit is spread across the whole sending window instead of bursting —
// the cron in index.js should run this every few minutes.
const MAX_SENDS_PER_MAILBOX_PER_TICK = 1;
const MAX_SEND_ATTEMPTS = 5;

const envInt = (name, fallback) => {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

/**
 * Mail from our own servers (Postal) only gets a brand-new IP's worth of trust one day at a time: an IP may send this many
 * emails per day (warm-up and campaign mail together) at the given age, starting small and rising until the maximum.
 * Tunable with POSTAL_IP_CAP_START / POSTAL_IP_CAP_STEP / POSTAL_IP_CAP_MAX.
 */
function ipDailyCap(ageDays) {
  return Math.min(envInt("POSTAL_IP_CAP_MAX", 60), envInt("POSTAL_IP_CAP_START", 10) + envInt("POSTAL_IP_CAP_STEP", 2) * Math.max(0, ageDays || 0));
}

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
    // Workspaces whose email limit is used up for this tick: their campaigns are skipped (leads stay Pending, nothing
    // is marked failed) and it is logged once per workspace, not once per lead.
    const blocked = new Set();
    for (const campaign of campaigns) {
      if (!isWithinSendingWindow(campaign)) continue;
      if (!campaign.is_warmup) {
        if (blocked.has(campaign.workspace_id)) {
          results.push({ campaignId: campaign.id, sent: 0, reason: "email_limit_reached" });
          continue;
        }
        try {
          await quotaService.check(campaign.workspace_id, "emails", 1);
        } catch (error) {
          if (quotaService.isQuotaError(error)) {
            blocked.add(campaign.workspace_id);
            console.warn(`Campaign sending paused for workspace ${campaign.workspace_id} this tick: ${error.message}`);
            results.push({ campaignId: campaign.id, sent: 0, reason: "email_limit_reached" });
            continue;
          }
          results.push({ campaignId: campaign.id, error: error.message });
          continue;
        }
      }
      try {
        const result = await this.tickCampaign(campaign);
        if (result.reason === "email_limit_reached" && !blocked.has(campaign.workspace_id)) {
          blocked.add(campaign.workspace_id);
          console.warn(`Campaign sending paused for workspace ${campaign.workspace_id} this tick: email limit reached`);
        }
        results.push(result);
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
    // Emails already sent from each sending IP during this tick, on top of what the database counted when the tick began.
    const ipSentThisTick = new Map();
    for (const mailbox of mailboxes) {
      // A campaign deleted/paused while this tick was running must stop sending right away.
      if (!campaign.is_warmup) {
        const { rows: live } = await db.query(`SELECT 1 FROM campaigns WHERE id = $1 AND status = 'Active' AND is_deleted = FALSE`, [campaign.id]);
        if (!live[0]) return { campaignId: campaign.id, sent: sentCount, reason: "campaign_inactive" };
      }
      // Warmup sends draw from the permanent warmup-lane allowance (daily_limit/sent_today);
      // real campaigns draw from the separate market-lane allowance, which only unlocks once
      // a mailbox finishes ramping. See warmup.service.js tickMailbox.
      // Real campaigns are also paced: by this point in the sending window a mailbox may only have sent its
      // proportional share of the daily limit, so the limit is spread over the window instead of going out in the
      // first minutes after it opens (which Gmail reads as a burst).
      const remainingCapacity = campaign.is_warmup
        ? mailbox.daily_limit - mailbox.sent_today
        : Math.min(
            mailbox.market_daily_limit - mailbox.market_sent_today,
            Math.ceil(mailbox.market_daily_limit * windowProgress(campaign)) - mailbox.market_sent_today
          );
      let batchSize = Math.max(0, Math.min(MAX_SENDS_PER_MAILBOX_PER_TICK, remainingCapacity));
      if (batchSize === 0) continue;

      // A Postal mailbox is also held to its sending IP's daily cap (a mailbox with no known IP is treated as its own IP).
      let ipKey = null;
      if (!campaign.is_warmup && mailbox.provider === "postal") {
        ipKey = mailbox.ip_id ? `ip:${mailbox.ip_id}` : `mailbox:${mailbox.id}`;
        const sentToday = mailbox.ip_id ? Number(mailbox.ip_sent_today) : mailbox.sent_today + mailbox.market_sent_today;
        const ipRoom = ipDailyCap(mailbox.ip_id ? mailbox.ip_age_days : 0) - sentToday - (ipSentThisTick.get(ipKey) || 0);
        batchSize = Math.min(batchSize, ipRoom);
        if (batchSize <= 0) continue;
      }

      // Follow-ups to people this mailbox already emailed take priority over new leads: a
      // sequence that stalls mid-way wastes the first touch. Warmup pool has no follow-ups.
      if (!campaign.is_warmup) {
        const dueFollowUps = await this.getDueFollowUps(campaign.id, mailbox.id, batchSize);
        for (const lead of dueFollowUps) {
          const outcome = await this.sendToLead(campaign, mailbox, lead, { followUp: lead.followup });
          if (outcome.reason === "email_limit_reached") return { campaignId: campaign.id, sent: sentCount, reason: "email_limit_reached" };
          if (outcome.sent) { sentCount += 1; if (ipKey) ipSentThisTick.set(ipKey, (ipSentThisTick.get(ipKey) || 0) + 1); }
          batchSize -= 1;
        }
        if (batchSize <= 0) continue;
      }

      const leads = await this.getPendingLeads(campaign.id, batchSize);
      for (const lead of leads) {
        const outcome = await this.sendToLead(campaign, mailbox, lead);
        if (outcome.reason === "email_limit_reached") return { campaignId: campaign.id, sent: sentCount, reason: "email_limit_reached" };
        if (outcome.sent) { sentCount += 1; if (ipKey) ipSentThisTick.set(ipKey, (ipSentThisTick.get(ipKey) || 0) + 1); }
      }
    }

    return { campaignId: campaign.id, sent: sentCount };
  }

  async getSendableMailboxes(campaign) {
    const mode = campaign.mailbox_mode === "specific" ? "specific" : "all";
    // A campaign may only send through mailboxes (and domains) of its own workspace.
    const params = [campaign.workspace_id];
    let mailboxFilter = "";
    if (mode === "specific") {
      params.push(campaign.mailbox_ids);
      mailboxFilter = `AND m.id = ANY($${params.length}::int[])`;
    }

    const capacityFilter = campaign.is_warmup
      ? "m.sent_today < m.daily_limit"
      : "m.market_daily_limit > 0 AND m.market_sent_today < m.market_daily_limit";

    // Readiness gate for our own mail servers: a Postal mailbox may only send real campaign mail once its domain's SPF, DKIM,
    // MX and DMARC are all verified and it has been warming up for POSTAL_MIN_WARMUP_DAYS (default 14). Warm-up mail itself
    // is never gated, or nothing could ever warm up.
    let readinessFilter = "";
    if (!campaign.is_warmup) {
      params.push(envInt("POSTAL_MIN_WARMUP_DAYS", 14));
      readinessFilter = `AND (m.provider <> 'postal' OR (
           d.spf_status = 'Success' AND d.dkim_status = 'Success' AND d.mx_status = 'Success' AND d.dmarc_status = 'Success'
           AND m.warmup_started_at IS NOT NULL AND m.warmup_started_at <= NOW() - make_interval(days => $${params.length})))`;
    }

    const { rows } = await db.query(
      `SELECT m.*, d.status AS domain_status, w.ip_id,
              GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - ip.created_at)) / 86400))::int AS ip_age_days,
              (SELECT COALESCE(SUM(m2.sent_today + m2.market_sent_today), 0)
                 FROM mailboxes m2 JOIN warmnet_domains w2 ON w2.domain_id = m2.domain_id
                WHERE w2.ip_id = w.ip_id AND m2.is_deleted = FALSE)::int AS ip_sent_today
       FROM mailboxes m
       JOIN domains d ON d.id = m.domain_id AND d.is_deleted = FALSE AND d.workspace_id = m.workspace_id
       LEFT JOIN warmnet_domains w ON w.domain_id = d.id
       LEFT JOIN warmnet_ips ip ON ip.id = w.ip_id
       WHERE m.is_deleted = FALSE
         AND m.workspace_id = $1
         AND m.status = 'Active'
         AND m.provider IN ('maildoso', 'postal')
         AND d.status = 'Verified'
         AND ${capacityFilter}
         ${mailboxFilter}
         ${readinessFilter}
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

  /**
   * Leads this mailbox emailed earlier whose next follow-up step is now due: the delay (in
   * days) is counted from the lead's last email. Only leads still in 'Sent' qualify, so a
   * reply, bounce, opt-out or suppression automatically ends the sequence.
   */
  async getDueFollowUps(campaignId, mailboxId, limit) {
    const { rows } = await db.query(
      `SELECT cl.*, fu.step_order AS fu_step_order, fu.body AS fu_body
       FROM campaign_leads cl
       JOIN LATERAL (
         SELECT step_order, delay_days, body
         FROM campaign_followups
         WHERE campaign_id = cl.campaign_id
         ORDER BY step_order ASC
         OFFSET cl.followup_step LIMIT 1
       ) fu ON TRUE
       WHERE cl.campaign_id = $1 AND cl.mailbox_id = $2 AND cl.status = 'Sent'
         AND cl.last_contacted_at + (fu.delay_days * INTERVAL '1 day') <= NOW()
         AND (cl.followup_retry_after IS NULL OR cl.followup_retry_after <= NOW())
       ORDER BY cl.last_contacted_at ASC
       LIMIT $3`,
      [campaignId, mailboxId, limit]
    );
    return rows.map((row) => ({ ...row, followup: { step: row.followup_step + 1, body: row.fu_body } }));
  }

  async sendToLead(campaign, mailbox, lead, { followUp = null } = {}) {
    // Belt-and-suspenders: campaign creation already filters known suppressions at
    // import time, but a lead could opt out (or a new bounce/complaint land) any time
    // between then and now — re-check immediately before every send.
    if (await suppressionService.isSuppressed(lead.email, campaign.workspace_id)) {
      await db.query(`UPDATE campaign_leads SET status = 'Suppressed' WHERE id = $1`, [lead.id]);
      return { sent: false, reason: "suppressed" };
    }

    // An address that can't possibly receive mail (no such domain, no mail server) only costs us a bounce, which is the most
    // expensive kind of mistake for a young sending IP. Skip it, leaving the reason on the lead. A DNS outage never blocks.
    const verdict = await leadVerifyService.checkAddress(lead.email);
    if (verdict.deliverable === false) {
      const reason = `${verdict.reason}; not sent`;
      if (followUp) await db.query(`UPDATE campaign_leads SET last_error = $2, followup_retry_after = NOW() + INTERVAL '24 hours' WHERE id = $1`, [lead.id, reason]);
      else await db.query(`UPDATE campaign_leads SET status = 'Failed', last_error = $2 WHERE id = $1`, [lead.id, reason]);
      return { sent: false, reason: "undeliverable_address" };
    }

    const rendered = renderMessage({ subject: campaign.subject, body: followUp ? followUp.body : campaign.body }, lead, mailbox);
    // An unknown {{variable}} would reach the recipient as literal text. Refuse to send and leave the lead exactly
    // as it was (no attempt used) so fixing the template resumes sending with nothing lost.
    if (hasUnresolvedPlaceholders(rendered.subject) || hasUnresolvedPlaceholders(rendered.text)) {
      console.warn(`Campaign ${campaign.id}: not sending to lead ${lead.id}, template has an unresolved {{placeholder}}`);
      return { sent: false, reason: "unresolved_placeholder" };
    }
    // A lead with no value for a variable the template uses (e.g. no company) would get a broken sentence. First
    // emails fail the lead with the reason recorded; a follow-up just backs off, since the first email already landed.
    if (rendered.missing.length > 0) {
      const reason = `Missing ${rendered.missing.join(", ")} for this lead; not sent`;
      if (followUp) {
        await db.query(`UPDATE campaign_leads SET last_error = $2, followup_retry_after = NOW() + INTERVAL '1 hour' WHERE id = $1`, [lead.id, reason]);
      } else {
        await db.query(`UPDATE campaign_leads SET status = 'Failed', last_error = $2 WHERE id = $1`, [lead.id, reason]);
      }
      return { sent: false, reason: "missing_merge_value" };
    }
    const subject = followUp ? (/^re:/i.test(rendered.subject) ? rendered.subject : `Re: ${rendered.subject}`) : rendered.subject;
    const body = rendered.text;
    const listUnsubscribeHeaders = suppressionService.buildListUnsubscribeHeaders({ email: lead.email, campaignId: campaign.id });
    const threadHeaders = followUp && lead.rfc_message_id ? { "In-Reply-To": lead.rfc_message_id, References: lead.rfc_message_id } : {};
    const fromAddress = mailbox.display_name ? `"${escapeHeaderValue(mailbox.display_name)}" <${mailbox.email}>` : mailbox.email;

    const { raw, messageId: rfcMessageId } = buildRawMimeMessage({
      from: fromAddress,
      to: lead.email,
      subject,
      body,
      htmlBody: rendered.html,
      extraHeaders: { ...listUnsubscribeHeaders, ...threadHeaders },
      messageIdDomain: mailboxDomain(mailbox),
    });

    // Cold-mailer sends count against the workspace's email limit (warm-up pool traffic does not). At the cap the lead is
    // left exactly as it was (no failure, no attempt used) and sending resumes once the 24h window frees up.
    let usageId = null;
    if (!campaign.is_warmup) {
      try {
        usageId = await quotaService.consume(campaign.workspace_id, "emails", 1, { source: followUp ? "followup" : "campaign", campaignId: campaign.id });
      } catch (error) {
        if (quotaService.isQuotaError(error)) return { sent: false, reason: "email_limit_reached", error: error.message };
        throw error;
      }
    }

    try {
      const providerMessageId = await sendRawEmail({ mailbox, to: lead.email, raw });
      usageId = null; // the email is out: its usage stays counted whatever happens to the bookkeeping below

      if (followUp) {
        // The thread's original rfc_message_id stays as the In-Reply-To anchor; only the step
        // counter and last-contact clock move.
        await db.query(
          `UPDATE campaign_leads SET followup_step = $2, last_contacted_at = NOW(), followup_retry_after = NULL, last_error = NULL WHERE id = $1`,
          [lead.id, followUp.step]
        );
      } else {
        await db.query(
          `UPDATE campaign_leads SET status = 'Sent', sent_at = NOW(), last_contacted_at = NOW(), mailbox_id = $2, ses_message_id = $3, rfc_message_id = $4
           WHERE id = $1`,
          [lead.id, mailbox.id, providerMessageId, rfcMessageId]
        );
      }
      await db.query(
        campaign.is_warmup
          ? `UPDATE mailboxes SET sent_today = sent_today + 1, last_sent_at = NOW(), updated_at = NOW() WHERE id = $1`
          : `UPDATE mailboxes SET market_sent_today = market_sent_today + 1, last_sent_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [mailbox.id]
      );
      // Follow-ups count toward today's volume but not sent_total, which is the denominator
      // of reply/bounce rate and should stay "first emails sent".
      await db.query(
        followUp
          ? `UPDATE campaigns SET sent_today = sent_today + 1, updated_at = NOW() WHERE id = $1`
          : `UPDATE campaigns SET sent_today = sent_today + 1, sent_total = sent_total + 1, updated_at = NOW() WHERE id = $1`,
        [campaign.id]
      );
      // Record the send in the mailbox's app-native inbox too, so the "open inbox" view
      // shows the full thread (what we sent + any reply), not just replies.
      await db.query(
        `INSERT INTO messages (mailbox_id, direction, campaign_id, campaign_lead_id, thread_id, message_id, from_address, to_address, subject, body_text, workspace_id)
         VALUES ($1, 'outbound', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [mailbox.id, campaign.id, lead.id, threadIdFor(mailbox.id, lead.email), rfcMessageId, mailbox.email, lead.email, subject, body, campaign.workspace_id]
      );

      // Let an active "mail sent" workflow react (fire-and-forget: the email is already out). Not for warmup
      // traffic or follow-up steps.
      if (!campaign.is_warmup && !followUp) {
        require("./workflowExecutor.service")
          .maybeRun({
            workspaceId: campaign.workspace_id,
            triggerType: "trigger.mail_sent",
            event: { mailboxId: mailbox.id, campaignId: campaign.id, leadId: lead.id, leadEmail: lead.email, subject, body },
          })
          .catch(() => {});
      }

      return { sent: true };
    } catch (error) {
      // Nothing went out (or the send failed), so the email is not counted.
      if (usageId) await quotaService.refund(campaign.workspace_id, usageId);
      if (followUp) {
        // A failed follow-up must not mark the lead Failed (the first email already landed);
        // just back off an hour before this step is tried again.
        await db.query(
          `UPDATE campaign_leads SET last_error = $2, followup_retry_after = NOW() + INTERVAL '1 hour' WHERE id = $1`,
          [lead.id, error.message || String(error)]
        );
        return { sent: false, reason: "send_error", error: error.message };
      }
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

/** How far "now" is through the campaign's sending window, 0 (just opened) to 1 (closing), in the campaign's timezone. */
function windowProgress(campaign, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: campaign.timezone || "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const current = Number(parts.find((p) => p.type === "hour").value) * 60 + Number(parts.find((p) => p.type === "minute").value);
  const [startH, startM] = String(campaign.window_start || "00:00").split(":").map(Number);
  const [endH, endM] = String(campaign.window_end || "23:59").split(":").map(Number);
  const start = startH * 60 + startM;
  const length = endH * 60 + endM - start;
  if (length <= 0) return 1;
  return Math.min(1, Math.max(0, (current - start) / length));
}

function escapeHeaderValue(value) {
  return String(value || "").replace(/["\r\n]/g, "");
}

/** Domain part of the mailbox address, used so Message-IDs are on the sender's own domain. */
function mailboxDomain(mailbox) {
  return String(mailbox.email || "").split("@")[1] || undefined;
}

/** Deterministic thread key shared by outbound sends and inbound replies for a given mailbox+lead. */
function threadIdFor(mailboxId, leadEmail) {
  return `${mailboxId}:${String(leadEmail || "").trim().toLowerCase()}`;
}

module.exports = new CampaignSendService();
// Shared with services/inbox.service.js so a unified-inbox reply is built and threaded
// exactly like a campaign send, rather than duplicating the MIME/thread-id logic.
module.exports.buildRawMimeMessage = buildRawMimeMessage;
module.exports.threadIdFor = threadIdFor;
module.exports.ipDailyCap = ipDailyCap;
module.exports.mailboxDomain = mailboxDomain;
