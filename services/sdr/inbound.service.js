const db = require("../../config/db.config");
const classifier = require("./classifier.service");
const threadState = require("./threadState.service");
const settingsService = require("./settings.service");
const agent = require("./agent.service");
const webhook = require("./webhook.service");
const scheduling = require("./scheduling.service");
const { ungroundedTopic } = require("./grounding");
const replierService = require("../replier.service");

const RANK = classifier.INTEREST_RANK;
const POSITIVE_RANK = RANK.high;
const NO_REPLY_OUTCOMES = new Set(["do_not_contact", "out_of_office", "auto_reply"]);
const MAX_CONVERSATION = 20;

async function openAttentionTask({ workspaceId, mailboxId, threadId, name, reason, title = null }) {
  const recordId = `${mailboxId}:${threadId}`;
  await db.query(
    `INSERT INTO crm_tasks (workspace_id, title, due_at, record_type, record_id, source)
     VALUES ($1, $2, NOW() + INTERVAL '1 day', 'thread', $3, 'ai_sdr')
     ON CONFLICT (workspace_id, record_type, record_id, source) WHERE status = 'open' AND record_id IS NOT NULL DO NOTHING`,
    [workspaceId, (title || `Review escalated reply from ${name || "prospect"}${reason ? ` (${reason})` : ""}`).slice(0, 400), recordId]
  );
}

function prospectNameOf(lead, fromAddress) {
  return lead?.full_name || [lead?.first_name, lead?.last_name].filter(Boolean).join(" ") || fromAddress;
}

/** Fires the positive-reply webhook once per thread, the first time interest reaches "high". Never throws. */
async function maybeNotifyPositive({ workspaceId, previousInterest, interest, payload }) {
  if (RANK[interest] < POSITIVE_RANK || RANK[previousInterest || "none"] >= POSITIVE_RANK) return;
  try {
    const settings = await settingsService.loadForPrompt(workspaceId);
    if (!settings.settings.webhookUrl || !settings.webhookSecret) return;
    await webhook.deliver({ url: settings.settings.webhookUrl, secret: settings.webhookSecret, event: "positive_reply", data: { ...payload, interest } });
  } catch (error) {
    console.warn(`Positive-reply webhook failed for workspace ${workspaceId}:`, error.message);
  }
}

/** Puts `block` just above the sign-off so a block of times never lands after the signature. */
function insertAboveSignOff(reply, block, signatureName) {
  const index = signatureName ? reply.lastIndexOf(signatureName) : -1;
  if (index <= 0) return `${reply.trimEnd()}\n\n${block}`;
  return `${reply.slice(0, index).trimEnd()}\n\n${block}\n\n${reply.slice(index)}`;
}

function confirmationText({ lead, label, meetLink, signature }) {
  const first = (lead?.first_name || lead?.full_name || "").split(" ")[0];
  return [
    `Hi${first ? ` ${first}` : ""},`,
    "",
    `Perfect, you're booked for ${label}. A calendar invite is on its way${meetLink ? `, and you can join here: ${meetLink}` : "."}`,
    "",
    "Looking forward to it.",
    "",
    signature,
  ].join("\n");
}

