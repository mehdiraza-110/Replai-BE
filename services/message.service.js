const db = require("../config/db.config");
const plusVibeService = require("./plusVibe.service");
const eventLogService = require("./eventLog.service");
const leadProfileService = require("./leadProfile.service");
const knowledgeService = require("./knowledge.service");
const ghlService = require("./ghl.service");

class MessageService {
  async listConversations(query = {}) {
    const startedAt = Date.now();
    const { integration, apiKey, workspace } = await plusVibeService.getAuthorizedWorkspace();
    const limit = clampLimit(query.limit, 20);
    const pageTrail = cleanString(query.pageTrail) || "";
    const params = new URLSearchParams({
      workspace_id: workspace.id,
      limit: String(limit),
      page_trail: pageTrail,
    });
    const campaignId = cleanString(query.campaignId || query.campaign_id);
    const label = cleanString(query.label);
    const lead = cleanString(query.lead);
    const latestMessageType = cleanString(query.latestMessageType || query.latest_message_type);

    if (campaignId) params.set("campaign_id", campaignId);
    if (label) params.set("label", label);
    if (lead) params.set("lead", lead);
    if (latestMessageType) params.set("latest_message_type", latestMessageType);

    const payload = await plusVibeService.request(`/api/v1/unibox/threads?${params.toString()}`, apiKey);
    const threads = Array.isArray(payload.data) ? payload.data : [];
    const campaignMap = await getCampaignMap(integration.id);
    const profileMap = await getProfileMap(workspace.id, threads);

    const data = {
      items: threads.map((thread) => mapThread(thread, campaignMap, profileMap)),
      nextPageTrail: cleanString(payload.page_trail),
      hasMore: Boolean(cleanString(payload.page_trail)) && threads.length === limit,
    };

    await eventLogService.record({
      eventType: "messages.conversations.listed",
      source: "messages",
      status: "Success",
      workspaceId: workspace.id,
      workspaceName: integration.workspace_name,
      durationMs: Date.now() - startedAt,
      metadata: { count: data.items.length, limit, hasMore: data.hasMore, campaignId, label, lead },
    });

    return data;
  }

  async getConversation(threadId) {
    const startedAt = Date.now();
    const { integration, apiKey, workspace } = await plusVibeService.getAuthorizedWorkspace();
    const params = new URLSearchParams({
      workspace_id: workspace.id,
      thread_id: threadId,
      page_trail: "",
    });
    const payload = await plusVibeService.request(`/api/v1/unibox/emails?${params.toString()}`, apiKey);
    const remoteMessages = Array.isArray(payload.data) ? payload.data : [];
    const latestInbound = [...remoteMessages].reverse().find((message) => getMessageDirection(message) === "prospect");
    const leadEmail = extractEmailAddress(
      latestInbound?.lead ||
      latestInbound?.from_address_email ||
      remoteMessages.find((message) => getMessageDirection(message) === "prospect")?.from_address_email
    );
    const connectedInbox = getConnectedInboxEmail(remoteMessages, leadEmail);
    const messages = remoteMessages
      .map((message) => mapMessage(message, { connectedInbox, leadEmail }))
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const latestInboundMessage = latestInbound ? mapMessage(latestInbound, { connectedInbox, leadEmail }) : null;
    const campaignId = cleanString(latestInbound?.campaign_id || remoteMessages[0]?.campaign_id);
    const campaign = await getCampaignWithAgent(integration.id, campaignId);
    const draft = latestInbound && campaign?.assigned_ai_agent_id
      ? await getExistingDraft(latestInbound.thread_id, latestInbound.id || latestInbound.message_id)
      : null;
    const leadName = latestInboundMessage?.sender || nameFromEmail(leadEmail);

    await leadProfileService.upsert({
      workspaceId: workspace.id,
      leadEmail,
      leadName,
      threadId,
      campaignId,
      lastSeenAt: latestInboundMessage?.timestamp,
    });

    const data = {
      threadId,
      leadEmail,
      leadName,
      campaign: campaign ? {
        id: campaign.id,
        plusVibeCampaignId: campaign.plusvibe_campaign_id,
        name: campaign.name,
      } : null,
      assignedAgent: campaign?.assigned_ai_agent_id ? {
        id: campaign.assigned_ai_agent_id,
        name: campaign.agent_name,
        status: campaign.agent_status,
      } : null,
      messages,
      aiDraft: draft,
    };

    await eventLogService.record({
      eventType: "messages.conversation.opened",
      source: "messages",
      status: "Success",
      workspaceId: workspace.id,
      workspaceName: integration.workspace_name,
      campaignId,
      campaignName: campaign?.name,
      aiAgentId: campaign?.assigned_ai_agent_id,
      aiAgentName: campaign?.agent_name,
      leadEmail: data.leadEmail,
      threadId,
      messageId: cleanString(latestInbound?.id || latestInbound?.message_id),
      draftId: draft?.id,
      durationMs: Date.now() - startedAt,
      metadata: { messageCount: messages.length, hasDraft: Boolean(draft) },
    });

    return data;
  }

