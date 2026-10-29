const db = require("../../config/db.config");
const quotaService = require("../quota.service");

const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;
const MAX_NOTE = 2000;
const HOURLY_LIMIT = 20;
const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function formatDate(value) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeStyle: "short", timeZone: "UTC" }).format(new Date(value)) + " UTC";
}

class ForwardService {
  /**
   * Sends one message from a thread to a colleague, from the mailbox that owns the thread, in the usual
   * "Fwd:" form. Nothing is added to the thread (the colleague is not the prospect) but every forward is audited.
   */
  async forward({ workspaceId, userId, mailboxId, threadId, messageId, to, note = "" }) {
    const address = String(to || "").trim();
    if (!EMAIL.test(address) || address.length > 320) throw bad("Enter one valid email address to forward to.");
    const cleanNote = String(note || "").trim();
    if (cleanNote.length > MAX_NOTE) throw bad("Keep the note short.");

    const { rows: recent } = await db.query(`SELECT COUNT(*)::int AS count FROM sdr_forwards WHERE workspace_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`, [workspaceId]);
    if (recent[0].count >= HOURLY_LIMIT) throw bad("You've forwarded a lot of messages in the last hour. Try again later.", 429);

    const { rows: messageRows } = await db.query(`SELECT * FROM messages WHERE id = $1 AND workspace_id = $2 AND mailbox_id = $3 AND thread_id = $4`, [messageId, workspaceId, mailboxId, threadId]);
    const message = messageRows[0];
    if (!message) throw bad("Message not found.", 404);
    const { rows: mailboxRows } = await db.query(
      `SELECT m.*, d.status AS domain_status FROM mailboxes m JOIN domains d ON d.id = m.domain_id AND d.workspace_id = m.workspace_id WHERE m.id = $1 AND m.workspace_id = $2 AND m.is_deleted = FALSE`,
      [mailboxId, workspaceId]
    );
    const mailbox = mailboxRows[0];
    if (!mailbox) throw bad("Mailbox not found.", 404);
    if (mailbox.domain_status !== "Verified") throw bad("This mailbox's domain is not verified.", 409);

    const { buildRawMimeMessage, mailboxDomain } = require("../campaignSend.service");
    const { sendRawEmail } = require("../mailTransport.service");
    const subject = /^fwd?:/i.test(message.subject || "") ? message.subject : `Fwd: ${message.subject || ""}`.trim();
    const header = [
      "---------- Forwarded message ----------",
      `From: ${message.from_address}`,
      `Date: ${formatDate(message.created_at)}`,
      `Subject: ${message.subject || ""}`,
      `To: ${message.to_address}`,
    ].join("\n");
    const body = `${cleanNote ? `${cleanNote}\n\n` : ""}${header}\n\n${message.body_text || ""}`;
    const fromAddress = mailbox.display_name ? `"${String(mailbox.display_name).replace(/["\r\n]/g, "")}" <${mailbox.email}>` : mailbox.email;
    const { raw } = buildRawMimeMessage({ from: fromAddress, to: address, subject, body, extraHeaders: {}, messageIdDomain: mailboxDomain(mailbox) });

    const usageId = await quotaService.consume(workspaceId, "emails", 1, { source: "forward" });
    try {
      await sendRawEmail({ mailbox, fromAddress, to: address, raw });
    } catch (error) {
      await quotaService.refund(workspaceId, usageId);
      throw error;
    }
    await db.query(`INSERT INTO sdr_forwards (workspace_id, user_id, message_id, to_address) VALUES ($1, $2, $3, $4)`, [workspaceId, userId || null, messageId, address]);
    return { forwarded: true };
  }
}

module.exports = new ForwardService();
module.exports.EMAIL = EMAIL;
