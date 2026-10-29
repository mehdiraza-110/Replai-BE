const db = require("../../config/db.config");
const { INTEREST_RANK, stripQuoted } = require("./classifier.service");

const OUTCOMES = ["none", "escalated", "meeting_booked", "do_not_contact", "out_of_office", "auto_reply", "declined"];
const INTERESTS = Object.keys(INTEREST_RANK);
const FOLDERS = ["inbox", "attention", "favorites", "disabled"];

const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

/**
 * One row per thread that has at least one reply from the prospect, newest activity first, joined with its
 * SDR state. A thread is a mailbox + prospect pair (messages.thread_id). Campaign sends nobody replied to
 * are not inbox threads.
 */
const THREADS_CTE = `
  WITH latest AS (
    SELECT DISTINCT ON (m.mailbox_id, m.thread_id)
      m.id, m.mailbox_id, m.thread_id, m.direction, m.campaign_id, m.campaign_lead_id, m.from_address, m.to_address,
      m.subject, m.body_text, m.created_at, m.workspace_id,
      mb.email AS mailbox_email, mb.display_name AS mailbox_display_name,
      c.name AS campaign_name,
      cl.full_name AS lead_name, cl.first_name AS lead_first_name, cl.company AS lead_company
    FROM messages m
    JOIN mailboxes mb ON mb.id = m.mailbox_id AND mb.workspace_id = m.workspace_id
    LEFT JOIN campaigns c ON c.id = m.campaign_id AND c.workspace_id = m.workspace_id
    LEFT JOIN campaign_leads cl ON cl.id = m.campaign_lead_id AND cl.workspace_id = m.workspace_id
    WHERE m.workspace_id = $1 AND COALESCE(c.is_warmup, FALSE) = FALSE
    ORDER BY m.mailbox_id, m.thread_id, m.created_at DESC
  ),
  threads AS (
    SELECT l.*,
      COALESCE(s.outcome, 'none') AS outcome,
      COALESCE(s.interest, 'none') AS interest,
      COALESCE(s.is_favorite, FALSE) AS is_favorite,
      COALESCE(s.ai_disabled, FALSE) AS ai_disabled,
      COALESCE(s.needs_attention, FALSE) AS needs_attention,
      s.attention_reason, s.follow_up_at, COALESCE(s.followup_count, 0) AS followup_count, s.followup_by,
      (SELECT COUNT(*)::int FROM messages um WHERE um.workspace_id = $1 AND um.mailbox_id = l.mailbox_id AND um.thread_id = l.thread_id AND um.direction = 'inbound' AND um.is_read = FALSE) AS unread_count,
      (SELECT COUNT(*)::int FROM messages tm WHERE tm.workspace_id = $1 AND tm.mailbox_id = l.mailbox_id AND tm.thread_id = l.thread_id) AS message_count
    FROM latest l
    LEFT JOIN sdr_thread_state s ON s.workspace_id = l.workspace_id AND s.mailbox_id = l.mailbox_id AND s.thread_id = l.thread_id
    WHERE EXISTS (SELECT 1 FROM messages im WHERE im.workspace_id = $1 AND im.mailbox_id = l.mailbox_id AND im.thread_id = l.thread_id AND im.direction = 'inbound')
  )`;

function mapThread(row) {
  const name = row.lead_name || row.lead_first_name || null;
  const prospectEmail = row.direction === "inbound" ? row.from_address : row.to_address;
  return {
    mailboxId: row.mailbox_id,
    threadId: row.thread_id,
    prospectName: name || prospectEmail,
    prospectEmail,
    company: row.lead_company || null,
    subject: row.subject || "(no subject)",
    // Only the new text: the quoted earlier messages would repeat our own email back in the list.
    preview: stripQuoted(row.body_text || "").replace(/\s+/g, " ").trim().slice(0, 180) || String(row.body_text || "").replace(/\s+/g, " ").trim().slice(0, 180),
    lastMessageAt: row.created_at,
    lastDirection: row.direction,
    unreadCount: row.unread_count,
    messageCount: row.message_count,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    mailboxEmail: row.mailbox_email,
    outcome: row.outcome,
    interest: row.interest,
    isFavorite: row.is_favorite,
    aiDisabled: row.ai_disabled,
    needsAttention: row.needs_attention,
    attentionReason: row.attention_reason,
    followUpAt: row.follow_up_at,
    // "New" until we replied; "Replied" once the latest message is ours.
    replyState: row.direction === "outbound" ? "replied" : "new",
  };
}

