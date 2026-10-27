const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { ImapFlow } = require("imapflow");
const db = require("../config/db.config");
const { encryptSecret, decryptSecret } = require("../utils/secretBox.util");
const { WorkspaceError } = require("./workspace.service");
const { buildSeedReply } = require("../utils/warmnetContent");

const PRESETS = {
  gmail: { imapHost: "imap.gmail.com", imapPort: 993, smtpHost: "smtp.gmail.com", smtpPort: 465 },
  outlook: { imapHost: "outlook.office365.com", imapPort: 993, smtpHost: "smtp-mail.outlook.com", smtpPort: 587 },
  yahoo: { imapHost: "imap.mail.yahoo.com", imapPort: 993, smtpHost: "smtp.mail.yahoo.com", smtpPort: 465 },
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const POLL_LOOKBACK_DAYS = 3;
const POLL_CONCURRENCY = 3;

let polling = false;

const iso = (v) => (v ? new Date(v).toISOString() : null);

function mapSeed(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    provider: row.provider,
    imapHost: row.imap_host,
    imapPort: row.imap_port,
    smtpHost: row.smtp_host,
    smtpPort: row.smtp_port,
    status: row.status,
    dailyReceiveCap: row.daily_receive_cap,
    receivedToday: Number(row.received_today || 0),
    received7d: Number(row.received_7d || 0),
    inbox7d: Number(row.inbox_7d || 0),
    spam7d: Number(row.spam_7d || 0),
    replies7d: Number(row.replies_7d || 0),
    lastPolledAt: iso(row.last_polled_at),
    lastError: row.last_error,
    createdAt: iso(row.created_at),
  };
}

class WarmnetSeedService {
  presets() {
    return PRESETS;
  }

  async list() {
    const { rows } = await db.query(
      `SELECT s.*,
         (SELECT COUNT(*) FROM warmnet_messages m WHERE m.seed_id = s.id AND m.direction = 'to_seed' AND m.status = 'sent' AND m.sent_at >= date_trunc('day', NOW())) AS received_today,
         (SELECT COUNT(*) FROM warmnet_messages m WHERE m.seed_id = s.id AND m.direction = 'to_seed' AND m.status = 'sent' AND m.sent_at >= NOW() - INTERVAL '7 days') AS received_7d,
         (SELECT COUNT(*) FROM warmnet_messages m WHERE m.seed_id = s.id AND m.direction = 'to_seed' AND m.placement = 'inbox' AND m.sent_at >= NOW() - INTERVAL '7 days') AS inbox_7d,
         (SELECT COUNT(*) FROM warmnet_messages m WHERE m.seed_id = s.id AND m.direction = 'to_seed' AND m.placement = 'spam' AND m.sent_at >= NOW() - INTERVAL '7 days') AS spam_7d,
         (SELECT COUNT(*) FROM warmnet_messages m WHERE m.seed_id = s.id AND m.direction = 'from_seed' AND m.sent_at >= NOW() - INTERVAL '7 days') AS replies_7d
       FROM warmnet_seeds s ORDER BY s.id`
    );
    return rows.map(mapSeed);
  }