  async generateDraft(threadId, options = {}) {
    const startedAt = Date.now();
    const { integration, apiKey, workspace } = await plusVibeService.getAuthorizedWorkspace();
    const params = new URLSearchParams({
      workspace_id: workspace.id,
      thread_id: threadId,
      page_trail: "",
    });
    const payload = await plusVibeService.request(`/api/v1/unibox/emails?${params.toString()}`, apiKey);
    const remoteMessages = Array.isArray(payload.data) ? payload.data : [];
    const latestInbound = [...remoteMessages].reverse().find((message) => getMessageDirection(message) === "prospect");

    if (!latestInbound) {
      const error = new Error("No inbound lead reply is available for this conversation");
      error.statusCode = 400;
      throw error;
    }

    const campaignId = cleanString(latestInbound.campaign_id || remoteMessages[0]?.campaign_id);
    const campaign = await getCampaignWithAgent(integration.id, campaignId);

    if (!campaign?.assigned_ai_agent_id) {
      const error = new Error("Assign an AI agent to this campaign before generating a draft");
      error.statusCode = 400;
      throw error;
    }

    const draft = await ensureDraft(integration.id, campaign, latestInbound, remoteMessages, {
      force: Boolean(options.regenerate),
    });

    await eventLogService.record({
      eventType: options.regenerate ? "ai.draft.regenerated" : "ai.draft.generated",
      source: "ai",
      status: "Success",
      workspaceId: workspace.id,
      workspaceName: integration.workspace_name,
      campaignId,
      campaignName: campaign.name,
      aiAgentId: campaign.assigned_ai_agent_id,
      aiAgentName: campaign.agent_name,
      leadEmail: extractEmailAddress(latestInbound.lead || latestInbound.from_address_email),
      threadId,
      messageId: cleanString(latestInbound.id || latestInbound.message_id),
      draftId: draft.id,
      durationMs: Date.now() - startedAt,
      metadata: { generatedBy: draft.generatedBy, confidence: draft.confidence },
    });

    return draft;
  }

