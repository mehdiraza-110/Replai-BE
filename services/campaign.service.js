const db = require("../config/db.config");
const { parseLeadsFile } = require("./leadFileParser");
const suppressionService = require("./suppression.service");

// Appended to every campaign email (and each follow-up step) so every outbound message
// carries a working opt-out mechanism, per PlusVibe-Plan.md 12A. Reply-based rather than
// a link: replies containing this phrase are detected in message.service.js (isOptOutText)
// and immediately added to the suppression list.
const OPT_OUT_FOOTER = "\n\nIf you'd prefer not to hear from us again, just reply to this email with \"OPT OUT\" and we'll remove you from our list right away.";
const OPT_OUT_LANGUAGE_PATTERN = /opt[\s-]?out|unsubscribe|remove (you|me) from (this|our|your) (list|mailing list)/i;

function withOptOutFooter(body) {
  const trimmed = String(body || "");
  if (OPT_OUT_LANGUAGE_PATTERN.test(trimmed)) return trimmed;
  return `${trimmed}${OPT_OUT_FOOTER}`;
}

class CampaignService {
  async listCampaigns({ page = 1, limit = 10, search = "" } = {}) {
    const pageNum = Math.max(1, Number.parseInt(page, 10) || 1);
    const limitNum = Math.min(Math.max(Number.parseInt(limit, 10) || 10, 1), 100);
    const offset = (pageNum - 1) * limitNum;

    const conditions = ["is_deleted = FALSE"];
    const params = [];

    const searchTerm = String(search || "").trim();
    if (searchTerm) {
      params.push(`%${searchTerm}%`);
      conditions.push(`name ILIKE $${params.length}`);
    }
    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const [itemsResult, totalResult] = await Promise.all([
      db.query(
        `SELECT
           c.id, c.name, c.status, c.started_at, c.sent_today, c.sent_total, c.reply_count,
           CASE WHEN c.mailbox_mode = 'all' THEN (SELECT COUNT(*)::int FROM mailboxes WHERE is_deleted = FALSE)
                ELSE COALESCE(array_length(c.mailbox_ids, 1), 0) END AS mailbox_count,
           CASE WHEN c.sent_total > 0 THEN ROUND((c.reply_count::numeric / c.sent_total) * 100, 1) ELSE 0 END AS reply_rate,
           CASE WHEN c.sent_total > 0 THEN ROUND((c.bounce_count::numeric / c.sent_total) * 100, 1) ELSE 0 END AS bounce_rate,
           (SELECT COUNT(*)::int FROM campaign_leads cl WHERE cl.campaign_id = c.id) AS leads_count,
           (SELECT COUNT(*)::int FROM campaign_leads cl WHERE cl.campaign_id = c.id AND cl.status != 'Pending') AS contacted_count,
           (SELECT COUNT(*)::int FROM campaign_followups cf WHERE cf.campaign_id = c.id) AS followup_count
         FROM campaigns c
         ${whereClause}
         ORDER BY c.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limitNum, offset]
      ),
      db.query(`SELECT COUNT(*)::int AS count FROM campaigns ${whereClause}`, params),
    ]);

    const total = totalResult.rows[0]?.count || 0;

    return {
      items: itemsResult.rows.map(mapCampaignSummaryRow),
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.max(1, Math.ceil(total / limitNum)),
    };
  }

  async createCampaign({
    name,
    objective,
    subject,
    body,
    leads,
    followUps,
    mailboxMode,
    mailboxIds,
    dailyLimitOverride,
    sendingDays,
    windowStart,
    windowEnd,
    timezone,
    aiAgentId,
    humanReviewRequired,
    createdBy,
  }) {
    const trimmedName = String(name || "").trim();
    if (!trimmedName) {
      throw Object.assign(new Error("Campaign name is required"), { statusCode: 400 });
    }
    const trimmedSubject = String(subject || "").trim();
    if (!trimmedSubject) {
      throw Object.assign(new Error("Subject line is required"), { statusCode: 400 });
    }
    if (!body || !String(body).trim()) {
      throw Object.assign(new Error("Email body is required"), { statusCode: 400 });
    }
    const bodyWithOptOut = withOptOutFooter(body);

    const normalizedLeads = [];
    const seenEmails = new Set();
    for (const lead of Array.isArray(leads) ? leads : []) {
      const isPlainString = typeof lead === "string";
      const email = String(isPlainString ? lead : lead?.email || "").trim().toLowerCase();
      if (!email || seenEmails.has(email)) continue;
      seenEmails.add(email);
      normalizedLeads.push({
        email,
        fullName: isPlainString ? null : lead.fullName || null,
        firstName: isPlainString ? null : lead.firstName || null,
        lastName: isPlainString ? null : lead.lastName || null,
        company: isPlainString ? null : lead.company || null,
        role: isPlainString ? null : lead.role || null,
        phone: isPlainString ? null : lead.phone || null,
        raw: isPlainString ? {} : lead.raw || {},
      });
    }
    if (normalizedLeads.length === 0) {
      throw Object.assign(new Error("At least one lead email is required"), { statusCode: 400 });
    }

    // Drop anyone who has unsubscribed, complained, hard-bounced, or been manually
    // suppressed — even if they were re-uploaded in this list. See PlusVibe-Plan.md 12A.3.
    const suppressedEmails = await suppressionService.filterSuppressed(normalizedLeads.map((lead) => lead.email));
    const suppressedCount = suppressedEmails.size;
    const sendableLeads = normalizedLeads.filter((lead) => !suppressedEmails.has(lead.email));
    if (sendableLeads.length === 0) {
      throw Object.assign(new Error("All provided leads are on the suppression list (unsubscribed, complained, or bounced)"), { statusCode: 400 });
    }

    const mode = mailboxMode === "specific" ? "specific" : "all";
    const parsedMailboxIds = mode === "specific"
      ? Array.from(new Set((Array.isArray(mailboxIds) ? mailboxIds : []).map((id) => Number(id)).filter((id) => Number.isFinite(id))))
      : [];
    if (mode === "specific" && parsedMailboxIds.length === 0) {
      throw Object.assign(new Error("Select at least one sending mailbox"), { statusCode: 400 });
    }

    const client = await db.getClient();
    try {
      await client.query("BEGIN");

      const { rows } = await client.query(
        `INSERT INTO campaigns (
           name, objective, subject, body, mailbox_mode, mailbox_ids, daily_limit_override,
           sending_days, window_start, window_end, timezone, ai_agent_id, human_review_required,
           status, started_at, created_by, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'Active',NOW(),$14,NOW())
         RETURNING id, name, status, started_at, sent_today, sent_total, reply_count, bounce_count, mailbox_mode, mailbox_ids`,
        [
          trimmedName,
          objective || null,
          trimmedSubject,
          bodyWithOptOut,
          mode,
          parsedMailboxIds,
          Number.isFinite(Number(dailyLimitOverride)) && Number(dailyLimitOverride) > 0 ? Math.floor(Number(dailyLimitOverride)) : null,
          JSON.stringify(Array.isArray(sendingDays) ? sendingDays : []),
          windowStart || "09:00",
          windowEnd || "17:00",
          timezone || "UTC",
          aiAgentId || null,
          humanReviewRequired !== false,
          createdBy || null,
        ]
      );
      const campaign = rows[0];

      await client.query(
        `INSERT INTO campaign_leads (campaign_id, email, full_name, first_name, last_name, company, role, phone, raw_data)
         SELECT $1, * FROM unnest(
           $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::jsonb[]
         )`,
        [
          campaign.id,
          sendableLeads.map((lead) => lead.email),
          sendableLeads.map((lead) => lead.fullName),
          sendableLeads.map((lead) => lead.firstName),
          sendableLeads.map((lead) => lead.lastName),
          sendableLeads.map((lead) => lead.company),
          sendableLeads.map((lead) => lead.role),
          sendableLeads.map((lead) => lead.phone),
          sendableLeads.map((lead) => JSON.stringify(lead.raw || {})),
        ]
      );

      const followUpList = Array.isArray(followUps) ? followUps : [];
      for (let index = 0; index < followUpList.length; index += 1) {
        const followUp = followUpList[index];
        if (!followUp?.body || !String(followUp.body).trim()) continue;
        await client.query(
          `INSERT INTO campaign_followups (campaign_id, step_order, delay_days, body)
           VALUES ($1, $2, $3, $4)`,
          [campaign.id, index + 1, Number(followUp.delayDays) > 0 ? Math.floor(Number(followUp.delayDays)) : 3, withOptOutFooter(followUp.body)]
        );
      }

      await client.query("COMMIT");

      const mailboxCount = mode === "all"
        ? (await db.query(`SELECT COUNT(*)::int AS count FROM mailboxes WHERE is_deleted = FALSE`)).rows[0].count
        : parsedMailboxIds.length;
      const followupCount = followUpList.filter((followUp) => followUp?.body && String(followUp.body).trim()).length;

      return {
        ...mapCampaignSummaryRow({
          id: campaign.id,
          name: campaign.name,
          status: campaign.status,
          started_at: campaign.started_at,
          sent_today: campaign.sent_today,
          sent_total: campaign.sent_total,
          reply_count: 0,
          mailbox_count: mailboxCount,
          reply_rate: 0,
          bounce_rate: 0,
          leads_count: sendableLeads.length,
          contacted_count: 0,
          followup_count: followupCount,
        }),
        suppressedCount,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  parseLeadsFile(buffer, originalName) {
    return parseLeadsFile(buffer, originalName);
  }

  async listCampaignLeads(campaignId, { page = 1, limit = 20, search = "" } = {}) {
    const pageNum = Math.max(1, Number.parseInt(page, 10) || 1);
    const limitNum = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 200);
    const offset = (pageNum - 1) * limitNum;

    const conditions = ["campaign_id = $1"];
    const params = [campaignId];

    const searchTerm = String(search || "").trim();
    if (searchTerm) {
      params.push(`%${searchTerm}%`);
      conditions.push(`(email ILIKE $${params.length} OR full_name ILIKE $${params.length} OR company ILIKE $${params.length})`);
    }
    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const [itemsResult, totalResult] = await Promise.all([
      db.query(
        `SELECT id, email, full_name, first_name, last_name, company, role, phone, status, raw_data, created_at
         FROM campaign_leads
         ${whereClause}
         ORDER BY id ASC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limitNum, offset]
      ),
      db.query(`SELECT COUNT(*)::int AS count FROM campaign_leads ${whereClause}`, params),
    ]);

