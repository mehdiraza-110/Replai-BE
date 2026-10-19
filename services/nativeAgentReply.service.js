const db = require("../config/db.config");
const suppressionService = require("./suppression.service");
const knowledgeService = require("./knowledge.service");
const meetingBookingService = require("./meetingBooking.service");
const eventLogService = require("./eventLog.service");
const messageService = require("./message.service");

const MAX_CONVERSATION_MESSAGES = 20;

/**
 * AI replies for the native (Maildoso) inbox. The agent prompt, model call and meeting-booking
 * logic are the same ones PlusVibe conversations use (message.service.js agentHelpers); this
 * file only adapts the native `messages` thread into that shape and decides draft-vs-send.
 *
 * A reply goes out automatically only when EVERY gate allows it: the campaign doesn't require
 * human review, the agent has auto-reply on and doesn't require review, and the model's
 * confidence clears the agent's threshold. Anything else waits as a Pending draft.
 */
class NativeAgentReplyService {
  /**
   * `override` ({ agentId, tone, instructions }) is for workflows. Omitted, this is the built-in path, unchanged.
   * With `override.agentId` set: that agent answers (tone/instructions applied) instead of the campaign's agent; the
   * campaign and lead are optional (a workflow event can have neither, so `workspaceId` identifies the tenant, and the
   * mailbox must belong to it); the draft is only saved, never auto-sent (the workflow's send step decides that).
   */
  async handleInbound({ mailboxId, campaignId, leadId, inboundMessageId, override = null, workspaceId: explicitWorkspaceId = null }) {
    const overrideAgentId = override?.agentId || null;
    let campaign = null;
    if (campaignId) {
      const { rows: campaignRows } = await db.query(`SELECT * FROM campaigns WHERE id = $1 AND is_deleted = FALSE`, [campaignId]);
      campaign = campaignRows[0] || null;
    }
    if (!overrideAgentId) {
      if (!campaign || campaign.is_warmup || !campaign.ai_agent_id) return { status: "Skipped", reason: "no_agent" };
    } else if (campaign?.is_warmup) {
      return { status: "Skipped", reason: "no_agent" };
    }

    // The tenant is whatever workspace owns the campaign; every other row below must belong to it too.
    // (Workflow case with no campaign: the caller's workspace, which the mailbox is then checked against.)
    const workspaceId = campaign ? campaign.workspace_id : explicitWorkspaceId;
    if (!workspaceId) return { status: "Skipped", reason: "no_agent" };
    if (campaign && explicitWorkspaceId && Number(explicitWorkspaceId) !== Number(workspaceId)) return { status: "Skipped", reason: "missing_context" };

    const { rows: agentRows } = await db.query(`SELECT * FROM ai_agents WHERE id = $1 AND workspace_id = $2 AND is_deleted = FALSE`, [overrideAgentId || campaign.ai_agent_id, workspaceId]);
    const agentRow = agentRows[0];
    if (!agentRow || agentRow.status !== "Active") return { status: "Skipped", reason: "agent_inactive" };

    const [{ rows: inboundRows }, { rows: leadRows }, { rows: mailboxRows }] = await Promise.all([
      db.query(`SELECT * FROM messages WHERE id = $1 AND workspace_id = $2`, [inboundMessageId, workspaceId]),
      db.query(`SELECT * FROM campaign_leads WHERE id = $1 AND workspace_id = $2`, [leadId, workspaceId]),
      db.query(`SELECT * FROM mailboxes WHERE id = $1 AND workspace_id = $2`, [mailboxId, workspaceId]),
    ]);
    const inbound = inboundRows[0];
    const lead = leadRows[0];
    const mailbox = mailboxRows[0];
    if (!inbound || !mailbox || (!lead && !overrideAgentId)) return { status: "Skipped", reason: "missing_context" };
    const leadEmail = lead ? lead.email : inbound.from_address;

    // An opt-out reply (or any suppressed address) must never get an AI answer.
    if (leadEmail && (await suppressionService.isSuppressed(leadEmail, workspaceId))) return { status: "Skipped", reason: "suppressed" };

    const helpers = messageService.agentHelpers;
    const agent = toAgentContext(agentRow, campaign, override || {});
    agent.workspace_id = workspaceId;
    const { rows: thread } = await db.query(
      `SELECT direction, body_text, created_at FROM messages WHERE mailbox_id = $1 AND thread_id = $2 AND workspace_id = $4 ORDER BY created_at DESC LIMIT $3`,
      [mailboxId, inbound.thread_id, MAX_CONVERSATION_MESSAGES, workspaceId]
    );
    const context = {
      campaign: campaign?.name || null,
      leadEmail,
      knowledge: await knowledgeService.getAgentKnowledgeContext(workspaceId, agentRow.id),
      latestReply: helpers.stripQuotedReply(inbound.body_text || ""),
      conversation: thread.reverse().map((message) => ({
        from: message.direction === "inbound" ? "prospect" : "human",
        text: message.body_text || "",
        timestamp: message.created_at,
      })),
    };

    // A workflow with explicit meeting nodes owns the meeting logic (override.skipBuiltInMeeting): the built-in offer/booking is skipped.
    const skipBuiltInMeeting = override?.skipBuiltInMeeting === true;
    const meetingOffer = !skipBuiltInMeeting && helpers.isMeetingObjective(agent) ? await meetingBookingService.getActiveOffer(inbound.thread_id, workspaceId).catch(() => null) : null;
    if (meetingOffer) {
      context.offeredSlots = meetingOffer.slots.map((slot, index) => ({
        number: index + 1,
        time: helpers.describeSlot(slot.startTime, agent.agent_timezone),
      }));
    }

    const generation = await helpers.generateResponse(agent, context);
    let body = generation.body;
    if (skipBuiltInMeeting) {
      body = await helpers.applyWorkflowMeeting(agent, generation.body, override.meeting);
    } else if (generation.wantsMeeting || generation.selectedSlot) {
      body = await helpers.applyMeetingBooking(agent, generation.body, {
        offer: meetingOffer,
        selectedSlot: generation.selectedSlot,
        threadId: inbound.thread_id,
        leadEmail,
        leadName: lead?.full_name || lead?.first_name || null,
      });
    }

    const { rows: draftRows } = await db.query(
      `INSERT INTO ai_response_drafts (
         ai_agent_id, plusvibe_campaign_id, thread_id, reply_to_message_id, lead_email, subject,
         from_email, to_email, body, confidence, generated_by, generation_error, raw_context, source, mailbox_id, workspace_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'native', $14, $15)
       ON CONFLICT (thread_id, reply_to_message_id) DO NOTHING
       RETURNING *`,
      [
        agentRow.id,
        campaign ? String(campaign.id) : null,
        inbound.thread_id,
        String(inbound.id),
        leadEmail,
        helpers.buildReplySubject(inbound.subject),
        mailbox.email,
        leadEmail,
        body,
        generation.confidence,
        generation.generatedBy,
        generation.error,
        JSON.stringify(context),
        mailboxId,
        workspaceId,
      ]
    );
    const draft = draftRows[0];
    if (!draft) return { status: "Skipped", reason: "already_drafted" };

    await eventLogService.record({
      eventType: "ai.draft.generated",
      source: "native",
      appWorkspaceId: workspaceId,
      status: "Success",
      campaignId: campaign ? String(campaign.id) : null,
      campaignName: campaign?.name,
      aiAgentId: agentRow.id,
      aiAgentName: agentRow.name,
      leadEmail,
      threadId: inbound.thread_id,
      draftId: draft.id,
      metadata: { generatedBy: generation.generatedBy, confidence: generation.confidence, intent: generation.intent, ...(overrideAgentId ? { workflow: true } : {}) },
    });

    const result = { draftId: draft.id, draft, confidence: generation.confidence, generatedBy: generation.generatedBy };
    if (overrideAgentId) return { status: "Drafted", ...result };

    const autoSend =
      !campaign.human_review_required &&
      agentRow.auto_reply_enabled &&
      !agentRow.require_human_review &&
      Number(generation.confidence) >= Number(agentRow.confidence_threshold);
    if (!autoSend) return { status: "Drafted", ...result };

    await this.sendDraft(draft, {});
    await db.query(`UPDATE ai_response_drafts SET status = 'Sent', updated_at = NOW() WHERE id = $1 AND workspace_id = $2`, [draft.id, workspaceId]);
    await eventLogService.record({
      eventType: "ai.draft.auto_sent",
      source: "native",
      appWorkspaceId: workspaceId,
      status: "Success",
      campaignId: String(campaign.id),
      aiAgentId: agentRow.id,
      leadEmail,
      threadId: inbound.thread_id,
      draftId: draft.id,
    });
    return { status: "Sent", ...result };
  }