  async generateDraftFromWebhook(payload = {}) {
    const startedAt = Date.now();
    const threadId = getWebhookThreadId(payload);
    const webhookLabel = normalizeWebhookLabel(payload.label || payload.reply_label || payload.intent || payload.webhook_event || payload.event_type || payload.eventType);

    if (!threadId) {
      await eventLogService.record({
        eventType: "ai.draft.webhook_skipped",
        source: "webhook",
        status: "Skipped",
        durationMs: Date.now() - startedAt,
        metadata: { reason: "missing_thread_id", webhookLabel },
      });

      return { status: "Skipped", reason: "No conversation thread was included in the webhook" };
    }

    if (isNegativeWebhookLabel(webhookLabel)) {
      await eventLogService.record({
        eventType: "ai.draft.webhook_skipped",
        source: "webhook",
        status: "Skipped",
        threadId,
        durationMs: Date.now() - startedAt,
        metadata: { reason: "non_positive_reply", webhookLabel },
      });

      return { status: "Skipped", reason: "The webhook reply was not marked as positive" };
    }

    const { integration, apiKey, workspace } = await plusVibeService.getAuthorizedWorkspace();
    const params = new URLSearchParams({
      workspace_id: workspace.id,
      thread_id: threadId,
      page_trail: "",
    });
    const response = await plusVibeService.request(`/api/v1/unibox/emails?${params.toString()}`, apiKey);
    const remoteMessages = Array.isArray(response.data) ? response.data : [];
    const webhookMessageId = getWebhookMessageId(payload);
    const latestInbound = findWebhookInboundMessage(remoteMessages, webhookMessageId);

    if (!latestInbound) {
      await eventLogService.record({
        eventType: "ai.draft.webhook_skipped",
        source: "webhook",
        status: "Skipped",
        workspaceId: workspace.id,
        workspaceName: integration.workspace_name,
        threadId,
        durationMs: Date.now() - startedAt,
        metadata: { reason: "missing_inbound_message", webhookLabel, webhookMessageId },
      });

      return { status: "Skipped", reason: "No inbound lead reply was available for this conversation" };
    }

    const campaignId = cleanString(latestInbound.campaign_id || payload.campaign_id || payload.campaignId || remoteMessages[0]?.campaign_id);
    const campaign = await getCampaignWithAgent(integration.id, campaignId);
    const mappedInbound = mapMessage(latestInbound);
    const leadEmail = extractEmailAddress(latestInbound.lead || latestInbound.from_address_email || mappedInbound.fromEmail);

    await leadProfileService.upsert({
      workspaceId: workspace.id,
      leadEmail,
      leadName: mappedInbound.sender || nameFromEmail(leadEmail),
      threadId,
      campaignId,
      lastSeenAt: mappedInbound.timestamp,
    });

    if (!campaign?.assigned_ai_agent_id) {
      await eventLogService.record({
        eventType: "ai.draft.webhook_skipped",
        source: "webhook",
        status: "Skipped",
        workspaceId: workspace.id,
        workspaceName: integration.workspace_name,
        campaignId,
        campaignName: campaign?.name,
        leadEmail,
        threadId,
        messageId: cleanString(latestInbound.id || latestInbound.message_id),
        durationMs: Date.now() - startedAt,
        metadata: { reason: "campaign_has_no_agent", webhookLabel },
      });

      return { status: "Skipped", reason: "No AI agent is assigned to this campaign" };
    }

    const draft = await ensureDraft(integration.id, campaign, latestInbound, remoteMessages, { force: false });

    await eventLogService.record({
      eventType: "ai.draft.webhook_generated",
      source: "webhook",
      status: "Success",
      workspaceId: workspace.id,
      workspaceName: integration.workspace_name,
      campaignId,
      campaignName: campaign.name,
      aiAgentId: campaign.assigned_ai_agent_id,
      aiAgentName: campaign.agent_name,
      leadEmail,
      threadId,
      messageId: cleanString(latestInbound.id || latestInbound.message_id),
      draftId: draft.id,
      durationMs: Date.now() - startedAt,
      metadata: { generatedBy: draft.generatedBy, confidence: draft.confidence, webhookLabel },
    });

    return { status: "Generated", draft };
  }

  async rejectDraft(draftId) {
    // Atomic, race-safe: the WHERE status = 'Pending' guard means concurrent
    // approve/reject calls on the same draft serialize on Postgres's row lock —
    // whichever statement commits first wins, and the loser matches 0 rows here
    // instead of silently overwriting an already-handled draft.
    const result = await db.query(
      `UPDATE ai_response_drafts
       SET status = 'Rejected',
           updated_at = NOW()
       WHERE id = $1 AND is_deleted = FALSE AND status = 'Pending'
       RETURNING *`,
      [draftId]
    );

    if (result.rows.length === 0) {
      throw await buildAlreadyHandledError(draftId);
    }

    const draft = mapDraft(result.rows[0]);
    await eventLogService.record({
      eventType: "ai.draft.rejected",
      source: "ai",
      status: "Success",
      threadId: draft.threadId,
      draftId: draft.id,
      aiAgentId: draft.aiAgentId,
      leadEmail: draft.leadEmail,
      campaignId: draft.campaignId,
      metadata: { status: draft.status },
    });

    return draft;
  }

  async sendManualReply(threadId, payload) {
    const startedAt = Date.now();
    const conversation = await this.getConversation(threadId);
    const lastMessage = [...conversation.messages].reverse().find((message) => message.from === "prospect" && message.replyToId);
    const replyToId = cleanString(payload.replyToId) || lastMessage?.replyToId;
    const fallbackFrom = lastMessage?.toEmail || conversation.aiDraft?.from || [...conversation.messages].reverse().find((message) => message.from === "human" && message.fromEmail)?.fromEmail;

    if (!replyToId) {
      const error = new Error("No PlusVibe message is available to reply to");
      error.statusCode = 400;
      throw error;
    }

    const sent = await sendReply({
      replyToId,
      subject: cleanString(payload.subject) || buildReplySubject(lastMessage?.subject),
      from: cleanString(payload.from) || fallbackFrom,
      to: cleanString(payload.to) || conversation.leadEmail || lastMessage?.fromEmail,
      body: cleanString(payload.body),
    });

    await eventLogService.record({
      eventType: "plusvibe.reply.manual_sent",
      source: "plusvibe",
      status: "Success",
      campaignId: conversation.campaign?.plusVibeCampaignId,
      campaignName: conversation.campaign?.name,
      aiAgentId: conversation.assignedAgent?.id,
      aiAgentName: conversation.assignedAgent?.name,
      leadEmail: conversation.leadEmail,
      threadId,
      messageId: sent.id || null,
      durationMs: Date.now() - startedAt,
      metadata: { replyToId },
    });

    return { status: "Sent", remoteMessageId: sent.id || null };
  }

