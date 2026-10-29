const db = require("../config/db.config");

const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const RANGES = { all: null, "7d": 7, "30d": 30, "90d": 90 };
const STATUSES = ["Active", "Paused", "Draft", "Completed"];

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 10000) / 100 : 0);

/**
 * Which campaign each thread belongs to, and how it ended up: replied, positive (high or very high interest) and booked.
 * The campaign is the latest one that emailed that prospect from that mailbox.
 */
const THREAD_OUTCOMES = `
  WITH tc AS (
    SELECT DISTINCT ON (m.mailbox_id, m.thread_id) m.mailbox_id, m.thread_id, m.campaign_id
    FROM messages m WHERE m.workspace_id = $1 AND m.campaign_id IS NOT NULL
    ORDER BY m.mailbox_id, m.thread_id, m.id DESC
  ),
  th AS (
    SELECT tc.campaign_id, tc.mailbox_id, tc.thread_id,
      COALESCE(s.interest, 'none') AS interest, COALESCE(s.outcome, 'none') AS outcome,
      EXISTS (SELECT 1 FROM messages i WHERE i.workspace_id = $1 AND i.mailbox_id = tc.mailbox_id AND i.thread_id = tc.thread_id AND i.direction = 'inbound') AS replied,
      EXISTS (SELECT 1 FROM sdr_bookings b WHERE b.workspace_id = $1 AND b.mailbox_id = tc.mailbox_id AND b.thread_id = tc.thread_id AND b.status = 'booked') AS has_booking
    FROM tc LEFT JOIN sdr_thread_state s ON s.workspace_id = $1 AND s.mailbox_id = tc.mailbox_id AND s.thread_id = tc.thread_id
  )`;

