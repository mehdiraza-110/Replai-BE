const db = require("../config/db.config");
const eventLogService = require("./eventLog.service");
const leadProfileService = require("./leadProfile.service");
const plusVibeService = require("./plusVibe.service");

const POSITIVE_LABELS = new Set(["INTERESTED", "MEETING_REQUEST", "QUESTION"]);
const MAX_THREAD_SCAN = 250;

class LeadService {
  async listPositiveLeads() {
    const startedAt = Date.now();
    const { integration, apiKey, workspace } = await plusVibeService.getAuthorizedWorkspace();
    const threads = await fetchThreads(apiKey, workspace.id);
    const positiveThreads = threads.filter(isPositiveThread);
    const campaignMap = await getCampaignMap(integration.id);
    const profileMap = await leadProfileService.getByEmails(workspace.id, positiveThreads.map(getThreadLeadEmail));
    const replyMap = await getReplyMap(positiveThreads.map((thread) => cleanString(thread.thread_id)));

    const items = positiveThreads
      .map((thread) => mapLead(thread, campaignMap, replyMap, profileMap))
      .filter(Boolean)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    const data = {
      items,
      stats: {
        totalLeads: items.length,
        highInterest: items.filter((lead) => lead.intent === "Interested" || lead.intent === "Meeting Request").length,
        meetingStage: items.filter((lead) => lead.stage === "Meeting").length,
        humanManaged: items.filter((lead) => lead.owner === "Human Managed").length,
      },
    };

    await eventLogService.record({
      eventType: "leads.positive.listed",
      source: "leads",
      status: "Success",
      workspaceId: workspace.id,
      workspaceName: integration.workspace_name,
      durationMs: Date.now() - startedAt,
      metadata: { count: items.length, scannedThreads: threads.length, positiveThreads: positiveThreads.length },
    });

    return data;
  }
}

async function fetchThreads(apiKey, workspaceId) {
  const threads = [];
  let pageTrail = "";

  do {
    const params = new URLSearchParams({
      workspace_id: workspaceId,
      limit: "50",
      page_trail: pageTrail,
    });
    const payload = await plusVibeService.request(`/api/v1/unibox/threads?${params.toString()}`, apiKey);
    const pageThreads = Array.isArray(payload.data) ? payload.data : [];

    threads.push(...pageThreads);
    pageTrail = cleanString(payload.page_trail) || "";
  } while (pageTrail && threads.length < MAX_THREAD_SCAN);

  return threads;
}

async function getCampaignMap(integrationId) {
  const result = await db.query(
    `SELECT c.*,
            a.name AS assigned_agent_name,
            a.status AS assigned_agent_status
     FROM plusvibe_campaigns c
     LEFT JOIN ai_agents a ON a.id = c.assigned_ai_agent_id
     WHERE c.integration_id = $1 AND c.is_deleted = FALSE`,
    [integrationId]
  );

  return new Map(result.rows.map((row) => [row.plusvibe_campaign_id, row]));
}

async function getReplyMap(threadIds) {
  const ids = [...new Set(threadIds.filter(Boolean))];
  if (ids.length === 0) return new Map();

  const [drafts, manualReplies] = await Promise.all([
    db.query(
      `SELECT d.thread_id,
              d.lead_email,
              d.plusvibe_campaign_id,
              d.updated_at,
              COALESCE(a.name, 'AI Agent') AS owner
       FROM ai_response_drafts d
       LEFT JOIN ai_agents a ON a.id = d.ai_agent_id
       WHERE d.thread_id = ANY($1::varchar[])
         AND d.status = 'Sent'
         AND d.is_deleted = FALSE`,
      [ids]
    ),
    db.query(
      `SELECT thread_id,
              lead_email,
              campaign_id AS plusvibe_campaign_id,
              created_at AS updated_at,
              'Human Managed' AS owner
       FROM event_logs
       WHERE thread_id = ANY($1::varchar[])
         AND event_type = 'plusvibe.reply.manual_sent'
         AND status = 'Success'`,
      [ids]
    ),
  ]);

  const replyMap = new Map();

  [...drafts.rows, ...manualReplies.rows].forEach((row) => {
    const threadId = cleanString(row.thread_id);
    if (!threadId) return;

    const current = replyMap.get(threadId);
    if (!current || new Date(row.updated_at).getTime() > new Date(current.updated_at).getTime()) {
      replyMap.set(threadId, row);
    }
  });

  return replyMap;
}

