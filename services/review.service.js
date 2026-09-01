const db = require("../config/db.config");
const eventLogService = require("./eventLog.service");

class ReviewService {
  async list(query = {}) {
    const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 10, 1), 50);
    const offset = (page - 1) * limit;

    const [items, total] = await Promise.all([
      db.query(
        `SELECT d.*,
                i.workspace_id,
                i.workspace_name,
                c.name AS campaign_name,
                a.name AS agent_name,
                a.status AS agent_status,
                p.lead_name,
                p.company_name,
                p.role_title
         FROM ai_response_drafts d
         LEFT JOIN plusvibe_integrations i ON i.id = d.integration_id
         LEFT JOIN plusvibe_campaigns c
           ON c.integration_id = d.integration_id
          AND c.plusvibe_campaign_id = d.plusvibe_campaign_id
          AND c.is_deleted = FALSE
         LEFT JOIN ai_agents a ON a.id = d.ai_agent_id
         LEFT JOIN plusvibe_lead_profiles p
           ON p.workspace_id = i.workspace_id
          AND p.lead_email = d.lead_email
         WHERE d.status = 'Pending'
           AND d.is_deleted = FALSE
         ORDER BY d.updated_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      db.query(
        `SELECT COUNT(*)::int AS count
         FROM ai_response_drafts
         WHERE status = 'Pending'
           AND is_deleted = FALSE`
      ),
    ]);

    const count = total.rows[0]?.count || 0;

    await eventLogService.record({
      eventType: "human_review.queue.listed",
      source: "human_review",
      status: "Success",
      metadata: { page, limit, count: items.rows.length },
    });

    return {
      items: items.rows.map(mapReviewRow),
      page,
      limit,
      total: count,
      totalPages: Math.max(1, Math.ceil(count / limit)),
    };
  }

  async count() {
    const result = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM ai_response_drafts
       WHERE status = 'Pending'
         AND is_deleted = FALSE`
    );

    return { count: result.rows[0]?.count || 0 };
  }
}

function mapReviewRow(row) {
  const context = row.raw_context || {};
  const triggerMessage = stripQuotedReply(context.latestReply);

  return {
    id: row.id,
    draftId: row.id,
    threadId: row.thread_id,
    replyToMessageId: row.reply_to_message_id,
    leadEmail: row.lead_email,
    leadName: row.lead_name || nameFromEmail(row.lead_email),
    company: row.company_name || "Lead",
    role: row.role_title || null,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    campaignId: row.plusvibe_campaign_id,
    campaignName: row.campaign_name || "PlusVibe campaign",
    agentId: row.ai_agent_id,
    agentName: row.agent_name || "Assigned AI agent",
    agentStatus: row.agent_status,
    subject: row.subject,
    from: row.from_email,
    to: row.to_email,
    triggerMessage,
    triggerPreview: truncate(triggerMessage || row.body, 180),
    body: row.body,
    confidence: Number(row.confidence),
    status: row.status,
    generatedBy: row.generated_by,
    generationError: row.generation_error,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
}

function truncate(value, maxLength) {
  const text = cleanString(value);
  if (!text) return null;
  if (text.length <= maxLength) return text;

  return `${text.slice(0, maxLength - 1).trim()}…`;
}

function stripQuotedReply(value) {
  const text = cleanString(value);
  if (!text) return null;

  const quotedMarkers = [
    /\n\s*On .+wrote:\s*/i,
    /\n\s*[-_]{2,}\s*Original Message\s*[-_]{2,}/i,
    /\n\s*From:\s.+\n\s*Sent:\s.+/i,
  ];
  const cutAt = quotedMarkers
    .map((marker) => {
      const match = text.match(marker);
      return match?.index ?? -1;
    })
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  const body = cutAt >= 0 ? text.slice(0, cutAt) : text;

  return cleanString(
    body
      .split("\n")
      .filter((line) => !line.trim().startsWith(">"))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
  );
}

function nameFromEmail(email) {
  const local = cleanString(email)?.split("@")[0];
  if (!local) return "Unknown lead";

  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function cleanString(value) {
  if (value === undefined || value === null) return null;

  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

module.exports = new ReviewService();