class SdrInboundService {
  /**
   * Step 1, always runs for a recorded reply: label the thread (rules only, no AI needed), open a task if a person
   * must look, and fire the positive-reply webhook. Returns the classification and the thread state before it.
   */
  async classify({ workspaceId, mailboxId, threadId, inboundMessageId, subject, body, lead, fromAddress }) {
    const result = classifier.classify({ subject, body });
    const existing = await threadState.getState(workspaceId, mailboxId, threadId);
    const manual = existing?.classified_by === "manual";
    const patch = { classifiedMessageId: inboundMessageId };

    if (!manual || result.outcome === "do_not_contact") {
      const sticky = existing && ["meeting_booked", "do_not_contact"].includes(existing.outcome) && result.outcome === "none";
      if (!sticky) patch.outcome = result.outcome;
      const quiet = ["out_of_office", "do_not_contact", "auto_reply"].includes(result.outcome);
      const previousRank = RANK[existing?.interest || "none"];
      if (quiet) patch.interest = "none";
      else if (result.outcome === "declined" || RANK[result.interest] >= previousRank) patch.interest = result.interest;
    }
    if (result.needsAttention) {
      patch.needsAttention = true;
      patch.attentionReason = result.attentionReason;
    }
    // A reply from the prospect cancels any follow-up that was waiting for it.
    patch.followUpAt = null;
    await threadState.patch(workspaceId, mailboxId, threadId, patch, { by: "rules" });

    if (result.needsAttention) {
      await openAttentionTask({ workspaceId, mailboxId, threadId, name: prospectNameOf(lead, fromAddress), reason: result.attentionReason });
    }
    await maybeNotifyPositive({
      workspaceId,
      previousInterest: existing?.interest,
      interest: patch.interest || existing?.interest || "none",
      payload: { threadId, mailboxId, prospect: { name: prospectNameOf(lead, fromAddress), email: fromAddress }, subject },
    });
    return { classification: result, previous: existing };
  }

  /** Sets (or clears) the thread's next follow-up. `by` records whether the SDR or a person scheduled it. */
  async scheduleFollowUp(workspaceId, mailboxId, threadId, when, by = "auto") {
    await threadState.patch(workspaceId, mailboxId, threadId, { followUpAt: when ? new Date(when).toISOString() : null, followupBy: when ? by : null }, { by: "rules" });
  }

  /** Called after an AI reply is sent (by the SDR or by a person approving a draft): queues the next automatic follow-up. */
  async afterAiSend({ workspaceId, mailboxId, threadId, campaignId = null }) {
    const all = await settingsService.loadForPrompt(workspaceId, campaignId);
    if (!all.settings.followupEnabled || all.settings.followupMax < 1) return;
    const state = await threadState.getState(workspaceId, mailboxId, threadId);
    if (state && ["do_not_contact", "declined", "meeting_booked"].includes(state.outcome)) return;
    if ((state?.followup_count || 0) >= all.settings.followupMax) return;
    await this.scheduleFollowUp(workspaceId, mailboxId, threadId, Date.now() + all.settings.followupDelayDays * 86400000, "auto");
  }

  /**
   * Asks the model for the next email. Shared by replies and follow-ups. `latest` is null for a follow-up.
   * Returns the model's answer, or null when no usable answer exists (a person takes over).
   */
  async generate({ workspaceId, all, mailbox, lead, campaign, conversation, latest, mode = "reply", followup = null, offeredSlots = [], situation = "", replyPlaybook = "" }) {
    try {
      return await agent.generate({
        workspaceId,
        context: {
          brain: all.brain,
          knowledgeBase: all.settings.knowledgeBase,
          rules: all.rules.map((rule) => rule.rule),
          meetingTypes: all.meetingTypes,
          resources: all.resources,
          bookingLink: all.effective.bookingLink,
          campaignNotes: all.effective.notes,
          mailbox,
          campaign,
          lead,
          conversation,
          latest,
          mode,
          followup,
          offeredSlots,
          situation,
          replyPlaybook,
        },
      });
    } catch (error) {
      // A quota or provider problem must never lose the thread: it falls through to "a person should reply".
      console.warn(`AI SDR generation failed for workspace ${workspaceId}:`, error.message);
      return null;
    }
  }

