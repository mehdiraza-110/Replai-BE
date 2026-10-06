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
  async handleInbound({ mailboxId, campaignId, leadId, inboundMessageId }) {
    const { rows: campaignRows } = await db.query(`SELECT * FROM campaigns WHERE id = $1 AND is_deleted = FALSE`, [campaignId]);
    const campaign = campaignRows[0];
    if (!campaign || campaign.is_warmup || !campaign.ai_agent_id) return { status: "Skipped", reason: "no_agent" };

    const { rows: agentRows } = await db.query(`SELECT * FROM ai_agents WHERE id = $1 AND is_deleted = FALSE`, [campaign.ai_agent_id]);
    const agentRow = agentRows[0];
    if (!agentRow || agentRow.status !== "Active") return { status: "Skipped", reason: "agent_inactive" };

    const [{ rows: inboundRows }, { rows: leadRows }, { rows: mailboxRows }] = await Promise.all([
      db.query(`SELECT * FROM messages WHERE id = $1`, [inboundMessageId]),
      db.query(`SELECT * FROM campaign_leads WHERE id = $1`, [leadId]),
      db.query(`SELECT * FROM mailboxes WHERE id = $1`, [mailboxId]),
    ]);
    const inbound = inboundRows[0];
    const lead = leadRows[0];
    const mailbox = mailboxRows[0];
    if (!inbound || !lead || !mailbox) return { status: "Skipped", reason: "missing_context" };

    // An opt-out reply (or any suppressed address) must never get an AI answer.
    if (await suppressionService.isSuppressed(lead.email)) return { status: "Skipped", reason: "suppressed" };

    const helpers = messageService.agentHelpers;
    const agent = toAgentContext(agentRow, campaign);
    const { rows: thread } = await db.query(
      `SELECT direction, body_text, created_at FROM messages WHERE mailbox_id = $1 AND thread_id = $2 ORDER BY created_at DESC LIMIT $3`,
      [mailboxId, inbound.thread_id, MAX_CONVERSATION_MESSAGES]
    );
    const context = {
      campaign: campaign.name,
      leadEmail: lead.email,
      knowledge: await knowledgeService.getAgentKnowledgeContext(agentRow.id),
      latestReply: helpers.stripQuotedReply(inbound.body_text || ""),
      conversation: thread.reverse().map((message) => ({
        from: message.direction === "inbound" ? "prospect" : "human",
        text: message.body_text || "",
        timestamp: message.created_at,
      })),
    };

    const meetingOffer = helpers.isMeetingObjective(agent) ? await meetingBookingService.getActiveOffer(inbound.thread_id).catch(() => null) : null;
    if (meetingOffer) {
      context.offeredSlots = meetingOffer.slots.map((slot, index) => ({
        number: index + 1,
        time: helpers.describeSlot(slot.startTime, agent.agent_timezone),
      }));
    }

    const generation = await helpers.generateResponse(agent, context);
    let body = generation.body;
    if (generation.wantsMeeting || generation.selectedSlot) {
      body = await helpers.applyMeetingBooking(agent, generation.body, {
        offer: meetingOffer,
        selectedSlot: generation.selectedSlot,
        threadId: inbound.thread_id,
        leadEmail: lead.email,
        leadName: lead.full_name || lead.first_name || null,
      });
    }

    const { rows: draftRows } = await db.query(
      `INSERT INTO ai_response_drafts (
         ai_agent_id, plusvibe_campaign_id, thread_id, reply_to_message_id, lead_email, subject,
         from_email, to_email, body, confidence, generated_by, generation_error, raw_context, source, mailbox_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'native', $14)
       ON CONFLICT (thread_id, reply_to_message_id) DO NOTHING
       RETURNING *`,
      [
        agentRow.id,
        String(campaign.id),
        inbound.thread_id,
        String(inbound.id),
        lead.email,
        helpers.buildReplySubject(inbound.subject),
        mailbox.email,
        lead.email,
        body,
        generation.confidence,
        generation.generatedBy,
        generation.error,
        JSON.stringify(context),
        mailboxId,
      ]
    );
    const draft = draftRows[0];
    if (!draft) return { status: "Skipped", reason: "already_drafted" };

    await eventLogService.record({
      eventType: "ai.draft.generated",
      source: "native",
      status: "Success",
      campaignId: String(campaign.id),
      campaignName: campaign.name,
      aiAgentId: agentRow.id,
      aiAgentName: agentRow.name,
      leadEmail: lead.email,
      threadId: inbound.thread_id,
      draftId: draft.id,
      metadata: { generatedBy: generation.generatedBy, confidence: generation.confidence, intent: generation.intent },
    });

    const autoSend =
      !campaign.human_review_required &&
      agentRow.auto_reply_enabled &&
      !agentRow.require_human_review &&
      Number(generation.confidence) >= Number(agentRow.confidence_threshold);
    if (!autoSend) return { status: "Drafted", draftId: draft.id };

    await this.sendDraft(draft, {});
    await db.query(`UPDATE ai_response_drafts SET status = 'Sent', updated_at = NOW() WHERE id = $1`, [draft.id]);
    await eventLogService.record({
      eventType: "ai.draft.auto_sent",
      source: "native",
      status: "Success",
      campaignId: String(campaign.id),
      aiAgentId: agentRow.id,
      leadEmail: lead.email,
      threadId: inbound.thread_id,
      draftId: draft.id,
    });
    return { status: "Sent", draftId: draft.id };
  }

  /** Sends a native draft from the mailbox that received the reply (same path as a manual inbox reply). */
  async sendDraft(draft, { body } = {}) {
    const sent = await require("./inbox.service").sendReply(draft.mailbox_id, draft.thread_id, { body: body || draft.body });
    return { id: String(sent.id) };
  }
}

/** Same field names message.service.js's prompt builder reads off a PlusVibe campaign+agent row. */
function toAgentContext(agent, campaign) {
  return {
    name: campaign.name,
    assigned_ai_agent_id: agent.id,
    agent_name: agent.name,
    agent_status: agent.status,
    agent_persona: agent.persona,
    agent_tone: agent.tone,
    agent_response_style: agent.response_style,
    agent_company_name: agent.company_name,
    agent_value_proposition: agent.value_proposition,
    agent_objective: agent.objective,
    agent_response_rules: agent.response_rules,
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