  async approveDraft(draftId, override = {}) {
    const startedAt = Date.now();

    // Race-safe against a concurrent approve/reject on the same draft: SELECT ...
    // FOR UPDATE takes a row lock inside a transaction, so a second reviewer's
    // request blocks here until this one commits or rolls back, then re-reads the
    // (now non-Pending) row and correctly fails with "already handled" instead of
    // sending a duplicate reply or silently overwriting the outcome.
    const client = await db.getClient();
    let draft;
    let sent;
    let mapped;

    try {
      await client.query("BEGIN");

      const result = await client.query(
        `SELECT *
         FROM ai_response_drafts
         WHERE id = $1 AND is_deleted = FALSE
         FOR UPDATE`,
        [draftId]
      );

      if (result.rows.length === 0) {
        const error = new Error("AI draft not found");
        error.statusCode = 404;
        throw error;
      }

      draft = result.rows[0];

      if (draft.status !== "Pending") {
        throw await buildAlreadyHandledError(draftId, draft.status);
      }

      sent = await sendReply({
        replyToId: draft.reply_to_message_id,
        subject: cleanString(override.subject) || draft.subject,
        from: cleanString(override.from) || draft.from_email,
        to: cleanString(override.to) || draft.to_email || draft.lead_email,
        body: cleanString(override.body) || draft.body,
      });

      const updated = await client.query(
        `UPDATE ai_response_drafts
         SET status = 'Sent',
             body = $1,
             sent_message_id = $2,
             updated_at = NOW()
         WHERE id = $3
         RETURNING *`,
        [cleanString(override.body) || draft.body, sent.id || null, draftId]
      );

      await client.query("COMMIT");
      mapped = mapDraft(updated.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    await eventLogService.record({
      eventType: "ai.draft.approved_sent",
      source: "plusvibe",
      status: "Success",
      campaignId: mapped.campaignId,
      aiAgentId: mapped.aiAgentId,
      leadEmail: mapped.leadEmail,
      threadId: mapped.threadId,
      messageId: sent.id || null,
      draftId: mapped.id,
      durationMs: Date.now() - startedAt,
      metadata: { replyToId: draft.reply_to_message_id, generatedBy: mapped.generatedBy },
    });

    // Best-effort: push this lead's approved AI reply into GHL Conversations.
    // ghlService swallows its own failures and never throws, so this never
    // blocks or fails the approval flow.
    ghlService.syncLeadConversation({
      leadEmail: mapped.leadEmail,
      subject: mapped.subject,
      body: mapped.body,
      direction: "outbound",
    });

    return mapped;
  }
}

async function getExistingDraft(threadId, replyToMessageId) {
  const existing = await db.query(
    `SELECT *
     FROM ai_response_drafts
     WHERE thread_id = $1
       AND reply_to_message_id = $2
       AND is_deleted = FALSE
     ORDER BY updated_at DESC
     LIMIT 1`,
    [threadId, cleanString(replyToMessageId)]
  );

  return existing.rows[0] ? mapDraft(existing.rows[0]) : null;
}

async function ensureDraft(integrationId, campaign, latestInbound, remoteMessages, options = {}) {
  const replyToMessageId = cleanString(latestInbound.id || latestInbound.message_id);
  const existing = await db.query(
    `SELECT *
     FROM ai_response_drafts
     WHERE thread_id = $1
       AND reply_to_message_id = $2
       AND is_deleted = FALSE
     ORDER BY updated_at DESC
     LIMIT 1`,
    [latestInbound.thread_id, replyToMessageId]
  );

  if (existing.rows[0] && !options.force) return mapDraft(existing.rows[0]);

  if (existing.rows[0]?.status === "Sent") {
    const error = new Error("This draft has already been sent");
    error.statusCode = 409;
    throw error;
  }

  const agent = campaign;
  const promptContext = await buildPromptContext(agent, latestInbound, remoteMessages);
  const generation = await generateResponse(agent, promptContext);
  const fromEmail = extractEmailAddress(latestInbound.eaccount || latestInbound.to_address_email_list);
  const toEmail = extractEmailAddress(latestInbound.lead || latestInbound.from_address_email);

  const result = await db.query(
    `INSERT INTO ai_response_drafts (
      integration_id,
      ai_agent_id,
      plusvibe_campaign_id,
      thread_id,
      reply_to_message_id,
      lead_email,
      subject,
      from_email,
      to_email,
      body,
      confidence,
      generated_by,
      generation_error,
      raw_context
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    ON CONFLICT (thread_id, reply_to_message_id)
    DO UPDATE SET body = EXCLUDED.body,
                  confidence = EXCLUDED.confidence,
                  status = 'Pending',
                  generated_by = EXCLUDED.generated_by,
                  generation_error = EXCLUDED.generation_error,
                  raw_context = EXCLUDED.raw_context,
                  updated_at = NOW()
    RETURNING *`,
    [
      integrationId,
      agent.assigned_ai_agent_id,
      campaign.plusvibe_campaign_id,
      latestInbound.thread_id,
      replyToMessageId,
      toEmail,
      buildReplySubject(latestInbound.subject),
      fromEmail,
      toEmail,
      generation.body,
      generation.confidence,
      generation.generatedBy,
      generation.error,
      promptContext,
    ]
  );

  return mapDraft(result.rows[0]);
}

async function generateResponse(agent, context) {
  if (String(agent.agent_provider || "").toLowerCase() === "openai" && process.env.OPENAI_API_KEY) {
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: agent.agent_model,
          temperature: 0.4,
          messages: [
            { role: "system", content: buildSystemPrompt(agent) },
            { role: "user", content: JSON.stringify(context, null, 2) },
          ],
        }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) throw new Error(payload?.error?.message || "OpenAI generation failed");

      const body = cleanString(payload.choices?.[0]?.message?.content);
      if (body) {
        return { body, confidence: 82, generatedBy: "openai", error: null };
      }
    } catch (error) {
      return {
        body: buildFallbackDraft(agent, context),
        confidence: 68,
        generatedBy: "local-fallback",
        error: error.message,
      };
    }
  }

  return {
    body: buildFallbackDraft(agent, context),
    confidence: 72,
    generatedBy: "local-agent",
    error: null,
  };
}