  /** Sends `body` from the thread's mailbox as the AI, or saves it as a draft. Returns the outcome. */
  async deliver({ workspaceId, inbound, subject, body, generated, approval, booking = null, replyToMessageId = null, campaignId = null }) {
    const draftIt = async (why) => {
      await db.query(
        `INSERT INTO sdr_drafts (workspace_id, mailbox_id, thread_id, reply_to_message_id, subject, body, intent, interest, generated_by, booking)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (workspace_id, mailbox_id, thread_id, reply_to_message_id) DO NOTHING`,
        [workspaceId, inbound.mailbox_id, inbound.thread_id, replyToMessageId || inbound.id, subject, body, generated?.intent || null, generated?.interest || null, generated?.generatedBy || null, booking ? JSON.stringify(booking) : null]
      );
      return { status: "Drafted", reason: why, generated };
    };
    if (approval) return draftIt(booking ? "booking_needs_approval" : "approval_required");

    try {
      const sent = await require("../inbox.service").sendReply(inbound.mailbox_id, inbound.thread_id, { body }, workspaceId);
      await db.query(`UPDATE messages SET author = 'ai' WHERE id = $1 AND workspace_id = $2`, [sent.id, workspaceId]);
      return { status: "Sent", generated, messageId: sent.id };
    } catch (error) {
      await threadState.patch(workspaceId, inbound.mailbox_id, inbound.thread_id, { needsAttention: true, attentionReason: `The AI reply could not be sent: ${error.message}` }, { by: "ai" });
      await openAttentionTask({ workspaceId, mailboxId: inbound.mailbox_id, threadId: inbound.thread_id, name: null, reason: "reply could not be sent", title: "Review a reply that could not be sent" });
      return draftIt("send_failed");
    }
  }