function mapLead(thread, campaignMap, replyMap, profileMap = new Map()) {
  const threadId = cleanString(thread.thread_id);
  const reply = replyMap.get(threadId);
  if (!reply) return null;

  const latest = thread.latest_message || {};
  const label = normalizeLabel(thread.label || latest.label);
  const campaignId = cleanString(thread.campaign_id || reply.plusvibe_campaign_id);
  const campaign = campaignMap.get(campaignId);
  const leadEmail = getThreadLeadEmail(thread) || cleanString(reply.lead_email);
  const profile = profileMap.get(leadEmail);
  const leadName = profile?.leadName || getThreadLeadName(thread) || nameFromEmail(leadEmail);
  const company = profile?.companyName || companyFromThread(thread, latest, leadEmail);
  const updatedAt = cleanString(latest.timestamp || latest.timestamp_created || reply.updated_at) || new Date().toISOString();

  return {
    id: threadId,
    threadId,
    name: leadName,
    email: leadEmail || "Unknown email",
    company,
    role: profile?.roleTitle || cleanString(thread.lead_title || latest.lead_title || thread.job_title) || "Lead",
    campaign: campaign?.name || cleanString(thread.campaign_name) || "PlusVibe campaign",
    campaignId,
    intent: intentFromLabel(label),
    sentiment: sentimentFromLabel(label),
    stage: stageFromLabel(label),
    owner: reply.owner || campaign?.assigned_agent_name || "Human Managed",
    updated: updatedAt,
    updatedAt,
  };
}

function getThreadLeadEmail(thread) {
  const latest = thread.latest_message || {};
  const latestDirection = getMessageDirection(latest);

  return cleanString(
    thread.lead ||
    (latestDirection === "prospect" ? latest.from_address_email : latest.to_address_email_list) ||
    latest.from_address_email
  );
}

function getThreadLeadName(thread) {
  const latest = thread.latest_message || {};
  return getMessageDirection(latest) === "prospect" ? addressName(latest.from_address_json) : null;
}

function getMessageDirection(message) {
  const type = String(message.type || message.email_type || "").toLowerCase();
  if (type.includes("received") || type === "in") return "prospect";
  if (type.includes("sent") || type === "out") return "human";
  return cleanString(message.from_address_email) === cleanString(message.lead) ? "prospect" : "human";
}

function isPositiveThread(thread) {
  const label = normalizeLabel(thread.label || thread.latest_message?.label);
  return POSITIVE_LABELS.has(label);
}

function intentFromLabel(label) {
  if (label === "MEETING_REQUEST") return "Meeting Request";
  if (label === "QUESTION") return "Question";
  return "Interested";
}

function sentimentFromLabel(label) {
  return label === "QUESTION" ? "Engaged" : "Positive";
}

function stageFromLabel(label) {
  if (label === "MEETING_REQUEST") return "Meeting";
  if (label === "QUESTION") return "Discovery";
  return "High Interest";
}

function normalizeLabel(value) {
  return String(value || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
}

function companyFromThread(thread, latest, email) {
  return cleanString(
    thread.company ||
    thread.company_name ||
    latest.company ||
    latest.company_name ||
    domainCompany(email)
  ) || "Unknown company";
}

function domainCompany(email) {
  const domain = cleanString(email)?.split("@")[1]?.split(".")[0];
  if (!domain) return null;

  return domain
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
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

function addressName(value) {
  if (!Array.isArray(value) || !value[0]) return null;
  return cleanString(value[0].name || value[0].address);
}

function cleanString(value) {
  if (value === undefined || value === null) return null;

  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

module.exports = new LeadService();