async function sendReply({ replyToId, subject, from, to, body }) {
  if (!body) {
    const error = new Error("Reply body is required");
    error.statusCode = 400;
    throw error;
  }

  const { apiKey, workspace } = await plusVibeService.getAuthorizedWorkspace();
  const params = new URLSearchParams({ workspace_id: workspace.id });

  return plusVibeService.request(`/api/v1/unibox/emails/reply?${params.toString()}`, apiKey, {
    method: "POST",
    body: {
      reply_to_id: replyToId,
      subject,
      from,
      to,
      body: textToHtml(body),
    },
  });
}

async function getCampaignMap(integrationId) {
  const result = await db.query(
    `SELECT c.*,
            a.name AS agent_name,
            a.status AS agent_status
     FROM plusvibe_campaigns c
     LEFT JOIN ai_agents a ON a.id = c.assigned_ai_agent_id
     WHERE c.integration_id = $1 AND c.is_deleted = FALSE`,
    [integrationId]
  );

  return new Map(result.rows.map((row) => [row.plusvibe_campaign_id, row]));
}

async function getProfileMap(workspaceId, threads) {
  const emails = threads
    .map((thread) => getThreadLeadEmail(thread))
    .filter(Boolean);

  return leadProfileService.getByEmails(workspaceId, emails);
}

