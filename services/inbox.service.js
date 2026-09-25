const { SendEmailCommand } = require("@aws-sdk/client-sesv2");
const db = require("../config/db.config");
const suppressionService = require("./suppression.service");
const { buildRawMimeMessage, threadIdFor, sesClient } = require("./campaignSend.service");

/**
 * The unified inbox: every thread (one per mailbox+lead pair) across every mailbox,
 * newest-activity first — the single screen a rep works from instead of opening each
 * mailbox individually. Still app-native (see PlusVibe-Plan.md 1B/1C), not a real
 * IMAP/SMTP mailbox.
 */
class InboxService {
  async listThreads({ page = 1, limit = 25, search = "", mailboxId = null, unreadOnly = false } = {}) {
    const pageNum = Math.max(1, Number.parseInt(page, 10) || 1);
    const limitNum = Math.min(Math.max(Number.parseInt(limit, 10) || 25, 1), 100);
    const offset = (pageNum - 1) * limitNum;

    const conditions = [];
    const params = [];

    if (mailboxId) {
      params.push(Number(mailboxId));
      conditions.push(`latest.mailbox_id = $${params.length}`);
    }
    const searchTerm = String(search || "").trim();
    if (searchTerm) {
      params.push(`%${searchTerm}%`);
      conditions.push(`(latest.subject ILIKE $${params.length} OR latest.from_address ILIKE $${params.length} OR latest.to_address ILIKE $${params.length})`);
    }
    if (unreadOnly) {
      conditions.push(`latest.direction = 'inbound' AND latest.is_read = FALSE`);
    }
    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const baseQuery = `
      SELECT DISTINCT ON (m.mailbox_id, m.thread_id)
        m.id, m.mailbox_id, m.thread_id, m.direction, m.campaign_id, m.campaign_lead_id,
        m.from_address, m.to_address, m.subject, m.body_text, m.is_read, m.created_at,
        mb.email AS mailbox_email, mb.display_name AS mailbox_display_name,
        c.name AS campaign_name
      FROM messages m
      JOIN mailboxes mb ON mb.id = m.mailbox_id
      LEFT JOIN campaigns c ON c.id = m.campaign_id
      ORDER BY m.mailbox_id, m.thread_id, m.created_at DESC
    `;

    const [itemsResult, totalResult, unreadResult] = await Promise.all([
      db.query(
        `SELECT latest.*, (
           SELECT COUNT(*)::int FROM messages um
           WHERE um.mailbox_id = latest.mailbox_id AND um.thread_id = latest.thread_id
             AND um.direction = 'inbound' AND um.is_read = FALSE
         ) AS unread_count
         FROM (${baseQuery}) latest
         ${whereClause}
         ORDER BY latest.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limitNum, offset]
      ),
      db.query(`SELECT COUNT(*)::int AS count FROM (${baseQuery}) latest ${whereClause}`, params),
      db.query(
        `SELECT COUNT(DISTINCT (mailbox_id, thread_id))::int AS count FROM messages
         WHERE direction = 'inbound' AND is_read = FALSE`
      ),
    ]);

    const total = totalResult.rows[0]?.count || 0;
    return {
      items: itemsResult.rows.map(mapThreadRow),
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.max(1, Math.ceil(total / limitNum)),
      totalUnreadThreads: unreadResult.rows[0]?.count || 0,
    };
  }

  async getThread(mailboxId, threadId) {
    const { rows: mailboxRows } = await db.query(
      `SELECT m.*, d.status AS domain_status, d.configuration_set_name
       FROM mailboxes m JOIN domains d ON d.id = m.domain_id
       WHERE m.id = $1 AND m.is_deleted = FALSE`,
      [mailboxId]
    );
    const mailbox = mailboxRows[0];
    if (!mailbox) {
      throw Object.assign(new Error("Mailbox not found"), { statusCode: 404 });
    }

    const { rows: messageRows } = await db.query(
      `SELECT * FROM messages WHERE mailbox_id = $1 AND thread_id = $2 ORDER BY created_at ASC`,
      [mailboxId, threadId]
    );
    if (messageRows.length === 0) {
      throw Object.assign(new Error("Thread not found"), { statusCode: 404 });
    }

    let leadName = null;
    const campaignLeadId = [...messageRows].reverse().find((row) => row.campaign_lead_id)?.campaign_lead_id;
    if (campaignLeadId) {
      const { rows: leadRows } = await db.query(`SELECT full_name FROM campaign_leads WHERE id = $1`, [campaignLeadId]);
      leadName = leadRows[0]?.full_name || null;
    }

    return {
      mailbox: { id: mailbox.id, email: mailbox.email, displayName: mailbox.display_name },
      leadEmail: messageRows.find((row) => row.direction === "inbound")?.from_address
        || messageRows.find((row) => row.direction === "outbound")?.to_address,
      leadName,
      messages: messageRows.map(mapMessageRow),
    };
  }

  async markThreadRead(mailboxId, threadId) {
    await db.query(
      `UPDATE messages SET is_read = TRUE WHERE mailbox_id = $1 AND thread_id = $2 AND direction = 'inbound' AND is_read = FALSE`,
      [mailboxId, threadId]
    );
    return { status: "Ok" };
  }

  /**
   * Reply from inside a unified-inbox thread. Sends from the exact mailbox that owns the
   * thread (never a central address, per PlusVibe-Plan.md section 7's requirement) and
   * records it the same way a campaign send does, so it shows up in the thread immediately.
   */
  async sendReply(mailboxId, threadId, { body }) {
    const trimmedBody = String(body || "").trim();
    if (!trimmedBody) {
      throw Object.assign(new Error("Reply body is required"), { statusCode: 400 });
    }

    const { rows: mailboxRows } = await db.query(
      `SELECT m.*, d.status AS domain_status, d.configuration_set_name
       FROM mailboxes m JOIN domains d ON d.id = m.domain_id
       WHERE m.id = $1 AND m.is_deleted = FALSE`,
      [mailboxId]
    );
    const mailbox = mailboxRows[0];
    if (!mailbox) {
      throw Object.assign(new Error("Mailbox not found"), { statusCode: 404 });
    }
    if (mailbox.domain_status !== "Verified") {
      throw Object.assign(new Error("This mailbox's domain is not SES-verified"), { statusCode: 409 });
    }

    const { rows: threadRows } = await db.query(
      `SELECT * FROM messages WHERE mailbox_id = $1 AND thread_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [mailboxId, threadId]
    );
    const latest = threadRows[0];
    if (!latest) {
      throw Object.assign(new Error("Thread not found"), { statusCode: 404 });
    }

    const leadEmail = latest.direction === "inbound" ? latest.from_address : latest.to_address;
    if (await suppressionService.isSuppressed(leadEmail)) {
      throw Object.assign(new Error("This recipient has unsubscribed and cannot be emailed"), { statusCode: 409 });
    }

    const subject = latest.subject?.toLowerCase().startsWith("re:") ? latest.subject : `Re: ${latest.subject || ""}`.trim();
    const fromAddress = mailbox.display_name ? `"${escapeHeaderValue(mailbox.display_name)}" <${mailbox.email}>` : mailbox.email;
    const listUnsubscribeHeaders = suppressionService.buildListUnsubscribeHeaders({ email: leadEmail, campaignId: latest.campaign_id });

    const { raw, messageId } = buildRawMimeMessage({
      from: fromAddress,
      to: leadEmail,
      subject,
      body: trimmedBody,
      extraHeaders: latest.message_id ? { ...listUnsubscribeHeaders, "In-Reply-To": latest.message_id } : listUnsubscribeHeaders,
    });

    const command = new SendEmailCommand({
      FromEmailAddress: fromAddress,
      Destination: { ToAddresses: [leadEmail] },
      Content: { Raw: { Data: raw } },
      ConfigurationSetName: mailbox.configuration_set_name || undefined,
      EmailTags: latest.campaign_id ? [{ Name: "campaign_id", Value: String(latest.campaign_id) }] : undefined,
    });
    await sesClient.send(command);

    const { rows: inserted } = await db.query(
      `INSERT INTO messages (mailbox_id, direction, campaign_id, campaign_lead_id, thread_id, message_id, in_reply_to, from_address, to_address, subject, body_text)
       VALUES ($1, 'outbound', $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [mailboxId, latest.campaign_id, latest.campaign_lead_id, threadIdFor(mailboxId, leadEmail), messageId, latest.message_id, mailbox.email, leadEmail, subject, trimmedBody]
    );

    return mapMessageRow(inserted[0]);
  }
}

function mapThreadRow(row) {
  return {
    mailboxId: row.mailbox_id,
    mailboxEmail: row.mailbox_email,
    mailboxDisplayName: row.mailbox_display_name,
    threadId: row.thread_id,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    lastDirection: row.direction,
    fromAddress: row.from_address,
    toAddress: row.to_address,
    subject: row.subject,
    preview: (row.body_text || "").slice(0, 140),
    unreadCount: row.unread_count || 0,
    lastMessageAt: row.created_at,
  };
}

function mapMessageRow(row) {
  return {
    id: row.id,
    mailboxId: row.mailbox_id,
    direction: row.direction,
    campaignId: row.campaign_id,
    campaignLeadId: row.campaign_lead_id,
    threadId: row.thread_id,
    messageId: row.message_id,
    inReplyTo: row.in_reply_to,
    fromAddress: row.from_address,
    toAddress: row.to_address,
    subject: row.subject,
    bodyText: row.body_text,
    isRead: row.is_read,
    createdAt: row.created_at,
  };
}

function escapeHeaderValue(value) {
  return String(value || "").replace(/["\r\n]/g, "");
}

module.exports = new InboxService();
