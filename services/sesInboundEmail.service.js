const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { simpleParser } = require("mailparser");
const db = require("../config/db.config");
const suppressionService = require("./suppression.service");
const { resolveSnsEnvelope } = require("../utils/snsEnvelope.util");

// SES inbound receiving is only available in a handful of regions (not necessarily
// the same region used for sending) — configurable independently of AWS_REGION.
const SES_INBOUND_REGION = process.env.SES_INBOUND_REGION || process.env.AWS_REGION || "us-east-1";
const s3Client = new S3Client({ region: SES_INBOUND_REGION });

class SesInboundEmailService {
  /**
   * Entry point for the SNS HTTPS subscription (raw request body, text/plain JSON per SNS).
   * Handles both the one-time SubscriptionConfirmation handshake and ongoing Notifications.
   */
  async handleSnsMessage(rawBody) {
    const { handled, result, message } = await resolveSnsEnvelope(rawBody);
    if (handled) return result;
    return this.handleSesNotification(message);
  }

  /**
   * The decoded SES notification (already JSON.parse'd out of the SNS envelope).
   * SES receipt rules configured with an S3 action deliver the raw MIME message to S3
   * and include the bucket/key here; we fetch and parse it from there.
   */
  async handleSesNotification(sesNotification) {
    const mail = sesNotification?.mail;
    const s3Info = sesNotification?.receipt?.action;
    if (!mail || !s3Info || s3Info.type !== "S3") {
      return { status: "Ignored", reason: "Notification did not include an S3-delivered message" };
    }

    const bucket = s3Info.bucketName;
    const key = `${s3Info.objectKeyPrefix || ""}${s3Info.objectKey}`.replace(/^\/+/, "");
    return this.processStoredEmail({ bucket, key });
  }

  /**
   * Fetches the raw MIME message from S3, parses it, checks for an opt-out reply,
   * and logs it. This is the piece that actually matters for compliance: any reply
   * whose body matches the opt-out pattern suppresses that sender address immediately.
   * Also records the message in the app-native per-mailbox inbox (see `messages` table)
   * when the recipient address matches one of our onboarded mailboxes.
   */
  async processStoredEmail({ bucket, key }) {
    const raw = await fetchRawEmail(bucket, key);
    const parsed = await simpleParser(raw);
    return this.processParsedEmail({ parsed, bucket, key });
  }

  /**
   * Shared by the SES/S3 path above and the IMAP poller (imapInbox.service.js): opt-out
   * detection, the inbound_messages audit row, and the per-mailbox inbox record.
   */
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
      await require("./nativeAgentReply.service").handleInbound({
        mailboxId: mailbox.id,
        campaignId: lead.campaign_id,
        leadId: lead.id,
        inboundMessageId: insertedRows[0].id,
      });
    })().catch((error) => console.error("Native AI reply failed:", error.message));
  }
}

function fetchRawEmail(bucket, key) {
  return s3Client
    .send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    .then((result) => streamToBuffer(result.Body));
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

module.exports = new SesInboundEmailService();