async function getCampaignWithAgent(integrationId, campaignId) {
  if (!campaignId) return null;

  const result = await db.query(
    `SELECT c.*,
            a.name AS agent_name,
            a.status AS agent_status,
            a.persona AS agent_persona,
            a.tone AS agent_tone,
            a.response_style AS agent_response_style,
            a.company_name AS agent_company_name,
            a.value_proposition AS agent_value_proposition,
            a.objective AS agent_objective,
            a.response_rules AS agent_response_rules,
            a.sales_rules AS agent_sales_rules,
            a.safety_rules AS agent_safety_rules,
            a.knowledge_sources AS agent_knowledge_sources,
            a.ai_provider AS agent_provider,
            a.ai_model AS agent_model
     FROM plusvibe_campaigns c
     LEFT JOIN ai_agents a ON a.id = c.assigned_ai_agent_id
     WHERE c.integration_id = $1
       AND c.plusvibe_campaign_id = $2
       AND c.is_deleted = FALSE
     LIMIT 1`,
    [integrationId, campaignId]
  );

  return result.rows[0] || null;
}

function mapThread(thread, campaignMap, profileMap = new Map()) {
  const latest = thread.latest_message || {};
  const campaign = campaignMap.get(cleanString(thread.campaign_id));
  const leadEmail = getThreadLeadEmail(thread);
  const profile = profileMap.get(leadEmail);
  const leadName = profile?.leadName || getThreadLeadName(thread) || nameFromEmail(leadEmail);

  return {
    id: thread.thread_id,
    threadId: thread.thread_id,
    lead: leadName,
    leadEmail,
    campaignId: cleanString(thread.campaign_id),
    campaignName: campaign?.name || cleanString(thread.campaign_name) || "PlusVibe campaign",
    assignedAgent: campaign?.assigned_ai_agent_id ? {
      id: campaign.assigned_ai_agent_id,
      name: campaign.agent_name,
      status: campaign.agent_status,
    } : null,
    label: cleanString(thread.label) || "Reply",
    isUnread: Boolean(thread.is_unread),
    hasDraft: Boolean(thread.has_draft),
    latestMessage: plainEmailText(latest.preview || latest.content_preview || latest.body?.text || latest.body?.html || latest.body) || "No preview available",
    latestMessageId: cleanString(latest.id),
    latestAt: cleanString(latest.timestamp),
    fromEmail: extractEmailAddress(latest.from_address_email),
    toEmail: extractEmailAddress(latest.to_address_email_list || thread.eaccount),
    subject: cleanString(latest.subject),
  };
}

function getThreadLeadEmail(thread) {
  const latest = thread.latest_message || {};
  const latestDirection = getMessageDirection(latest);

  return extractEmailAddress(
    thread.lead ||
    (latestDirection === "prospect" ? latest.from_address_email : latest.to_address_email_list) ||
    latest.from_address_email
  );
}

function getThreadLeadName(thread) {
  const latest = thread.latest_message || {};
  return getMessageDirection(latest) === "prospect" ? addressName(latest.from_address_json) : null;
}

function extractEmailAddress(value) {
  if (Array.isArray(value)) return extractEmailAddress(value[0]);

  if (value && typeof value === "object") {
    return extractEmailAddress(value.address || value.email || value.value || value.name);
  }

  const text = cleanString(value);
  if (!text) return null;

  const angleMatch = text.match(/<([^<>@\s]+@[^<>\s]+)>/);
  if (angleMatch) return cleanString(angleMatch[1]);

  const emailMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return cleanString(emailMatch?.[0] || text);
}

function getConnectedInboxEmail(messages, leadEmail) {
  for (const message of messages) {
    const direction = getMessageDirection(message);
    const fromEmail = extractEmailAddress(message.from_address_email);
    const toEmail = extractEmailAddress(message.to_address_email_list || message.eaccount);

    if (direction === "prospect" && toEmail) return toEmail;
    if (direction === "human" && fromEmail && fromEmail !== leadEmail) return fromEmail;
  }

  return null;
}

function mapMessage(message, context = {}) {
  const htmlBody = normalizeEmailHtml(message.body?.html || message.body);
  const rawTextBody = plainEmailText(message.body?.text || message.text_body || message.content_preview || message.preview || htmlBody);
  const textBody = stripQuotedReply(rawTextBody) || rawTextBody;
  const direction = getMessageDirection(message);
  const fromEmail = extractEmailAddress(message.from_address_email) || (direction === "prospect" ? context.leadEmail : context.connectedInbox);
  const toEmail = extractEmailAddress(message.to_address_email_list || message.eaccount) || (direction === "prospect" ? context.connectedInbox : context.leadEmail);

  return {
    id: cleanString(message.id || message.message_id),
    replyToId: cleanString(message.id),
    from: direction,
    sender: addressName(message.from_address_json) || fromEmail || "Sender",
    fromEmail,
    toEmail,
    subject: cleanString(message.subject),
    timestamp: cleanString(message.timestamp_created || message.timestamp || message.source_modified_at) || new Date().toISOString(),
    preview: plainEmailText(message.content_preview || message.preview),
    bodyText: textBody,
    bodyHtml: htmlBody,
    label: cleanString(message.label),
  };
}