  async create(input = {}) {
    const email = String(input.email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new WorkspaceError("Enter a valid email address for the seed inbox.", 400);
    const password = String(input.password || "");
    if (!password) throw new WorkspaceError("Enter the app password for this inbox.", 400);
    const provider = ["gmail", "outlook", "yahoo", "other"].includes(input.provider) ? input.provider : "other";
    const preset = PRESETS[provider] || {};
    const imapHost = String(input.imapHost || preset.imapHost || "").trim();
    const smtpHost = String(input.smtpHost || preset.smtpHost || "").trim();
    if (!imapHost || !smtpHost) throw new WorkspaceError("IMAP and SMTP hosts are required for this provider.", 400);
    const cap = clampInt(input.dailyReceiveCap, 1, 300, 60);
    try {
      const { rows } = await db.query(
        `INSERT INTO warmnet_seeds (email, display_name, provider, imap_host, imap_port, smtp_host, smtp_port, username, password_encrypted, daily_receive_cap)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [
          email,
          String(input.displayName || "").trim().slice(0, 200) || null,
          provider,
          imapHost,
          clampInt(input.imapPort, 1, 65535, preset.imapPort || 993),
          smtpHost,
          clampInt(input.smtpPort, 1, 65535, preset.smtpPort || 465),
          String(input.username || email).trim(),
          encryptSecret(password),
          cap,
        ]
      );
      return mapSeed(rows[0]);
    } catch (error) {
      if (error.code === "23505") throw new WorkspaceError("That seed inbox has already been added.", 409);
      throw error;
    }
  }

  async update(id, input = {}) {
    const sets = [];
    const params = [id];
    const add = (col, val) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };
    if (input.displayName !== undefined) add("display_name", String(input.displayName || "").trim().slice(0, 200) || null);
    if (input.dailyReceiveCap !== undefined) add("daily_receive_cap", clampInt(input.dailyReceiveCap, 1, 300, 60));
    if (input.status !== undefined) {
      if (!["active", "paused"].includes(input.status)) throw new WorkspaceError("Status must be active or paused.", 400);
      add("status", input.status);
      if (input.status === "active") add("last_error", null);
    }
    if (input.password) add("password_encrypted", encryptSecret(String(input.password)));
    if (input.imapHost) add("imap_host", String(input.imapHost).trim());
    if (input.smtpHost) add("smtp_host", String(input.smtpHost).trim());
    if (input.imapPort) add("imap_port", clampInt(input.imapPort, 1, 65535, 993));
    if (input.smtpPort) add("smtp_port", clampInt(input.smtpPort, 1, 65535, 465));
    if (!sets.length) throw new WorkspaceError("Nothing to update.", 400);
    const { rows } = await db.query(`UPDATE warmnet_seeds SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $1 RETURNING *`, params);
    if (!rows[0]) throw new WorkspaceError("That seed inbox could not be found.", 404);
    return mapSeed(rows[0]);
  }

  async remove(id) {
    const { rowCount } = await db.query(`DELETE FROM warmnet_seeds WHERE id = $1`, [id]);
    if (!rowCount) throw new WorkspaceError("That seed inbox could not be found.", 404);
  }

  async get(id) {
    const { rows } = await db.query(`SELECT * FROM warmnet_seeds WHERE id = $1`, [id]);
    if (!rows[0]) throw new WorkspaceError("That seed inbox could not be found.", 404);
    return rows[0];
  }

  /** Verifies both the IMAP login and the SMTP login without sending anything. */
  async test(id) {
    const seed = await this.get(id);
    const result = { imap: { ok: false }, smtp: { ok: false } };
    const client = this.imapClient(seed);
    try {
      await client.connect();
      const boxes = await client.list();
      result.imap = { ok: true, folders: boxes.length, junkFolder: findJunk(boxes) };
    } catch (error) {
      result.imap = { ok: false, error: String(error.message || error).slice(0, 300) };
    } finally {
      await client.logout().catch(() => client.close());
    }
    try {
      await this.transportFor(seed).verify();
      result.smtp = { ok: true };
    } catch (error) {
      result.smtp = { ok: false, error: String(error.message || error).slice(0, 300) };
    }
    const healthy = result.imap.ok && result.smtp.ok;
    await db.query(
      `UPDATE warmnet_seeds SET last_error = $2, status = CASE WHEN $3 THEN CASE WHEN status = 'error' THEN 'active' ELSE status END ELSE status END, updated_at = NOW() WHERE id = $1`,
      [id, healthy ? null : [result.imap.error && `IMAP: ${result.imap.error}`, result.smtp.error && `SMTP: ${result.smtp.error}`].filter(Boolean).join(" | "), healthy]
    );
    return result;
  }

  imapClient(seed) {
    const client = new ImapFlow({
      host: seed.imap_host,
      port: seed.imap_port,
      secure: Number(seed.imap_port) === 993,
      auth: { user: seed.username, pass: decryptSecret(seed.password_encrypted) },
      logger: false,
      socketTimeout: 60000,
    });
    client.on("error", () => {});
    return client;
  }

  transportFor(seed) {
    return nodemailer.createTransport({
      host: seed.smtp_host,
      port: seed.smtp_port,
      secure: Number(seed.smtp_port) === 465,
      requireTLS: Number(seed.smtp_port) !== 465,
      auth: { user: seed.username, pass: decryptSecret(seed.password_encrypted) },
      connectionTimeout: 20000,
      socketTimeout: 60000,
    });
  }

  /** A seed answers one of our warm-up emails, in-thread, from its own address. */
  async sendReply({ seed, to, subject, inReplyTo }) {
    const messageId = `<${crypto.randomUUID()}@${String(seed.email).split("@")[1]}>`;
    const transport = this.transportFor(seed);
    try {
      await transport.sendMail({
        from: seed.display_name ? { name: seed.display_name, address: seed.email } : seed.email,
        to,
        subject: /^re:/i.test(subject || "") ? subject : `Re: ${subject || ""}`,
        text: `${buildSeedReply()}\n\n${seed.display_name || ""}`.trim(),
        messageId,
        inReplyTo,
        references: inReplyTo,
      });
    } finally {
      transport.close();
    }
    return { messageId };
  }

  /** Cron entry: every active seed, a few in parallel. Overlap-guarded. */
  async pollAll(settings) {
    if (polling) return [];
    polling = true;
    try {
      const { rows: seeds } = await db.query(`SELECT * FROM warmnet_seeds WHERE status = 'active' ORDER BY last_polled_at ASC NULLS FIRST, id`);
      const results = [];
      for (let i = 0; i < seeds.length; i += POLL_CONCURRENCY) {
        results.push(...(await Promise.all(seeds.slice(i, i + POLL_CONCURRENCY).map((seed) => this.pollSeed(seed, settings)))));
      }
      await db.query(`UPDATE warmnet_settings SET last_seed_poll_at = NOW() WHERE id = 1`);
      return results;
    } finally {
      polling = false;
    }
  }

  /**
   * One pass over a seed's mailbox: finds our warm-up emails, records where each landed (INBOX vs spam), pulls spam
   * ones into the inbox, marks everything read, stars a share and schedules the human-looking reply.
   */
  async pollSeed(seed, settings) {
    const { rows: pending } = await db.query(
      `SELECT id, rfc_message_id, placement, rescued, reply_due_at, seed_read_at
       FROM warmnet_messages
       WHERE seed_id = $1 AND direction = 'to_seed' AND status = 'sent' AND sent_at > NOW() - INTERVAL '${POLL_LOOKBACK_DAYS} days'
         AND (placement = 'unknown' OR (placement = 'spam' AND rescued = FALSE))`,
      [seed.id]
    );
    if (!pending.length) {
      await db.query(`UPDATE warmnet_seeds SET last_polled_at = NOW() WHERE id = $1`, [seed.id]);
      return { seedId: seed.id, checked: 0 };
    }
    const byId = new Map(pending.map((r) => [r.rfc_message_id, r]));
    const client = this.imapClient(seed);
    let matched = 0;
    try {
      await client.connect();
      const boxes = await client.list();
      const junk = findJunk(boxes);
      for (const folder of ["INBOX", junk].filter(Boolean)) {
        const lock = await client.getMailboxLock(folder);
        try {
          const since = new Date(Date.now() - POLL_LOOKBACK_DAYS * 86_400_000);
          const uids = await client.search({ since }, { uid: true });
          if (!uids || !uids.length) continue;
          const hits = [];
          for await (const msg of client.fetch(uids, { uid: true, envelope: true, flags: true }, { uid: true })) {
            const row = msg.envelope && byId.get(msg.envelope.messageId);
            if (row) hits.push({ uid: msg.uid, row, flags: msg.flags });
          }
          for (const hit of hits) {
            matched += 1;
            const inJunk = folder !== "INBOX";
            let rescued = false;
            if (inJunk) {
              await client.messageMove(hit.uid, "INBOX", { uid: true }).then(() => (rescued = true)).catch(() => {});
            }
            const flags = ["\\Seen"];
            if (Math.random() < Number(settings.starRate)) flags.push("\\Flagged");
            if (!rescued && inJunk) {
              // Move failed: still count the placement, mark read where it is.
              await client.messageFlagsAdd(hit.uid, flags, { uid: true }).catch(() => {});
            } else if (!inJunk) {
              await client.messageFlagsAdd(hit.uid, flags, { uid: true }).catch(() => {});
            }
            const wantsReply = !hit.row.reply_due_at && Math.random() < Number(settings.replyRate);
            await db.query(
              `UPDATE warmnet_messages SET placement = $2, placement_checked_at = NOW(), rescued = $3,
                 seed_read_at = COALESCE(seed_read_at, NOW()),
                 reply_due_at = CASE WHEN $4 THEN NOW() + (($5)::int * INTERVAL '1 minute') ELSE reply_due_at END
               WHERE id = $1`,
              [hit.row.id, inJunk ? "spam" : "inbox", rescued, wantsReply, 5 + Math.floor(Math.random() * 115)]
            );
            byId.delete(hit.row.rfc_message_id);
          }
        } finally {
          lock.release();
        }
      }
      await db.query(`UPDATE warmnet_seeds SET last_polled_at = NOW(), last_error = NULL, status = CASE WHEN status = 'error' THEN 'active' ELSE status END WHERE id = $1`, [seed.id]);
      return { seedId: seed.id, checked: pending.length, matched };
    } catch (error) {
      const message = String(error.message || error).slice(0, 500);
      const authFailed = /auth|credential|login|password/i.test(message);
      await db
        .query(`UPDATE warmnet_seeds SET last_polled_at = NOW(), last_error = $2, status = CASE WHEN $3 THEN 'error' ELSE status END WHERE id = $1`, [seed.id, message, authFailed])
        .catch(() => {});
      return { seedId: seed.id, error: message };
    } finally {
      await client.logout().catch(() => client.close());
    }
  }
}

function findJunk(boxes) {
  const special = boxes.find((b) => b.specialUse === "\\Junk");
  if (special) return special.path;
  const named = boxes.find((b) => /(^|[\/.])(spam|junk)( e-?mail)?$/i.test(b.path));
  return named ? named.path : null;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

module.exports = new WarmnetSeedService();
module.exports.clampInt = clampInt;
