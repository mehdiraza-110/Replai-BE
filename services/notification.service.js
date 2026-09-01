const db = require("../config/db.config");

// Only a curated subset of event_logs event types are surfaced as user-facing
// notifications — most events (page views, listings, syncs) are too noisy.
const NOTIFICATION_RULES = {
  "ai.draft.generated": {
    title: "Human review required",
    tone: "warning",
    describe: (row) => `${row.lead_email || "A lead"} has a new AI draft waiting for approval.`,
  },
  "ai.draft.webhook_generated": {
    title: "Human review required",
    tone: "warning",
    describe: (row) => `${row.lead_email || "A lead"} has a new AI draft waiting for approval.`,
  },
  "ai.draft.approved_sent": {
    title: "AI reply sent",
    tone: "success",
    describe: (row) => `Reply sent to ${row.lead_email || "a lead"}${row.ai_agent_name ? ` by ${row.ai_agent_name}` : ""}.`,
  },
  "plusvibe.reply.manual_sent": {
    title: "Reply sent",
    tone: "success",
    describe: (row) => `Manual reply sent to ${row.lead_email || "a lead"}.`,
  },
  "ai.draft.rejected": {
    title: "Draft rejected",
    tone: "danger",
    describe: (row) => `A draft for ${row.lead_email || "a lead"} was rejected in review.`,
  },
  "ai.draft.webhook_failed": {
    title: "AI draft failed",
    tone: "danger",
    describe: (row) => row.error_message || "A webhook-triggered draft could not be generated.",
  },
  "knowledge_source.created": {
    title: "Knowledge source added",
    tone: "accent",
    describe: (row) => `"${row.metadata?.title || row.metadata?.fileName || "A new source"}" was added to the knowledge base.`,
  },
  "knowledge_source.deleted": {
    title: "Knowledge source removed",
    tone: "default",
    describe: (row) => `"${row.metadata?.title || "A source"}" was removed from the knowledge base.`,
  },
  "ai_agent.created": {
    title: "AI agent created",
    tone: "accent",
    describe: (row) => `${row.ai_agent_name || "A new agent"} is ready to start replying.`,
  },
  "ai_agent.deleted": {
    title: "AI agent deleted",
    tone: "default",
    describe: (row) => `${row.ai_agent_name || "An agent"} was removed.`,
  },
  "plusvibe.connection.created": {
    title: "PlusVibe connected",
    tone: "success",
    describe: (row) => `${row.workspace_name || "A workspace"} is now connected to PlusVibe.`,
  },
  "plusvibe.connection.test_failed": {
    title: "Integration issue",
    tone: "danger",
    describe: (row) => row.error_message || `PlusVibe connection test failed for ${row.workspace_name || "your workspace"}.`,
  },
  "plusvibe.connection.refresh_failed": {
    title: "Integration disconnected",
    tone: "danger",
    describe: (row) => row.error_message || `PlusVibe access for ${row.workspace_name || "your workspace"} needs to be reconnected.`,
  },
  "plusvibe.campaign.agent_assigned": {
    title: "Agent assigned to campaign",
    tone: "accent",
    describe: (row) => `${row.ai_agent_name || "An agent"} is now handling ${row.campaign_name || "a campaign"}.`,
  },
};

const NOTIFICATION_EVENT_TYPES = Object.keys(NOTIFICATION_RULES);

class NotificationService {
  async list(query = {}) {
    const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 20, 1), 100);
    const offset = (page - 1) * limit;

    const [items, total] = await Promise.all([
      db.query(
        `SELECT *
         FROM event_logs
         WHERE event_type = ANY($1)
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [NOTIFICATION_EVENT_TYPES, limit, offset]
      ),
      db.query(`SELECT COUNT(*)::int AS count FROM event_logs WHERE event_type = ANY($1)`, [NOTIFICATION_EVENT_TYPES]),
    ]);

    const count = total.rows[0]?.count || 0;

    return {
      items: items.rows.map(mapNotificationRow).filter(Boolean),
      page,
      limit,
      total: count,
      totalPages: Math.max(1, Math.ceil(count / limit)),
    };
  }
}

function mapNotificationRow(row) {
  const rule = NOTIFICATION_RULES[row.event_type];
  if (!rule) return null;

  const tone = row.status === "Failed" ? "danger" : rule.tone;

  return {
    id: `event-${row.id}`,
    type: row.event_type,
    title: rule.title,
    description: rule.describe(row),
    tone,
    createdAt: row.created_at,
  };
}

module.exports = new NotificationService();
