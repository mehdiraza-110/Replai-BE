const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const db = require("../config/db.config");
const suppressionService = require("./suppression.service");
const sesInboundEmailService = require("./sesInboundEmail.service");
const { decryptSecret } = require("../utils/secretBox.util");

// Mailboxes polled in parallel, and messages fetched per mailbox per poll. Both are kept
// small so one tick never hammers Maildoso's IMAP servers; the backlog drains over ticks.
const POLL_CONCURRENCY = 5;
const MAX_MESSAGES_PER_POLL = 50;

let polling = false;

class ImapInboxService {
  /** Cron entry point. Guarded so a slow tick can never overlap the next one. */
  async runTick() {
    if (polling) return [];
    polling = true;
    try {
      const { rows: mailboxes } = await db.query(
        `SELECT * FROM mailboxes
         WHERE provider = 'maildoso' AND is_deleted = FALSE AND status = 'Active' AND password_encrypted IS NOT NULL
         ORDER BY imap_last_polled_at ASC NULLS FIRST, id ASC`
      );

      const results = [];
      for (let i = 0; i < mailboxes.length; i += POLL_CONCURRENCY) {
        const batch = mailboxes.slice(i, i + POLL_CONCURRENCY);
        results.push(...(await Promise.all(batch.map((mailbox) => this.pollMailbox(mailbox)))));
      }
      return results;
    } finally {
      polling = false;
    }
  }

  async pollMailbox(mailbox) {
    const client = new ImapFlow({
      host: mailbox.imap_host,
      port: mailbox.imap_port,
      secure: Number(mailbox.imap_port) === 993,
      auth: { user: mailbox.email, pass: decryptSecret(mailbox.password_encrypted) },
      logger: false,
      socketTimeout: 60000,
    });
    // imapflow emits connection-level failures as 'error'; without a listener they crash the process.
    client.on("error", () => {});

    let imported = 0;
    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      try {
        let lastUid = Number(mailbox.imap_last_uid) || 0;
        const uidValidity = Number(client.mailbox.uidValidity);
        // A changed UIDVALIDITY means the server renumbered the folder: start over.
        if (mailbox.imap_uid_validity && Number(mailbox.imap_uid_validity) !== uidValidity) lastUid = 0;

        const pending = [];
        for await (const message of client.fetch(`${lastUid + 1}:*`, { uid: true, source: true }, { uid: true })) {
          if (message.uid > lastUid) pending.push(message);
          if (pending.length >= MAX_MESSAGES_PER_POLL) break;
        }
        pending.sort((a, b) => a.uid - b.uid);

        for (const message of pending) {
          try {
            await this.processMessage(mailbox, message.source);
            imported += 1;
          } catch (error) {
            console.error(`IMAP message ${message.uid} for ${mailbox.email} failed:`, error.message);
          }
          lastUid = message.uid;
          await db.query(`UPDATE mailboxes SET imap_last_uid = $2 WHERE id = $1`, [mailbox.id, lastUid]);
        }

        await db.query(
          `UPDATE mailboxes SET imap_uid_validity = $2, imap_last_polled_at = NOW(), imap_last_error = NULL WHERE id = $1`,
          [mailbox.id, uidValidity]
        );
      } finally {
        lock.release();
      }
      return { mailboxId: mailbox.id, imported };
    } catch (error) {
      await db
        .query(`UPDATE mailboxes SET imap_last_polled_at = NOW(), imap_last_error = $2 WHERE id = $1`, [mailbox.id, String(error.message).slice(0, 500)])
        .catch(() => {});
      return { mailboxId: mailbox.id, error: error.message };
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  async processMessage(mailbox, source) {
    const parsed = await simpleParser(source);
    const bounce = detectBounce(parsed, source);
    if (bounce) {
      await this.handleBounce(mailbox, bounce);
      return;
    }
    if (isAutoReply(parsed)) return; // out-of-office etc: neither a real reply nor a bounce
    await sesInboundEmailService.processParsedEmail({ parsed });
  }

  /** Only a permanent (5.x.x) failure suppresses, mirroring the SES bounce handler. */
  async handleBounce(mailbox, { recipient, isHard }) {
    if (!recipient || !isHard) return;
    await suppressionService.addSuppression({ email: recipient, reason: "hard_bounce", source: "imap_bounce" });
    await db.query(
      `UPDATE campaign_leads SET status = 'Bounced' WHERE mailbox_id = $1 AND email = $2 AND status != 'Bounced'`,
      [mailbox.id, recipient]
    );
  }
}

/** Delivery-status notification (RFC 3464) or a mailer-daemon/postmaster sender. */
function detectBounce(parsed, source) {
  const from = parsed.from?.value?.[0]?.address?.toLowerCase() || "";
  const contentType = String(parsed.headers?.get("content-type")?.value || "");
  const isDsn = /delivery-status/i.test(String(parsed.headers?.get("content-type")?.params?.["report-type"] || "")) || contentType === "multipart/report";
  if (!isDsn && !/^(mailer-daemon|postmaster)@/.test(from)) return null;

  const text = source.toString("utf8");
  const recipient = text.match(/Final-Recipient:\s*rfc822;\s*<?([^\s>]+)>?/i)?.[1]?.toLowerCase() || null;
  const status = text.match(/^Status:\s*(\d)\.\d+\.\d+/im)?.[1];
  return { recipient, isHard: status === "5" };
}

function isAutoReply(parsed) {
  const autoSubmitted = String(parsed.headers?.get("auto-submitted") || "").toLowerCase();
  return (autoSubmitted && autoSubmitted !== "no") || /^(auto(matic)? reply|out of office)/i.test(parsed.subject || "");
}

module.exports = new ImapInboxService();