    const total = totalResult.rows[0]?.count || 0;

    return {
      items: itemsResult.rows.map(mapCampaignLeadRow),
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.max(1, Math.ceil(total / limitNum)),
    };
  }
}

function mapCampaignSummaryRow(row) {
  if (!row) return null;
  const leadsCount = row.leads_count || 0;
  const contactedCount = row.contacted_count || 0;
  const followupCount = row.followup_count || 0;

  return {
    id: row.id,
    name: row.name,
    status: row.status,
    mailboxCount: row.mailbox_count || 0,
    sentToday: row.sent_today || 0,
    sentTotal: row.sent_total || 0,
    replyRate: Number(row.reply_rate) || 0,
    bounceRate: Number(row.bounce_rate) || 0,
    startedAt: row.started_at,
    leadsCount,
    contactedCount,
    contactedPercent: leadsCount > 0 ? Math.round((contactedCount / leadsCount) * 1000) / 10 : 0,
    replyCount: row.reply_count || 0,
    positiveReplyRate: null,
    openTrackingSupported: false,
    totalSequenceEmails: leadsCount * (1 + followupCount),
  };
}

function mapCampaignLeadRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    firstName: row.first_name,
    lastName: row.last_name,
    company: row.company,
    role: row.role,
    phone: row.phone,
    status: row.status,
    raw: row.raw_data || {},
    createdAt: row.created_at,
  };
}

module.exports = new CampaignService();