class CampaignInsightsService {
  /** Header numbers plus one row per campaign, for the Cold Email Agent home screen. */
  async overview(workspaceId, { search = "", status = "", range = "all", page = 1, limit = 25 } = {}) {
    if (status && !STATUSES.includes(status)) throw bad("Unknown status.");
    if (!(range in RANGES)) throw bad("Unknown date range.");
    const pageNum = Math.max(1, Number.parseInt(page, 10) || 1);
    const limitNum = Math.min(Math.max(Number.parseInt(limit, 10) || 25, 1), 100);

    const params = [workspaceId];
    const where = ["c.workspace_id = $1", "c.is_deleted = FALSE", "c.is_warmup = FALSE"];
    if (status) {
      params.push(status);
      where.push(`c.status = $${params.length}`);
    }
    if (RANGES[range]) {
      params.push(RANGES[range]);
      where.push(`COALESCE(c.started_at, c.created_at) >= NOW() - ($${params.length}::int * INTERVAL '1 day')`);
    }
    const term = String(search || "").trim().slice(0, 200);
    if (term) {
      params.push(`%${term.replace(/[%_\\]/g, "\\$&")}%`);
      where.push(`c.name ILIKE $${params.length}`);
    }
    const whereSql = where.join(" AND ");

    const base = `
      ${THREAD_OUTCOMES},
      per AS (
        SELECT campaign_id,
          COUNT(*) FILTER (WHERE replied AND interest IN ('high', 'very_high'))::int AS positive,
          COUNT(*) FILTER (WHERE outcome = 'meeting_booked' OR has_booking)::int AS booked
        FROM th GROUP BY campaign_id
      ),
      rows AS (
        SELECT c.id, c.name, c.status, c.sent_total, c.reply_count, c.started_at, c.created_at,
          COALESCE(per.positive, 0) AS positive, COALESCE(per.booked, 0) AS booked,
          (SELECT COUNT(*)::int FROM campaign_leads cl WHERE cl.campaign_id = c.id AND cl.workspace_id = c.workspace_id) AS leads_uploaded,
          (SELECT COUNT(*)::int FROM campaign_leads cl WHERE cl.campaign_id = c.id AND cl.workspace_id = c.workspace_id AND cl.status = 'Bounced') AS bounced,
          COALESCE(NULLIF(c.sending_days::text, 'null'), '[]') AS sending_days
        FROM campaigns c LEFT JOIN per ON per.campaign_id = c.id
        WHERE ${whereSql}
      )`;

    const [list, totals, count] = await Promise.all([
      db.query(`${base} SELECT * FROM rows ORDER BY COALESCE(started_at, created_at) DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limitNum, (pageNum - 1) * limitNum]),
      db.query(`${base} SELECT COALESCE(SUM(sent_total), 0)::int AS contacted, COALESCE(SUM(positive), 0)::int AS positive, COALESCE(SUM(booked), 0)::int AS booked FROM rows`, params),
      db.query(`${base} SELECT COUNT(*)::int AS count FROM rows`, params),
    ]);

    const t = totals.rows[0];
    return {
      summary: {
        contactedLeads: t.contacted,
        positiveReplies: t.positive,
        positiveReplyRate: pct(t.positive, t.contacted),
        // Of the people who answered positively, how many ended up on a call.
        bookedCallRate: pct(t.booked, t.positive),
        callsBooked: t.booked,
      },
      items: list.rows.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        leadsContacted: row.sent_total,
        replies: row.reply_count,
        replyRate: pct(row.reply_count, row.sent_total),
        positiveReplies: row.positive,
        positiveReplyRate: pct(row.positive, row.sent_total),
        bounced: row.bounced,
        bounceRate: pct(row.bounced, row.sent_total),
        callsBooked: row.booked,
        startedAt: row.started_at,
        createdAt: row.created_at,
      })),
      page: pageNum,
      limit: limitNum,
      total: count.rows[0].count,
      totalPages: Math.max(1, Math.ceil(count.rows[0].count / limitNum)),
    };
  }

  /** Everything the campaign's Analytics tab shows. */
  async analytics(workspaceId, campaignId, { days = 30 } = {}) {
    const id = Number(campaignId);
    if (!Number.isInteger(id) || id <= 0) throw bad("Campaign not found.", 404);
    const { rows: campaignRows } = await db.query(
      `SELECT c.*, (SELECT COUNT(*)::int FROM campaign_leads cl WHERE cl.campaign_id = c.id AND cl.workspace_id = c.workspace_id) AS leads_uploaded
       FROM campaigns c WHERE c.id = $1 AND c.workspace_id = $2 AND c.is_deleted = FALSE AND c.is_warmup = FALSE`,
      [id, workspaceId]
    );
    const campaign = campaignRows[0];
    if (!campaign) throw bad("Campaign not found.", 404);
    const windowDays = Math.min(Math.max(Number.parseInt(days, 10) || 30, 7), 365);

    const [outcomes, series, steps, followUpCount, funnel, byInbox, placement] = await Promise.all([
      db.query(
        `${THREAD_OUTCOMES}
         SELECT COUNT(*) FILTER (WHERE replied AND interest IN ('high', 'very_high'))::int AS positive, COUNT(*) FILTER (WHERE outcome = 'meeting_booked' OR has_booking)::int AS booked
         FROM th WHERE campaign_id = $2`,
        [workspaceId, id]
      ),
      db.query(
        `WITH days AS (SELECT generate_series(CURRENT_DATE - ($3::int - 1), CURRENT_DATE, INTERVAL '1 day')::date AS day)
         SELECT d.day,
           COALESCE((SELECT COUNT(*) FROM messages m WHERE m.workspace_id = $1 AND m.campaign_id = $2 AND m.direction = 'outbound' AND COALESCE(m.author, 'campaign') = 'campaign' AND m.created_at::date = d.day), 0)::int AS contacted,
           COALESCE((SELECT COUNT(*) FROM messages m WHERE m.workspace_id = $1 AND m.campaign_id = $2 AND m.direction = 'inbound' AND m.created_at::date = d.day), 0)::int AS replied,
           COALESCE((SELECT COUNT(*) FROM sdr_thread_state s WHERE s.workspace_id = $1 AND s.interest IN ('high', 'very_high') AND s.updated_at::date = d.day AND EXISTS (SELECT 1 FROM messages m WHERE m.workspace_id = $1 AND m.mailbox_id = s.mailbox_id AND m.thread_id = s.thread_id AND m.campaign_id = $2)), 0)::int AS positive
         FROM days d ORDER BY d.day`,
        [workspaceId, id, windowDays]
      ),
      db.query(`SELECT followup_step, COUNT(*)::int AS count FROM campaign_leads WHERE campaign_id = $1 AND workspace_id = $2 AND sent_at IS NOT NULL GROUP BY followup_step`, [id, workspaceId]),
      db.query(`SELECT step_order FROM campaign_followups WHERE campaign_id = $1 AND workspace_id = $2 ORDER BY step_order`, [id, workspaceId]),
      // What happened to each lead, straight from the leads themselves (the headline counters above can drift).
      db.query(
        `SELECT COUNT(*) FILTER (WHERE status IN ('Sent', 'Replied', 'Bounced'))::int AS sent, COUNT(*) FILTER (WHERE status = 'Bounced')::int AS bounced,
                COUNT(*) FILTER (WHERE status = 'Replied')::int AS replied, COUNT(*) FILTER (WHERE status = 'Pending')::int AS pending,
                COUNT(*) FILTER (WHERE status = 'Suppressed')::int AS suppressed, COUNT(*) FILTER (WHERE status = 'Failed')::int AS failed
         FROM campaign_leads WHERE campaign_id = $1 AND workspace_id = $2`,
        [id, workspaceId]
      ),
      db.query(
        `SELECT m.id, m.email, COUNT(*) FILTER (WHERE cl.status IN ('Sent', 'Replied', 'Bounced'))::int AS sent, COUNT(*) FILTER (WHERE cl.status = 'Bounced')::int AS bounced,
                COUNT(*) FILTER (WHERE cl.status = 'Replied')::int AS replied
         FROM campaign_leads cl JOIN mailboxes m ON m.id = cl.mailbox_id
         WHERE cl.campaign_id = $1 AND cl.workspace_id = $2 GROUP BY m.id, m.email ORDER BY sent DESC, m.email LIMIT 50`,
        [id, workspaceId]
      ),
      // Spam-folder placement of real recipients can't be seen by anyone. The closest honest signal is our own warm-up network: the same inboxes sending to seed
      // accounts that report whether it landed in the inbox or in spam.
      db.query(
        `SELECT COUNT(*) FILTER (WHERE x.placement = 'inbox')::int AS inbox, COUNT(*) FILTER (WHERE x.placement = 'spam')::int AS spam
         FROM warmnet_messages x
         WHERE x.direction = 'to_seed' AND x.placement IN ('inbox', 'spam') AND x.sent_at > NOW() - INTERVAL '30 days'
           AND x.mailbox_id IN (SELECT DISTINCT mailbox_id FROM campaign_leads WHERE campaign_id = $1 AND workspace_id = $2 AND mailbox_id IS NOT NULL)`,
        [id, workspaceId]
      ),
    ]);

    const positive = outcomes.rows[0].positive;
    const booked = outcomes.rows[0].booked;
    // followup_step counts follow-ups already sent, so a lead at step k has been sent the first email and k follow-ups.
    const sentAtLeast = (k) => steps.rows.filter((row) => row.followup_step >= k).reduce((sum, row) => sum + row.count, 0);
    const stepRows = [{ step: 1, label: "Initial Outreach", sent: sentAtLeast(0) }, ...followUpCount.rows.map((row, index) => ({ step: index + 2, label: `Follow-up ${index + 1}`, sent: sentAtLeast(index + 1) }))];

    return {
      campaign: { id: campaign.id, name: campaign.name, status: campaign.status, startedAt: campaign.started_at, createdAt: campaign.created_at },
      leadsUploaded: campaign.leads_uploaded,
      leadsContacted: campaign.sent_total,
      replies: campaign.reply_count,
      replyRate: pct(campaign.reply_count, campaign.sent_total),
      positiveReplies: positive,
      positiveReplyRate: pct(positive, campaign.sent_total),
      bookedCalls: booked,
      bookedCallRate: pct(booked, positive),
      targets: { positiveRate: Number(campaign.target_positive_rate), bookedRate: Number(campaign.target_booked_rate) },
      series: series.rows.map((row) => ({ date: row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day).slice(0, 10), contacted: row.contacted, replied: row.replied, positive: row.positive })),
      steps: stepRows,
      delivery: {
        sent: funnel.rows[0].sent, delivered: funnel.rows[0].sent - funnel.rows[0].bounced, bounced: funnel.rows[0].bounced, bounceRate: pct(funnel.rows[0].bounced, funnel.rows[0].sent),
        replied: funnel.rows[0].replied, pending: funnel.rows[0].pending, suppressed: funnel.rows[0].suppressed, failed: funnel.rows[0].failed,
      },
      byInbox: byInbox.rows.map((r) => ({ id: r.id, email: r.email, sent: r.sent, bounced: r.bounced, bounceRate: pct(r.bounced, r.sent), replied: r.replied, replyRate: pct(r.replied, r.sent) })),
      placement: placement.rows[0].inbox + placement.rows[0].spam > 0 ? { tests: placement.rows[0].inbox + placement.rows[0].spam, inbox: placement.rows[0].inbox, spam: placement.rows[0].spam, inboxRate: pct(placement.rows[0].inbox, placement.rows[0].inbox + placement.rows[0].spam) } : null,
    };
  }

  async saveTargets(workspaceId, campaignId, { positiveRate, bookedRate }) {
    const read = (value, label) => {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || n > 100) throw bad(`${label} must be between 0 and 100.`);
      return Math.round(n * 100) / 100;
    };
    const positive = read(positiveRate, "The positive reply target");
    const booked = read(bookedRate, "The booked call target");
    const result = await db.query(`UPDATE campaigns SET target_positive_rate = $3, target_booked_rate = $4 WHERE id = $1 AND workspace_id = $2 AND is_deleted = FALSE AND is_warmup = FALSE`, [Number(campaignId), workspaceId, positive, booked]);
    if (result.rowCount === 0) throw bad("Campaign not found.", 404);
    return { positiveRate: positive, bookedRate: booked };
  }
}

module.exports = new CampaignInsightsService();
