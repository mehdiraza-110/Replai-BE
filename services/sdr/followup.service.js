const db = require("../../config/db.config");
const suppressionService = require("../suppression.service");
const settingsService = require("./settings.service");
const threadState = require("./threadState.service");
const inbound = require("./inbound.service");
const agent = require("./agent.service");

const TERMINAL = new Set(["do_not_contact", "declined", "meeting_booked", "out_of_office", "auto_reply"]);
const BATCH = 25;
const MAX_CONVERSATION = 20;
let running = false;

/**
 * Sends the follow-ups that are due. A follow-up is due when its time has passed and the prospect still has not
 * answered our last email. Each is claimed atomically before it is processed, so overlapping ticks (or two servers)
 * never send the same one twice. Anything the SDR cannot or should not send becomes a CRM task for a person.
 */
class FollowUpService {
  async runTick() {
    if (running) return { skipped: true };
    running = true;
    try {
      const { rows: claimed } = await db.query(
        `UPDATE sdr_thread_state s SET follow_up_at = NULL, updated_at = NOW()
         WHERE (s.workspace_id, s.mailbox_id, s.thread_id) IN (
           SELECT workspace_id, mailbox_id, thread_id FROM sdr_thread_state
           WHERE follow_up_at IS NOT NULL AND follow_up_at <= NOW() ORDER BY follow_up_at LIMIT $1 FOR UPDATE SKIP LOCKED
         )
         RETURNING s.*`,
        [BATCH]
      );
      const results = [];
      for (const row of claimed) {
        try {
          results.push(await this.#processOne(row));
        } catch (error) {
          console.error(`Follow-up failed for workspace ${row.workspace_id}:`, error.message);
          results.push({ status: "Error", error: error.message });
        }
      }
      return { processed: results.length, results };
    } finally {
      running = false;
    }
  }

  async #task(row, title) {
    await inbound.openAttentionTask({ workspaceId: row.workspace_id, mailboxId: row.mailbox_id, threadId: row.thread_id, title });
  }

  async #processOne(row) {
    const { workspace_id: workspaceId, mailbox_id: mailboxId, thread_id: threadId } = row;
    const { rows: thread } = await db.query(
      `SELECT * FROM messages WHERE workspace_id = $1 AND mailbox_id = $2 AND thread_id = $3 ORDER BY created_at DESC, id DESC LIMIT $4`,
      [workspaceId, mailboxId, threadId, MAX_CONVERSATION]
    );
    const last = thread[0];
    if (!last) return { status: "Skipped", reason: "no_thread" };
    // They answered after the follow-up was queued: the reply path handles it.
    if (last.direction === "inbound") return { status: "Skipped", reason: "prospect_replied" };
    if (TERMINAL.has(row.outcome) || row.needs_attention) return { status: "Skipped", reason: "thread_closed_or_flagged" };

    // Our own latest message may not carry the lead or campaign, so look across the whole thread.
    const leadId = thread.find((message) => message.campaign_lead_id)?.campaign_lead_id;
    const campaignId = thread.find((message) => message.campaign_id)?.campaign_id;
    const [{ rows: leadRows }, { rows: mailboxRows }, campaignRows] = await Promise.all([
      leadId ? db.query(`SELECT * FROM campaign_leads WHERE id = $1 AND workspace_id = $2`, [leadId, workspaceId]) : { rows: [] },
      db.query(`SELECT * FROM mailboxes WHERE id = $1 AND workspace_id = $2`, [mailboxId, workspaceId]),
      campaignId ? db.query(`SELECT * FROM campaigns WHERE id = $1 AND workspace_id = $2`, [campaignId, workspaceId]) : { rows: [] },
    ]);
    const lead = leadRows[0] || null;
    const mailbox = mailboxRows[0];
    const campaign = campaignRows.rows[0] || null;
    if (!mailbox) return { status: "Skipped", reason: "no_mailbox" };

    const prospectEmail = lead?.email || thread.find((m) => m.direction === "inbound")?.from_address || last.to_address;
    if (prospectEmail && (await suppressionService.isSuppressed(prospectEmail, workspaceId))) return { status: "Skipped", reason: "suppressed" };

    const all = await settingsService.loadForPrompt(workspaceId, campaign?.id || null);
    const name = inbound.prospectNameOf(lead, prospectEmail);
    const manual = row.followup_by === "manual";
    const count = row.followup_count || 0;
    const max = all.settings.followupMax;

    // A person scheduled it but the SDR is off (or the thread opted out of it): leave a reminder instead of writing.
    if (!all.effective.enabled || row.ai_disabled) {
      await this.#task(row, `Follow up with ${name}`);
      return { status: "Task", reason: "sdr_off" };
    }
    if (!manual && (!all.settings.followupEnabled || count >= max)) return { status: "Skipped", reason: "limit_reached" };

    const days = Math.max(1, Math.round((Date.now() - new Date(last.created_at).getTime()) / 86400000));
    const generated = await inbound.generate({
      workspaceId, all, mailbox, lead, campaign,
      conversation: thread.slice().reverse(), latest: null, mode: "followup",
      followup: { number: Math.min(count + 1, Math.max(max, 1)), max: Math.max(max, count + 1), daysSince: days },
    });
    if (!generated || generated.escalate || !generated.shouldReply || !generated.reply) {
      await this.#task(row, `Follow up with ${name}${generated?.escalate ? ` (${generated.escalateReason})` : ""}`);
      return { status: "Task", reason: generated ? "model_declined" : "ai_unavailable" };
    }

    const subject = String(last.subject || "").toLowerCase().startsWith("re:") ? last.subject : `Re: ${last.subject || ""}`.trim();
    const approval = all.effective.requireApproval;
    const result = await inbound.deliver({
      workspaceId, inbound: { mailbox_id: mailboxId, thread_id: threadId, id: last.id }, subject, body: generated.reply, generated, approval, replyToMessageId: last.id,
    });
    if (result.status === "Sent") {
      const nextCount = count + 1;
      await threadState.patch(workspaceId, mailboxId, threadId, { followupCount: nextCount }, { by: "rules" });
      if (!manual && nextCount < max) await inbound.scheduleFollowUp(workspaceId, mailboxId, threadId, Date.now() + all.settings.followupDelayDays * 86400000, "auto");
    }
    return result;
  }
}

module.exports = new FollowUpService();