function mapDraft(row) {
  return {
    id: row.id,
    threadId: row.thread_id,
    replyToMessageId: row.reply_to_message_id,
    aiAgentId: row.ai_agent_id,
    campaignId: row.plusvibe_campaign_id,
    leadEmail: row.lead_email,
    subject: row.subject,
    from: row.from_email,
    to: row.to_email,
    body: row.body,
    confidence: Number(row.confidence),
    status: row.status,
    generatedBy: row.generated_by,
    generationError: row.generation_error,
    sentMessageId: row.sent_message_id,
    updatedAt: row.updated_at,
  };
}

function getMessageDirection(message) {
  const fromEmail = extractEmailAddress(message.from_address_email);
  const toEmail = extractEmailAddress(message.to_address_email_list);
  const connectedInbox = extractEmailAddress(message.eaccount);
  const leadEmail = extractEmailAddress(message.lead);

  if (connectedInbox && fromEmail === connectedInbox) return "human";
  if (connectedInbox && toEmail === connectedInbox) return "prospect";
  if (leadEmail && fromEmail === leadEmail) return "prospect";
  if (leadEmail && toEmail === leadEmail) return "human";

  const type = String(message.type || message.email_type || "").toLowerCase();
  if (type.includes("received") || type === "in") return "prospect";
  if (type.includes("sent") || type === "out") return "human";
  return "human";
}

function getWebhookThreadId(payload) {
  return cleanString(
    payload.thread_id ||
    payload.threadId ||
    payload.source_thread_id ||
    payload.sourceThreadId ||
    payload.email_thread_id ||
    payload.emailThreadId ||
    payload.data?.thread_id ||
    payload.data?.threadId
  );
}

function getWebhookMessageId(payload) {
  return cleanString(
    payload.message_id ||
    payload.messageId ||
    payload.email_id ||
    payload.emailId ||
    payload.source_message_id ||
    payload.sourceMessageId ||
    payload.id ||
    payload.data?.message_id ||
    payload.data?.messageId ||
    payload.data?.id
  );
}

function findWebhookInboundMessage(messages, webhookMessageId) {
  const inboundMessages = messages.filter((message) => getMessageDirection(message) === "prospect");

  if (webhookMessageId) {
    const exact = inboundMessages.find((message) => cleanString(message.id || message.message_id) === webhookMessageId);
    if (exact) return exact;
  }

  return inboundMessages
    .sort((a, b) => new Date(b.timestamp_created || b.timestamp || b.source_modified_at || 0).getTime() - new Date(a.timestamp_created || a.timestamp || a.source_modified_at || 0).getTime())[0] || null;
}

function normalizeWebhookLabel(value) {
  return cleanString(value)?.toUpperCase().replace(/[\s-]+/g, "_") || null;
}

function isNegativeWebhookLabel(label) {
  if (!label) return false;

  return [
    "NOT_INTERESTED",
    "OUT_OF_OFFICE",
    "AUTOMATIC_REPLY",
    "BOUNCED",
    "BOUNCE",
    "UNSUBSCRIBE",
    "SPAM",
  ].some((negativeLabel) => label.includes(negativeLabel));
}

async function buildPromptContext(agent, latestInbound, remoteMessages) {
  const knowledge = await knowledgeService.getAgentKnowledgeContext(agent.assigned_ai_agent_id);

  return {
    campaign: agent.name,
    leadEmail: latestInbound.lead || latestInbound.from_address_email,
    knowledge,
    latestReply: stripQuotedReply(latestInbound.body?.text || latestInbound.content_preview || stripHtml(latestInbound.body?.html || latestInbound.body)),
    conversation: remoteMessages.map((message) => ({
      from: getMessageDirection(message),
      text: message.body?.text || message.content_preview || stripHtml(message.body?.html || message.body),
      timestamp: message.timestamp_created || message.timestamp || message.source_modified_at,
    })),
  };
}