  /** Sends a native draft from the mailbox that received the reply (same path as a manual inbox reply). */
  async sendDraft(draft, { body } = {}) {
    // CROSS-AGENT: inbox.service.sendReply is cold-mailer code; workspaceId is passed as an extra trailing argument.
    const sent = await require("./inbox.service").sendReply(draft.mailbox_id, draft.thread_id, { body: body || draft.body }, draft.workspace_id);
    return { id: String(sent.id) };
  }
}

/** Same field names message.service.js's prompt builder reads off a PlusVibe campaign+agent row. */
function toAgentContext(agent, campaign, override = {}) {
  const extra = String(override.instructions || "").trim();
  const rules = extra ? [agent.response_rules, extra].map((v) => String(v || "").trim()).filter(Boolean).join(". ") : agent.response_rules;
  return {
    name: campaign?.name || agent.name,
    assigned_ai_agent_id: agent.id,
    agent_name: agent.name,
    agent_status: agent.status,
    agent_persona: agent.persona,
    agent_tone: override.tone || agent.tone,
    agent_response_style: agent.response_style,
    agent_company_name: agent.company_name,
    agent_value_proposition: agent.value_proposition,
    agent_objective: agent.objective,
    agent_response_rules: rules,
    agent_sales_rules: agent.sales_rules,
    agent_safety_rules: agent.safety_rules,
    agent_knowledge_sources: agent.knowledge_sources,
    agent_provider: agent.ai_provider,
    agent_model: agent.ai_model,
    agent_fallback_meeting_url: agent.fallback_meeting_url,
    agent_meeting_duration_minutes: agent.meeting_duration_minutes,
    agent_working_hours_start: agent.working_hours_start,
    agent_working_hours_end: agent.working_hours_end,
    agent_timezone: agent.timezone,
  };
}

module.exports = new NativeAgentReplyService();