  /**
   * Step 2: write (and maybe send) the reply. Skipped when the SDR is paused for the workspace or campaign, switched off
   * for this thread, the reply needs no answer, or the campaign still belongs to a legacy AI agent.
   */
  async reply({ workspaceId, mailbox, lead, campaign, inbound, classification }) {
    const all = await settingsService.loadForPrompt(workspaceId, campaign?.id || null);
    if (!all.effective.enabled) return { status: "Skipped", reason: "sdr_paused" };
    if (campaign?.ai_agent_id || campaign?.is_warmup) return { status: "Skipped", reason: "legacy_agent" };

    const state = await threadState.getState(workspaceId, inbound.mailbox_id, inbound.thread_id);
    if (state?.ai_disabled) return { status: "Skipped", reason: "thread_disabled" };
    if (NO_REPLY_OUTCOMES.has(state?.outcome || classification.outcome)) return { status: "Skipped", reason: "no_reply_needed" };

    // Ids, not timestamps: node truncates Postgres microseconds to milliseconds, which makes a row look newer than itself.
    const { rows: newer } = await db.query(
      `SELECT 1 FROM messages WHERE workspace_id = $1 AND mailbox_id = $2 AND thread_id = $3 AND id > $4 LIMIT 1`,
      [workspaceId, inbound.mailbox_id, inbound.thread_id, inbound.id]
    );
    if (newer.length > 0) return { status: "Skipped", reason: "stale" };

    const { rows: conversationDesc } = await db.query(
      `SELECT direction, body_text, created_at FROM messages WHERE workspace_id = $1 AND mailbox_id = $2 AND thread_id = $3 ORDER BY created_at DESC LIMIT $4`,
      [workspaceId, inbound.mailbox_id, inbound.thread_id, MAX_CONVERSATION]
    );
    const conversation = conversationDesc.reverse();
    const prospectText = agent.stripQuotedText(inbound.body_text);
    const name = prospectNameOf(lead, inbound.from_address);
    const signature = agent.senderSignature({ brain: all.brain, mailbox });
    const approval = all.effective.requireApproval;
    const threadRef = { workspaceId, mailboxId: inbound.mailbox_id, threadId: inbound.thread_id };

    // ----- calendar: a pick from earlier offered times, or a fresh offer -----
    let handler = null;
    let meetingType = null;
    try {
      handler = await scheduling.resolveHandler(workspaceId, all.settings.callHandlerUserId);
      meetingType = await scheduling.pickMeetingType(workspaceId, all.effective.meetingTypeId);
    } catch (error) {
      console.warn("AI SDR could not read the calendar:", error.message);
    }
    let offeredSlots = [];
    let situation = "";
    let currentOffer = null;

    if (handler) {
      try {
        const offer = await scheduling.activeOffer(workspaceId, inbound.mailbox_id, inbound.thread_id);
        if (offer) {
          const decision = scheduling.detectSelection(prospectText, offer);
          if (decision.decided && decision.selected) {
            const slot = offer.slots[decision.selected - 1];
            const bookingRef = { offerId: offer.id, slot: { startTime: slot.startTime, endTime: slot.endTime, label: slot.label }, handlerUserId: handler.userId, meetingTypeId: meetingType?.id || null };
            const text = confirmationText({ lead, label: slot.label, meetLink: null, signature: signature.text });
            const subject = String(inbound.subject || "").toLowerCase().startsWith("re:") ? inbound.subject : `Re: ${inbound.subject || ""}`.trim();
            if (approval) {
              await threadState.patch(workspaceId, inbound.mailbox_id, inbound.thread_id, { interest: "very_high" }, { by: "ai" });
              return this.deliver({ workspaceId, inbound, subject, body: text, generated: { intent: "meeting_request", interest: "very_high", generatedBy: "scheduler" }, approval: true, booking: bookingRef });
            }
            const booked = await scheduling.book({ ...threadRef, offer, slot, handler, meetingType, lead: { email: lead?.email || inbound.from_address, name: lead?.full_name || null } });
            if (booked.success) {
              await threadState.patch(workspaceId, inbound.mailbox_id, inbound.thread_id, { outcome: "meeting_booked", interest: "very_high", needsAttention: false }, { by: "ai" });
              const result = await this.deliver({ workspaceId, inbound, subject, body: confirmationText({ lead, label: slot.label, meetLink: booked.meetLink, signature: signature.text }), generated: { intent: "meeting_request", interest: "very_high", generatedBy: "scheduler" }, approval: false });
              return { ...result, status: result.status === "Sent" ? "Booked" : result.status, booking: booked };
            }
            if (booked.reason === "taken") {
              situation = "The time the prospect picked has just been taken. Apologise in one short phrase and offer these new times.";
              currentOffer = await scheduling.offerSlots({ ...threadRef, handler, meetingType });
            } else {
              await threadState.patch(workspaceId, inbound.mailbox_id, inbound.thread_id, { needsAttention: true, attentionReason: "The prospect picked a time but the calendar booking failed. Book it manually." }, { by: "ai" });
              await openAttentionTask({ ...threadRef, name, reason: "booking failed" });
            }
          } else if (decision.decided) {
            situation = "The prospect said none of the offered times suit them. Acknowledge briefly and offer these new times.";
            currentOffer = await scheduling.offerSlots({ ...threadRef, handler, meetingType });
          } else {
            situation = "The prospect's answer did not clearly choose one of the offered times. Politely ask which numbered time they prefer and repeat the times.";
            currentOffer = offer;
          }
        } else if (classification.wantsMeeting || ["interested", "meeting_request"].includes(classification.intent)) {
          currentOffer = await scheduling.offerSlots({ ...threadRef, handler, meetingType });
        }
        offeredSlots = currentOffer ? currentOffer.slots.map((slot) => slot.label) : [];
      } catch (error) {
        console.warn("AI SDR scheduling step failed:", error.message);
      }
    }

    // Per reply-type instructions saved in the Replier. A failure here must never stop the SDR, so it falls back to no rules.
    const replyRules = await replierService.rulesFor(workspaceId, null).catch(() => null);
    const generated = await this.generate({ workspaceId, all, mailbox, lead, campaign, conversation, latest: inbound, offeredSlots, situation, replyPlaybook: replyRules?.playbook() || "" });
    const needsPerson = ["interested", "meeting_request", "question"].includes(classification.intent) || ["high", "very_high"].includes(classification.interest);

    if (!generated) {
      if (needsPerson) {
        await threadState.patch(workspaceId, inbound.mailbox_id, inbound.thread_id, { needsAttention: true, attentionReason: "The AI SDR is not available (no AI key or quota); reply personally." }, { by: "rules" });
        await openAttentionTask({ ...threadRef, name, reason: "AI SDR unavailable" });
      }
      return { status: "Skipped", reason: "ai_unavailable" };
    }

    // Backstop that does not trust the model: a risky topic nobody wrote an answer for is never answered automatically.
    const knowledgeText = [all.settings.knowledgeBase, all.effective.notes, ...all.rules.map((rule) => rule.rule), ...Object.values(all.brain)].join("\n");
    const ungrounded = ungroundedTopic({ prospectText, knowledgeText });
    if (ungrounded && !generated.escalate) {
      generated.escalate = true;
      generated.escalateReason = ungrounded;
    }

    // Replier mode for this type of reply: "escalate" and "no_reply" stop the reply, "draft" forces review, "auto" lifts the workspace approval setting.
    const typeRule = replyRules?.get(generated.intent) || null;
    let approvalForType = approval;
    if (typeRule?.mode === "escalate" && !generated.escalate) {
      generated.escalate = true;
      generated.escalateReason = `Reply type "${generated.intent}" is set to escalate to a person.`;
      generated.shouldReply = false;
    } else if (typeRule?.mode === "no_reply") {
      generated.shouldReply = false;
    } else if (typeRule?.mode === "draft") {
      approvalForType = true;
    } else if (typeRule?.mode === "auto") {
      approvalForType = false;
    }

    const existing = await threadState.getState(workspaceId, inbound.mailbox_id, inbound.thread_id);
    const patch = {};
    if (existing?.classified_by !== "manual") {
      patch.interest = generated.interest;
      if (generated.intent === "not_interested" && !existing?.outcome?.match(/meeting_booked|do_not_contact/)) patch.outcome = "declined";
      if (generated.intent === "unsubscribe") patch.outcome = "do_not_contact";
    }
    if (generated.escalate) {
      patch.needsAttention = true;
      patch.attentionReason = generated.escalateReason || "The AI SDR was not confident enough to reply.";
      if (!existing?.outcome || existing.outcome === "none") patch.outcome = "escalated";
    }
    if (Object.keys(patch).length > 0) await threadState.patch(workspaceId, inbound.mailbox_id, inbound.thread_id, patch, { by: "ai" });
    if (generated.escalate) await openAttentionTask({ ...threadRef, name, reason: generated.escalateReason });
    await maybeNotifyPositive({
      workspaceId,
      previousInterest: existing?.interest,
      interest: generated.interest,
      payload: { threadId: inbound.thread_id, mailboxId: inbound.mailbox_id, prospect: { name, email: inbound.from_address }, subject: inbound.subject },
    });

    if (!generated.shouldReply || !generated.reply) return { status: "NoReply", reason: generated.escalate ? "escalated" : "model_declined", generated };

    // The offered times must appear in the email exactly as recorded, or a later "the second one" could not be matched.
    let body = generated.reply;
    if (offeredSlots.length > 0 && !offeredSlots.every((label) => body.includes(label))) {
      body = insertAboveSignOff(body, `Times that work:\n${offeredSlots.map((label, index) => `${index + 1}) ${label}`).join("\n")}`, signature.name);
    }

    const subject = String(inbound.subject || "").toLowerCase().startsWith("re:") ? inbound.subject : `Re: ${inbound.subject || ""}`.trim();
    const result = await this.deliver({ workspaceId, inbound, subject, body, generated, approval: generated.escalate || approvalForType, campaignId: campaign?.id || null });
    if (result.status === "Sent") await this.afterAiSend({ ...threadRef, campaignId: campaign?.id || null });
    return result;
  }
}

module.exports = new SdrInboundService();
module.exports.openAttentionTask = openAttentionTask;
module.exports.prospectNameOf = prospectNameOf;