function buildSystemPrompt(agent) {
  return [
    `You are ${agent.agent_name}, an AI sales reply assistant for ${agent.agent_company_name}.`,
    `Persona: ${agent.agent_persona || "helpful, concise, and accurate"}.`,
    `Tone: ${agent.agent_tone || "consultative"}. Response style: ${agent.agent_response_style || "concise"}.`,
    `Objective: ${agent.agent_objective || "reply helpfully and move the conversation forward"}.`,
    agent.agent_value_proposition ? `Value proposition: ${agent.agent_value_proposition}.` : "",
    agent.agent_response_rules ? `Response rules: ${agent.agent_response_rules}.` : "",
    agent.agent_sales_rules ? `Sales rules: ${agent.agent_sales_rules}.` : "",
    agent.agent_safety_rules ? `Safety rules: ${agent.agent_safety_rules}.` : "",
    "Use the supplied knowledge context when it is relevant. Never invent facts that are not in the agent instructions, conversation, or knowledge base.",
    "Write only the email reply body. Do not include a subject line.",
  ].filter(Boolean).join("\n");
}

function buildFallbackDraft(agent, context) {
  const latestReply = String(context.latestReply || "").toLowerCase();

  if (latestReply.includes("no longer") || latestReply.includes("not be checking")) {
    return "Thanks for letting me know. I appreciate the update and will make sure we do not keep following up with this inbox.";
  }

  if (latestReply.includes("pricing") || latestReply.includes("cost")) {
    return `Happy to share more context. The useful answer depends on your current reply volume and how much review control you want in place. Would it be worth a quick call so I can point you to the right setup for ${agent.agent_company_name}?`;
  }

  if (latestReply.includes("interested") || latestReply.includes("tell me more")) {
    return `${agent.agent_company_name} helps teams respond to interested outbound replies faster while keeping humans in control of approvals and send decisions. Would it be useful to look at how this would fit your current campaign workflow?`;
  }

  return `Thanks for the reply. ${agent.agent_company_name} helps teams handle outbound responses faster while keeping the message controlled and reviewable. Would a quick workflow review be useful?`;
}

function buildReplySubject(subject) {
  const value = cleanString(subject) || "Re: PlusVibe reply";
  return /^re:/i.test(value) ? value : `Re: ${value}`;
}

function textToHtml(value) {
  if (/<[a-z][\s\S]*>/i.test(String(value || ""))) {
    return sanitizeOutgoingHtml(value);
  }

  return String(value)
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function sanitizeOutgoingHtml(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "")
    .replace(/\son\w+="[^"]*"/gi, "")
    .replace(/\son\w+='[^']*'/gi, "")
    .replace(/\s(href|src)=["']javascript:[^"']*["']/gi, "")
    .replace(/<(?!\/?(p|br|strong|b|em|i|u|ul|ol|li|div)\b)[^>]*>/gi, "");
}

function stripHtml(value) {
  return cleanString(String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
}

function plainEmailText(value) {
  return stripHtml(decodeHtmlEntities(value));
}

function stripQuotedReply(value) {
  const text = cleanString(value);
  if (!text) return null;

  const quotedMarkers = [
    /(?:^|\n|\s)On [^\n]{1,260} wrote:\s*/i,
    /_{6,}/,
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

function normalizeEmailHtml(value) {
  const decoded = decodeHtmlEntities(value);
  const text = cleanString(decoded);

  if (!text) return null;
  if (!/<[a-z][\s\S]*>/i.test(text)) return null;

  return text;
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function addressName(value) {
  if (!Array.isArray(value) || !value[0]) return null;
  return cleanString(value[0].name || value[0].address);
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function clampLimit(value, fallback) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(Math.max(Math.trunc(numberValue), 1), 50);
}

function cleanString(value) {
  if (value === undefined || value === null) return null;

  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

// Builds the error thrown when an approve/reject request loses the race against
// another reviewer who already handled the same draft. Pass `knownStatus` when
// the caller already has the row in hand (avoids an extra query).
async function buildAlreadyHandledError(draftId, knownStatus) {
  let status = knownStatus;

  if (!status) {
    const existing = await db.query(
      `SELECT status FROM ai_response_drafts WHERE id = $1 AND is_deleted = FALSE`,
      [draftId]
    );

    if (existing.rows.length === 0) {
      const error = new Error("AI draft not found");
      error.statusCode = 404;
      return error;
    }

    status = existing.rows[0].status;
  }

  const error = new Error(`This draft was already ${status.toLowerCase()} by someone else. Refresh to see the latest queue.`);
  error.statusCode = 409;
  return error;
}

module.exports = new MessageService();
