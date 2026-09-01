const db = require("../config/db.config");

// Leads are "forwarded" whenever an AI-approved (or, once implemented, auto-sent)
// reply is pushed out to an external platform — currently just GHL Conversations.
const FORWARDED_LEAD_EVENT_TYPES = ["ghl.conversation.synced", "ghl.conversation.sync_failed"];

class ForwardedLeadService {
  async list(query = {}) {
    const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 10, 1), 50);
    const offset = (page - 1) * limit;

    const [items, total] = await Promise.all([
      db.query(
        `SELECT *
         FROM event_logs
         WHERE event_type = ANY($1)
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [FORWARDED_LEAD_EVENT_TYPES, limit, offset]
      ),
      db.query(`SELECT COUNT(*)::int AS count FROM event_logs WHERE event_type = ANY($1)`, [FORWARDED_LEAD_EVENT_TYPES]),
    ]);

    const count = total.rows[0]?.count || 0;

    return {
      items: items.rows.map(mapForwardedLeadRow),
      page,
      limit,
      total: count,
      totalPages: Math.max(1, Math.ceil(count / limit)),
    };
  }
}

function mapForwardedLeadRow(row) {
  return {
    id: row.id,
    leadEmail: row.lead_email,
    platform: platformFromSource(row.source),
    destination: row.workspace_name,
    status: row.status === "Failed" ? "Failed" : "Forwarded",
    contactId: row.metadata?.contactId || null,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  };
}

function platformFromSource(source) {
  if (source === "ghl") return "GoHighLevel";
  return source ? source.charAt(0).toUpperCase() + source.slice(1) : "Unknown";
}

module.exports = new ForwardedLeadService();
