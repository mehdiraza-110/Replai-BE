const db = require("../config/db.config");
const suppressionService = require("./suppression.service");

// Handles a parsed inbound email: opt-out detection, the inbound_messages audit row, the per-mailbox inbox record and the AI hand-off.
// Replies arrive from our own mail server (Postal webhook) or from Maildoso mailboxes (IMAP poll); both end up here.
class InboundEmailService {
  /** Opt-out detection, the inbound_messages audit row, and the per-mailbox inbox record. */
  async processParsedEmail({ parsed, bucket = null, key = null }) {
    // Replies from our warm-up seed inboxes belong to the warm-up network only: no inbox record, AI agent or suppression.
    try {
      const warm = await require("./warmnetEngine.service").handleInbound(parsed);
      if (warm.handled) return { status: "Processed", warmup: true };
    } catch (error) {
      console.error("Warm-up inbound handling failed:", error.message);
    }

    const fromAddress = parsed.from?.value?.[0]?.address?.toLowerCase() || null;
    const toAddress = parsed.to?.value?.[0]?.address?.toLowerCase() || null;
    const bodyText = String(parsed.text || "").trim();
    const isOptOut = fromAddress ? suppressionService.isOptOutText(bodyText) : false;

    // The tenant is the workspace of the mailbox the message was addressed to. Without exactly one
    // matching mailbox there is no workspace to attribute it to, so nothing is written (the provider
    // still gets a success response and does not retry).
    const mailbox = toAddress ? await this.findMailboxByEmail(toAddress) : null;
    if (!mailbox) {
      console.warn(`Inbound email to "${toAddress || "unknown"}" ignored: the recipient is not an onboarded mailbox, so it cannot be assigned to a workspace.`);
      return { status: "Ignored", reason: "Recipient does not match a mailbox in any workspace", fromAddress, toAddress, isOptOut };
    }

    if (isOptOut) {
      await suppressionService.addSuppression({
        email: fromAddress,
        reason: "unsubscribed",
        source: "reply_keyword",
        workspaceId: mailbox.workspace_id,
      });
    }

    await db.query(
      `INSERT INTO inbound_messages (workspace_id, message_id, from_address, to_address, subject, body_text, s3_bucket, s3_key, is_opt_out)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [mailbox.workspace_id, parsed.messageId || null, fromAddress, toAddress, parsed.subject || null, bodyText, bucket, key, isOptOut]
    );

    if (fromAddress) {
      await this.recordInboxMessage({ mailbox, fromAddress, toAddress, parsed, bodyText });
    }

    return { status: "Processed", fromAddress, toAddress, isOptOut };
  }

  /** Mailbox emails are UNIQUE, so this is the single mailbox (and workspace) owning the address, or null. */
  async findMailboxByEmail(email) {
    const { rows } = await db.query(
      `SELECT id, workspace_id FROM mailboxes WHERE email = $1 AND is_deleted = FALSE LIMIT 2`,
      [email]
    );
    if (rows.length !== 1 || !rows[0].workspace_id) return null;
    return rows[0];
  }

  async recordInboxMessage({ mailbox, fromAddress, toAddress, parsed, bodyText }) {
    const workspaceId = mailbox.workspace_id;

    const { rows: leadRows } = await db.query(
      `SELECT id, campaign_id, status FROM campaign_leads WHERE mailbox_id = $1 AND email = $2 AND workspace_id = $3 ORDER BY sent_at DESC NULLS LAST LIMIT 1`,
      [mailbox.id, fromAddress, workspaceId]
    );
    const lead = leadRows[0] || null;

    const { rows: insertedRows } = await db.query(
      `INSERT INTO messages (workspace_id, mailbox_id, direction, campaign_id, campaign_lead_id, thread_id, message_id, in_reply_to, from_address, to_address, subject, body_text, body_html)
       VALUES ($12, $1, 'inbound', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        mailbox.id,
        lead?.campaign_id || null,
        lead?.id || null,
        `${mailbox.id}:${fromAddress}`,
        parsed.messageId || null,
        parsed.inReplyTo || null,
        fromAddress,
        toAddress,
        parsed.subject || null,
        bodyText,
        parsed.html || null,
        workspaceId,
      ]
    );

    if (lead && lead.status !== "Replied") {
      await db.query(`UPDATE campaign_leads SET status = 'Replied' WHERE id = $1 AND workspace_id = $2`, [lead.id, workspaceId]);
      await db.query(`UPDATE campaigns SET reply_count = reply_count + 1, updated_at = NOW() WHERE id = $1 AND workspace_id = $2`, [lead.campaign_id, workspaceId]);
    }

    // Let the campaign's AI agent (if any) draft — or send — a reply. Fire-and-forget: a model
    // or send failure must never lose the inbound message that was just recorded.
    // A workspace with an active "mail received" workflow lets that workflow handle the reply; with none
    // (or when it fails before doing anything) the built-in campaign handler below runs exactly as before.
    (async () => {
      const inboundMessageId = insertedRows[0].id;
      const threadId = `${mailbox.id}:${fromAddress}`;
      const sdr = require("./sdr/inbound.service");
      const leadRow = lead ? (await db.query(`SELECT * FROM campaign_leads WHERE id = $1 AND workspace_id = $2`, [lead.id, workspaceId])).rows[0] : null;
      const campaignRow = lead?.campaign_id ? (await db.query(`SELECT * FROM campaigns WHERE id = $1 AND workspace_id = $2`, [lead.campaign_id, workspaceId])).rows[0] : null;

      // AI SDR, step 1: label the thread (status, interest, escalation task, positive-reply webhook). Warm-up traffic is not inbox work.
      let classification = null;
      if (!campaignRow?.is_warmup) {
        try {
          ({ classification } = await sdr.classify({
            workspaceId, mailboxId: mailbox.id, threadId, inboundMessageId,
            subject: parsed.subject || "", body: bodyText, lead: leadRow, fromAddress,
          }));
        } catch (error) {
          console.error("AI SDR classification failed:", error.message);
        }
      }

      const wf = await require("./workflowExecutor.service").maybeRun({
        workspaceId,
        triggerType: "trigger.inbox_mail",
        event: {
          mailboxId: mailbox.id,
          campaignId: lead?.campaign_id || null,
          leadId: lead?.id || null,
          inboundMessageId: insertedRows[0].id,
          threadId: `${mailbox.id}:${fromAddress}`,
          fromAddress,
          toAddress,
          subject: parsed.subject || "",
          body: bodyText,
        },
      });
      if (wf.handled || !lead?.campaign_id) return;

      // AI SDR, step 2: write (and, unless approval is required, send) the reply. It steps aside for campaigns that
      // still have a legacy AI agent, which answers in the call below.
      if (classification) {
        try {
          const [{ rows: inboundRows }, { rows: mailboxRows }] = await Promise.all([
            db.query(`SELECT * FROM messages WHERE id = $1 AND workspace_id = $2`, [inboundMessageId, workspaceId]),
            db.query(`SELECT * FROM mailboxes WHERE id = $1 AND workspace_id = $2`, [mailbox.id, workspaceId]),
          ]);
          if (inboundRows[0] && mailboxRows[0]) {
            await sdr.reply({ workspaceId, mailbox: mailboxRows[0], lead: leadRow, campaign: campaignRow, inbound: inboundRows[0], classification });
          }
        } catch (error) {
          console.error("AI SDR reply failed:", error.message);
        }
      }

      await require("./nativeAgentReply.service").handleInbound({
        mailboxId: mailbox.id,
        campaignId: lead.campaign_id,
        leadId: lead.id,
        inboundMessageId: insertedRows[0].id,
      });
    })().catch((error) => console.error("Native AI reply failed:", error.message));
  }
}

module.exports = new InboundEmailService();