class ThreadStateService {
  async list(workspaceId, { folder = "inbox", campaignId = null, outcome = null, search = "", page = 1, limit = 20 } = {}) {
    if (!FOLDERS.includes(folder)) throw bad("Unknown folder.");
    const pageNum = Math.max(1, Number.parseInt(page, 10) || 1);
    const limitNum = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 100);

    const params = [workspaceId];
    const where = [];
    if (folder === "attention") where.push("needs_attention");
    if (folder === "favorites") where.push("is_favorite");
    if (folder === "disabled") where.push("ai_disabled");
    if (campaignId) {
      params.push(Number(campaignId));
      where.push(`campaign_id = $${params.length}`);
    }
    if (outcome) {
      if (!OUTCOMES.includes(outcome)) throw bad("Unknown status filter.");
      params.push(outcome);
      where.push(`outcome = $${params.length}`);
    }
    const term = String(search || "").trim().slice(0, 200);
    if (term) {
      params.push(`%${term.replace(/[%_\\]/g, "\\$&")}%`);
      const p = `$${params.length}`;
      where.push(`(subject ILIKE ${p} OR from_address ILIKE ${p} OR to_address ILIKE ${p} OR body_text ILIKE ${p} OR lead_name ILIKE ${p} OR lead_company ILIKE ${p})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [items, total, counts] = await Promise.all([
      db.query(`${THREADS_CTE} SELECT * FROM threads ${whereSql} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limitNum, (pageNum - 1) * limitNum]),
      db.query(`${THREADS_CTE} SELECT COUNT(*)::int AS count FROM threads ${whereSql}`, params),
      db.query(
        `${THREADS_CTE}
         SELECT
           COUNT(*)::int AS inbox_total, COUNT(*) FILTER (WHERE unread_count > 0)::int AS inbox_unread,
           COUNT(*) FILTER (WHERE needs_attention)::int AS attention_total, COUNT(*) FILTER (WHERE needs_attention AND unread_count > 0)::int AS attention_unread,
           COUNT(*) FILTER (WHERE is_favorite)::int AS favorites_total,
           COUNT(*) FILTER (WHERE ai_disabled)::int AS disabled_total
         FROM threads`,
        [workspaceId]
      ),
    ]);

    const c = counts.rows[0];
    return {
      items: items.rows.map(mapThread),
      page: pageNum,
      limit: limitNum,
      total: total.rows[0].count,
      totalPages: Math.max(1, Math.ceil(total.rows[0].count / limitNum)),
      counts: {
        inbox: { unread: c.inbox_unread, total: c.inbox_total },
        attention: { unread: c.attention_unread, total: c.attention_total },
        favorites: { total: c.favorites_total },
        disabled: { total: c.disabled_total },
      },
    };
  }

  /** Campaigns that have threads, for the "Filter by campaign" menu. */
  async campaignsWithThreads(workspaceId) {
    const { rows } = await db.query(
      `SELECT c.id, c.name FROM campaigns c
       WHERE c.workspace_id = $1 AND c.is_deleted = FALSE AND EXISTS (SELECT 1 FROM messages m WHERE m.workspace_id = $1 AND m.campaign_id = c.id AND m.direction = 'inbound')
       ORDER BY c.name`,
      [workspaceId]
    );
    return rows;
  }

  async detail(workspaceId, mailboxId, threadId) {
    const { rows: messageRows } = await db.query(
      `SELECT * FROM messages WHERE workspace_id = $1 AND mailbox_id = $2 AND thread_id = $3 ORDER BY created_at ASC, id ASC`,
      [workspaceId, mailboxId, threadId]
    );
    if (messageRows.length === 0) throw bad("Thread not found.", 404);

    const [{ rows: mailboxRows }, { rows: stateRows }, { rows: draftRows }, { rows: bookingRows }] = await Promise.all([
      db.query(`SELECT id, email, display_name FROM mailboxes WHERE id = $1 AND workspace_id = $2`, [mailboxId, workspaceId]),
      db.query(`SELECT * FROM sdr_thread_state WHERE workspace_id = $1 AND mailbox_id = $2 AND thread_id = $3`, [workspaceId, mailboxId, threadId]),
      db.query(
        `SELECT id, subject, body, intent, interest, generated_by, created_at FROM sdr_drafts
         WHERE workspace_id = $1 AND mailbox_id = $2 AND thread_id = $3 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
        [workspaceId, mailboxId, threadId]
      ),
      db.query(
        `SELECT id, scheduled_start, scheduled_end, meet_link, lead_name FROM sdr_bookings WHERE workspace_id = $1 AND mailbox_id = $2 AND thread_id = $3 AND status = 'booked' ORDER BY scheduled_start`,
        [workspaceId, mailboxId, threadId]
      ),
    ]);

    const leadId = [...messageRows].reverse().find((row) => row.campaign_lead_id)?.campaign_lead_id;
    const campaignId = [...messageRows].reverse().find((row) => row.campaign_id)?.campaign_id;
    const [{ rows: leadRows }, { rows: campaignRows }] = await Promise.all([
      leadId ? db.query(`SELECT * FROM campaign_leads WHERE id = $1 AND workspace_id = $2`, [leadId, workspaceId]) : { rows: [] },
      campaignId ? db.query(`SELECT id, name FROM campaigns WHERE id = $1 AND workspace_id = $2`, [campaignId, workspaceId]) : { rows: [] },
    ]);
    const lead = leadRows[0] || null;
    const raw = (lead && typeof lead.raw_data === "object" && lead.raw_data) || {};
    const pick = (...keys) => {
      for (const key of keys) {
        const hit = Object.keys(raw).find((name) => name.toLowerCase().replace(/[^a-z]/g, "") === key);
        if (hit && raw[hit]) return String(raw[hit]);
      }
      return null;
    };

    const firstInbound = messageRows.findIndex((row) => row.direction === "inbound");
    const state = stateRows[0];
    const prospectEmail = messageRows.find((row) => row.direction === "inbound")?.from_address || lead?.email || null;

    return {
      mailbox: mailboxRows[0] ? { id: mailboxRows[0].id, email: mailboxRows[0].email, displayName: mailboxRows[0].display_name } : null,
      state: {
        outcome: state?.outcome || "none",
        interest: state?.interest || "none",
        isFavorite: state?.is_favorite || false,
        aiDisabled: state?.ai_disabled || false,
        needsAttention: state?.needs_attention || false,
        attentionReason: state?.attention_reason || null,
        classifiedBy: state?.classified_by || null,
        followUpAt: state?.follow_up_at || null,
        followupBy: state?.followup_by || null,
        followupCount: state?.followup_count || 0,
      },
      contact: {
        name: lead?.full_name || [lead?.first_name, lead?.last_name].filter(Boolean).join(" ") || prospectEmail,
        email: prospectEmail,
        company: lead?.company || pick("companyname", "company"),
        jobTitle: lead?.role || pick("jobtitle", "title", "role"),
        website: pick("website", "companywebsite"),
        industry: pick("industry"),
        linkedin: pick("linkedinurl", "linkedin"),
        location: pick("location", "city") ? [pick("city"), pick("stateprovince", "state"), pick("country")].filter(Boolean).join(", ") || pick("location") : null,
        phone: lead?.phone || pick("phone"),
        campaign: campaignRows[0] || null,
      },
      messages: messageRows.map((row, index) => ({
        id: row.id,
        direction: row.direction,
        // prospect | ai | you | campaign
        kind: row.direction === "inbound" ? "prospect" : row.author === "ai" ? "ai" : row.author === "human" ? "you" : row.author === "campaign" || index < firstInbound || firstInbound === -1 ? "campaign" : "you",
        fromAddress: row.from_address,
        toAddress: row.to_address,
        subject: row.subject,
        bodyText: row.body_text,
        isRead: row.is_read,
        createdAt: row.created_at,
      })),
      bookings: bookingRows.map((row) => ({ id: row.id, startTime: row.scheduled_start, endTime: row.scheduled_end, meetLink: row.meet_link })),
      pendingDraft: draftRows[0]
        ? { id: draftRows[0].id, subject: draftRows[0].subject, body: draftRows[0].body, intent: draftRows[0].intent, interest: draftRows[0].interest, generatedBy: draftRows[0].generated_by, createdAt: draftRows[0].created_at }
        : null,
    };
  }

  /** Writes only the fields given; creates the row on first touch. */
  async patch(workspaceId, mailboxId, threadId, input, { by = "manual" } = {}) {
    const columns = [];
    const values = [workspaceId, mailboxId, threadId];
    const set = (column, value) => {
      values.push(value);
      columns.push([column, `$${values.length}`]);
    };

    if (input.outcome !== undefined) {
      if (!OUTCOMES.includes(input.outcome)) throw bad("Unknown status.");
      set("outcome", input.outcome);
      set("classified_by", by);
    }
    if (input.interest !== undefined) {
      if (!INTERESTS.includes(input.interest)) throw bad("Unknown interest level.");
      set("interest", input.interest);
    }
    if (input.isFavorite !== undefined) set("is_favorite", Boolean(input.isFavorite));
    if (input.aiDisabled !== undefined) set("ai_disabled", Boolean(input.aiDisabled));
    if (input.needsAttention !== undefined) {
      set("needs_attention", Boolean(input.needsAttention));
      if (!input.needsAttention) set("attention_reason", null);
    }
    if (input.attentionReason !== undefined) set("attention_reason", input.attentionReason ? String(input.attentionReason).slice(0, 500) : null);
    if (input.classifiedMessageId !== undefined) set("classified_message_id", input.classifiedMessageId);
    if (input.followUpAt !== undefined) set("follow_up_at", input.followUpAt);
    if (input.followupBy !== undefined) set("followup_by", input.followupBy);
    if (input.followupCount !== undefined) set("followup_count", input.followupCount);

    const { rows: exists } = await db.query(`SELECT 1 FROM messages WHERE workspace_id = $1 AND mailbox_id = $2 AND thread_id = $3 LIMIT 1`, [workspaceId, mailboxId, threadId]);
    if (exists.length === 0) throw bad("Thread not found.", 404);

    const insertCols = columns.map(([column]) => column);
    const insertVals = columns.map(([, ref]) => ref);
    const updateSql = columns.map(([column]) => `${column} = EXCLUDED.${column}`).concat("updated_at = NOW()").join(", ");
    await db.query(
      `INSERT INTO sdr_thread_state (workspace_id, mailbox_id, thread_id${insertCols.length ? `, ${insertCols.join(", ")}` : ""})
       VALUES ($1, $2, $3${insertVals.length ? `, ${insertVals.join(", ")}` : ""})
       ON CONFLICT (workspace_id, mailbox_id, thread_id) DO UPDATE SET ${updateSql}`,
      values
    );
    return this.getState(workspaceId, mailboxId, threadId);
  }

  async getState(workspaceId, mailboxId, threadId) {
    const { rows } = await db.query(`SELECT * FROM sdr_thread_state WHERE workspace_id = $1 AND mailbox_id = $2 AND thread_id = $3`, [workspaceId, mailboxId, threadId]);
    return rows[0] || null;
  }

  /** Applies one action to many threads. Every thread is checked against the workspace by `patch` / the queries. */
  async bulk(workspaceId, threads, action) {
    if (!Array.isArray(threads) || threads.length === 0) throw bad("Select at least one thread.");
    if (threads.length > 200) throw bad("Select fewer threads at a time and try again.");
    const actions = {
      read: async (t) => db.query(`UPDATE messages SET is_read = TRUE WHERE workspace_id = $1 AND mailbox_id = $2 AND thread_id = $3 AND direction = 'inbound' AND is_read = FALSE`, [workspaceId, t.mailboxId, t.threadId]),
      unread: async (t) =>
        db.query(
          `UPDATE messages SET is_read = FALSE WHERE id = (SELECT id FROM messages WHERE workspace_id = $1 AND mailbox_id = $2 AND thread_id = $3 AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1)`,
          [workspaceId, t.mailboxId, t.threadId]
        ),
      favorite: (t) => this.patch(workspaceId, t.mailboxId, t.threadId, { isFavorite: true }),
      unfavorite: (t) => this.patch(workspaceId, t.mailboxId, t.threadId, { isFavorite: false }),
      disable_ai: (t) => this.patch(workspaceId, t.mailboxId, t.threadId, { aiDisabled: true }),
      enable_ai: (t) => this.patch(workspaceId, t.mailboxId, t.threadId, { aiDisabled: false }),
      resolve: (t) => this.patch(workspaceId, t.mailboxId, t.threadId, { needsAttention: false }),
    };
    if (!actions[action]) throw bad("Unknown action.");

    let done = 0;
    for (const thread of threads) {
      const mailboxId = Number(thread?.mailboxId);
      const threadId = String(thread?.threadId || "");
      if (!Number.isInteger(mailboxId) || !threadId) continue;
      await actions[action]({ mailboxId, threadId });
      done += 1;
    }
    return { updated: done };
  }
}

module.exports = new ThreadStateService();
module.exports.OUTCOMES = OUTCOMES;
module.exports.INTERESTS = INTERESTS;
