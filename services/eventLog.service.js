const db = require("../config/db.config");
const realtimeService = require("./realtime.service");

class EventLogService {
  async record(event = {}) {
    try {
      const result = await db.query(
        `INSERT INTO event_logs (
          event_type,
          source,
          status,
          workspace_id,
          workspace_name,
          campaign_id,
          campaign_name,
          ai_agent_id,
          ai_agent_name,
          lead_email,
          thread_id,
          message_id,
          draft_id,
          duration_ms,
          error_message,
          metadata,
          created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        RETURNING *`,
        [
          cleanString(event.eventType || event.event_type) || "system.event",
          cleanString(event.source) || "system",
          cleanString(event.status) || "Success",
          cleanString(event.workspaceId || event.workspace_id),
          cleanString(event.workspaceName || event.workspace_name),
          cleanString(event.campaignId || event.campaign_id),
          cleanString(event.campaignName || event.campaign_name),
          event.aiAgentId || event.ai_agent_id || null,
          cleanString(event.aiAgentName || event.ai_agent_name),
          cleanString(event.leadEmail || event.lead_email),
          cleanString(event.threadId || event.thread_id),
          cleanString(event.messageId || event.message_id),
          event.draftId || event.draft_id || null,
          normalizeDuration(event.durationMs || event.duration_ms),
          cleanString(event.errorMessage || event.error_message),
          JSON.stringify(event.metadata || {}),
          event.createdBy || event.created_by || null,
        ]
      );

      const mapped = mapEventRow(result.rows[0]);

      // Every meaningful mutation across the app already flows through here, so
      // this single hook is enough to keep every connected browser tab live —
      // no matter which page it's on — without wiring a broadcast into each
      // individual service method.
      realtimeService.broadcast("event", mapped);

      return mapped;
    } catch (error) {
      console.error("Event log write failed:", error.message);
      return null;
    }
  }

  async list(query = {}) {
    const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 10, 1), 50);
    const offset = (page - 1) * limit;

    const [items, total] = await Promise.all([
      db.query(
        `SELECT *
         FROM event_logs
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      db.query(`SELECT COUNT(*)::int AS count FROM event_logs`),
    ]);

    const count = total.rows[0]?.count || 0;

    return {
      items: items.rows.map(mapEventRow),
      page,
      limit,
      total: count,
      totalPages: Math.max(1, Math.ceil(count / limit)),
    };
  }
}

function mapEventRow(row) {
  return {
    id: row.id,
    eventType: row.event_type,
    source: row.source,
    status: row.status,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    aiAgentId: row.ai_agent_id,
    aiAgentName: row.ai_agent_name,
    leadEmail: row.lead_email,
    threadId: row.thread_id,
    messageId: row.message_id,
    draftId: row.draft_id,
    durationMs: row.duration_ms,
    errorMessage: row.error_message,
    metadata: row.metadata || {},
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function normalizeDuration(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.max(0, Math.round(numberValue)) : null;
}

function cleanString(value) {
  if (value === undefined || value === null) return null;

  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

module.exports = new EventLogService();
