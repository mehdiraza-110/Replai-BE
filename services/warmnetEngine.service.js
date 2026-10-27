const db = require("../config/db.config");
const { sendRawEmail } = require("./mailTransport.service");
const seedService = require("./warmnetSeed.service");
const { buildInitial, buildCounterReply } = require("../utils/warmnetContent");

// Lazy: campaignSend builds AWS clients at import time and also exports the shared MIME helpers.
const mime = () => require("./campaignSend.service");

const DEFAULTS = {
  startPerDay: 3,
  incrementPerDay: 1,
  maxPerDay: 25,
  maintenancePerDay: 5,
  weekendFactor: 0.5,
  timezone: "America/New_York",
  windowStartHour: 8,
  windowEndHour: 19,
  replyRate: 0.45,
  counterReplyRate: 0.5,
  starRate: 0.35,
  readyAfterDays: 21,
  readyMinInboxRate: 0.85,
  readyMinPlaced: 30,
  holdBelowInboxRate: 0.5,
  holdMinPlaced: 10,
  maxConsecutiveFailures: 5,
  maxSendsPerTick: 150,
};

let ticking = false;

async function getSettings() {
  const { rows } = await db.query(`SELECT enabled, config FROM warmnet_settings WHERE id = 1`);
  const row = rows[0] || { enabled: false, config: {} };
  return { enabled: row.enabled === true, ...DEFAULTS, ...(row.config || {}) };
}

/** Local wall-clock parts in the configured timezone. */
function localParts(timezone, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: get("weekday"),
    hours: Number(get("hour")) + Number(get("minute")) / 60,
  };
}

function dailyTarget(row, settings, local) {
  const base = row.state === "released"
    ? settings.maintenancePerDay
    : Math.min(settings.maxPerDay, settings.startPerDay + Math.floor((row.ramp_day - 1) * settings.incrementPerDay));
  const weekend = local.weekday === "Sat" || local.weekday === "Sun";
  return Math.max(1, Math.round(weekend ? base * settings.weekendFactor : base));
}

class WarmnetEngineService {
  /** Cron entry. Rolls days over, then sends what each mailbox is due, then seed replies and our counter-replies. */
  async runTick({ force = false } = {}) {
    if (ticking) return { skipped: "busy" };
    ticking = true;
    const summary = { sent: 0, failed: 0, seedReplies: 0, counterReplies: 0, rolled: 0, ready: 0, skippedNoSeed: 0, skippedBlocklisted: 0 };
    try {
      const settings = await getSettings();
      if (!settings.enabled && !force) return { skipped: "disabled" };
      const local = localParts(settings.timezone);

      summary.rolled = await this.rollOver(settings, local, summary);

      const inWindow = local.hours >= settings.windowStartHour && local.hours < settings.windowEndHour;
      if (inWindow || force) {
        await this.sendDue(settings, local, summary);
        summary.seedReplies = await this.sendSeedReplies();
        summary.counterReplies = await this.sendCounterReplies(settings, summary);
      }
      await db.query(`UPDATE warmnet_settings SET last_tick_at = NOW(), last_tick_summary = $1 WHERE id = 1`, [JSON.stringify({ ...summary, inWindow })]);
      return { ...summary, inWindow };
    } finally {
      ticking = false;
    }
  }

  /** Once per local day per mailbox: advance (or hold) the ramp, reset the counter, flag mailboxes that earned "ready". */
  async rollOver(settings, local, summary) {
    const { rows } = await db.query(
      `SELECT wm.*, m.email,
         (SELECT COUNT(*) FROM warmnet_messages x WHERE x.mailbox_id = wm.mailbox_id AND x.direction = 'to_seed' AND x.status = 'sent'
            AND x.placement IN ('inbox','spam') AND x.sent_at >= NOW() - INTERVAL '7 days') AS placed7,
         (SELECT COUNT(*) FROM warmnet_messages x WHERE x.mailbox_id = wm.mailbox_id AND x.direction = 'to_seed' AND x.status = 'sent'
            AND x.placement = 'inbox' AND x.sent_at >= NOW() - INTERVAL '7 days') AS inbox7,
         (SELECT COUNT(*) FROM warmnet_messages x WHERE x.mailbox_id = wm.mailbox_id AND x.direction = 'to_seed' AND x.status = 'sent'
            AND x.placement IN ('inbox','spam') AND x.sent_at >= NOW() - INTERVAL '14 days') AS placed14,
         (SELECT COUNT(*) FROM warmnet_messages x WHERE x.mailbox_id = wm.mailbox_id AND x.direction = 'to_seed' AND x.status = 'sent'
            AND x.placement = 'inbox' AND x.sent_at >= NOW() - INTERVAL '14 days') AS inbox14
       FROM warmnet_mailboxes wm JOIN mailboxes m ON m.id = wm.mailbox_id AND m.is_deleted = FALSE
       WHERE wm.state IN ('warming', 'released') AND (wm.today_date IS NULL OR wm.today_date::text <> $1)`,
      [local.date]
    );
    let count = 0;
    for (const row of rows) {
      const placed7 = Number(row.placed7);
      const inboxRate7 = placed7 ? Number(row.inbox7) / placed7 : null;
      const prevLocal = { weekday: "Mon" };
      const prevTarget = dailyTarget(row, settings, prevLocal);
      const hitTarget = row.today_sent >= Math.ceil(prevTarget * 0.7);
      const struggling = placed7 >= settings.holdMinPlaced && inboxRate7 !== null && inboxRate7 < settings.holdBelowInboxRate;
      // A mailbox that has not had a full day yet (today_date still null) stays on day 1.
      const fullDay = row.today_date != null;
      const advance = row.state === "warming" && fullDay && hitTarget && !struggling;

      let nextState = row.state;
      let readyAt = row.ready_at;
      if (row.state === "warming" && row.started_at) {
        const daysIn = (Date.now() - new Date(row.started_at).getTime()) / 86_400_000;
        const placed14 = Number(row.placed14);
        const inboxRate14 = placed14 ? Number(row.inbox14) / placed14 : 0;
        if (daysIn >= settings.readyAfterDays && placed14 >= settings.readyMinPlaced && inboxRate14 >= settings.readyMinInboxRate) {
          nextState = "ready";
          readyAt = new Date();
          summary.ready += 1;
        }
      }
      await db.query(
        `UPDATE warmnet_mailboxes SET ramp_day = ramp_day + $2, held_days = held_days + $3, today_date = $4, today_sent = 0,
           state = $5, ready_at = $6, updated_at = NOW() WHERE mailbox_id = $1`,
        [row.mailbox_id, advance ? 1 : 0, row.state === "warming" && fullDay && !advance ? 1 : 0, local.date, nextState, readyAt]
      );
      count += 1;
    }
    return count;
  }

  async sendDue(settings, local, summary) {
    const { rows } = await db.query(
      `SELECT wm.*, m.id AS m_id, m.email, m.display_name, m.provider, m.workspace_id, m.status AS mailbox_status, m.domain_id,
              ip.clean AS ip_clean
       FROM warmnet_mailboxes wm
       JOIN mailboxes m ON m.id = wm.mailbox_id AND m.is_deleted = FALSE
       JOIN domains d ON d.id = m.domain_id AND d.is_deleted = FALSE AND d.status = 'Verified'
       LEFT JOIN warmnet_domains wd ON wd.domain_id = d.id
       LEFT JOIN warmnet_ips ip ON ip.id = wd.ip_id
       WHERE wm.state IN ('warming', 'released')
       ORDER BY wm.today_sent ASC, wm.mailbox_id ASC`
    );
    const windowLen = settings.windowEndHour - settings.windowStartHour;
    const progress = Math.min(1, Math.max(0, (local.hours - settings.windowStartHour) / windowLen) + 0.08);

    const seedLoad = await this.seedLoad();
    let budget = settings.maxSendsPerTick;
    for (const row of rows) {
      if (budget <= 0) break;
      if (row.ip_clean === false) {
        summary.skippedBlocklisted += 1;
        continue;
      }
      const target = dailyTarget(row, settings, local);
      const due = Math.ceil(target * Math.min(1, progress));
      if (row.today_sent >= due || row.today_sent >= target) continue;

      const seed = this.chooseSeed(seedLoad, row.mailbox_id);
      if (!seed) {
        summary.skippedNoSeed += 1;
        continue;
      }
      const sent = await this.sendInitial(row, seed);
      if (sent) {
        summary.sent += 1;
        seedLoad.today.set(seed.id, (seedLoad.today.get(seed.id) || 0) + 1);
        seedLoad.pair.set(`${row.mailbox_id}:${seed.id}`, (seedLoad.pair.get(`${row.mailbox_id}:${seed.id}`) || 0) + 1);
      } else {
        summary.failed += 1;
      }
      budget -= 1;
    }
  }

  async seedLoad() {
    const [seeds, today, pairs] = await Promise.all([
      db.query(`SELECT * FROM warmnet_seeds WHERE status = 'active'`),
      db.query(`SELECT seed_id, COUNT(*) AS n FROM warmnet_messages WHERE direction = 'to_seed' AND status = 'sent' AND sent_at >= date_trunc('day', NOW()) GROUP BY seed_id`),
      db.query(`SELECT mailbox_id, seed_id, COUNT(*) AS n FROM warmnet_messages WHERE direction = 'to_seed' AND status = 'sent' AND sent_at >= NOW() - INTERVAL '2 days' GROUP BY mailbox_id, seed_id`),
    ]);
    return {
      seeds: seeds.rows,
      today: new Map(today.rows.map((r) => [r.seed_id, Number(r.n)])),
      pair: new Map(pairs.rows.map((r) => [`${r.mailbox_id}:${r.seed_id}`, Number(r.n)])),
    };
  }

  /** The seed with room today that this mailbox has used least recently; random among ties so load spreads. */
  chooseSeed(load, mailboxId) {
    const open = load.seeds.filter((s) => (load.today.get(s.id) || 0) < s.daily_receive_cap);
    if (!open.length) return null;
    const used = (s) => load.pair.get(`${mailboxId}:${s.id}`) || 0;
    const least = Math.min(...open.map(used));
    const tied = open.filter((s) => used(s) === least);
    return tied[Math.floor(Math.random() * tied.length)];
  }

  async sendInitial(row, seed) {
    const senderName = row.display_name || row.email.split("@")[0];
    const seedFirst = (seed.display_name || seed.email.split("@")[0]).split(/[\s._-]/)[0];
    const { subject, body } = buildInitial({ seedName: capitalize(seedFirst), senderName });
    return this.deliver({ row, seed, subject, body, kind: "initial", threadKey: null, inReplyTo: null });
  }

  /** Builds the MIME, sends it through the mailbox's own provider, records the row and updates counters. */
  async deliver({ row, seed, subject, body, kind, threadKey, inReplyTo }) {
    const { buildRawMimeMessage, mailboxDomain, sesClient } = mime();
    const fromAddress = row.display_name ? `"${String(row.display_name).replace(/["\\\r\n]/g, "")}" <${row.email}>` : row.email;
    const extra = inReplyTo ? { "In-Reply-To": inReplyTo, References: inReplyTo } : {};
    const { raw, messageId } = buildRawMimeMessage({
      from: fromAddress,
      to: seed.email,
      subject,
      body,
      extraHeaders: extra,
      messageIdDomain: mailboxDomain({ email: row.email }),
    });
    const thread = threadKey || messageId.replace(/[<>]/g, "").slice(0, 60);
    try {
      await sendRawEmail({ mailbox: { id: row.mailbox_id, email: row.email, provider: row.provider }, fromAddress, to: seed.email, raw, sesClient, tags: [] });
      await db.query(
        `INSERT INTO warmnet_messages (mailbox_id, seed_id, direction, kind, thread_key, rfc_message_id, in_reply_to, subject, status)
         VALUES ($1, $2, 'to_seed', $3, $4, $5, $6, $7, 'sent')`,
        [row.mailbox_id, seed.id, kind, thread, messageId, inReplyTo, subject]
      );
      await db.query(
        `UPDATE warmnet_mailboxes SET today_sent = today_sent + 1, total_sent = total_sent + 1, consecutive_failures = 0, last_sent_at = NOW(), updated_at = NOW() WHERE mailbox_id = $1`,
        [row.mailbox_id]
      );
      return true;
    } catch (error) {
      const message = String(error.message || error).slice(0, 500);
      await db
        .query(
          `INSERT INTO warmnet_messages (mailbox_id, seed_id, direction, kind, thread_key, rfc_message_id, in_reply_to, subject, status, error)
           VALUES ($1, $2, 'to_seed', $3, $4, $5, $6, $7, 'failed', $8)`,
          [row.mailbox_id, seed.id, kind, thread, messageId, inReplyTo, subject, message]
        )
        .catch(() => {});
      const { rows } = await db.query(
        `UPDATE warmnet_mailboxes SET consecutive_failures = consecutive_failures + 1, updated_at = NOW() WHERE mailbox_id = $1 RETURNING consecutive_failures`,
        [row.mailbox_id]
      );
      const settings = await getSettings();
      if (rows[0] && rows[0].consecutive_failures >= settings.maxConsecutiveFailures) {
        await db.query(
          `UPDATE warmnet_mailboxes SET state = 'paused', pause_reason = $2, updated_at = NOW() WHERE mailbox_id = $1`,
          [row.mailbox_id, `Paused automatically after ${rows[0].consecutive_failures} failed sends in a row. Last error: ${message}`.slice(0, 500)]
        );
      }
      return false;
    }
  }

  /** Seeds answer the emails they decided to reply to (reply_due_at has passed). */
  async sendSeedReplies() {
    const { rows } = await db.query(
      `SELECT wm.id, wm.rfc_message_id, wm.subject, wm.thread_key, wm.mailbox_id, wm.seed_id, mb.email AS mailbox_email
       FROM warmnet_messages wm JOIN mailboxes mb ON mb.id = wm.mailbox_id
       WHERE wm.direction = 'to_seed' AND wm.status = 'sent' AND wm.replied_at IS NULL AND wm.reply_due_at IS NOT NULL AND wm.reply_due_at <= NOW()
       ORDER BY wm.reply_due_at LIMIT 40`
    );
    let sent = 0;
    for (const msg of rows) {
      const { rows: seeds } = await db.query(`SELECT * FROM warmnet_seeds WHERE id = $1 AND status = 'active'`, [msg.seed_id]);
      if (!seeds[0]) continue;
      try {
        const { messageId } = await seedService.sendReply({ seed: seeds[0], to: msg.mailbox_email, subject: msg.subject, inReplyTo: msg.rfc_message_id });
        await db.query(
          `INSERT INTO warmnet_messages (mailbox_id, seed_id, direction, kind, thread_key, rfc_message_id, in_reply_to, subject, status)
           VALUES ($1, $2, 'from_seed', 'reply', $3, $4, $5, $6, 'sent')`,
          [msg.mailbox_id, msg.seed_id, msg.thread_key, messageId, msg.rfc_message_id, /^re:/i.test(msg.subject || "") ? msg.subject : `Re: ${msg.subject}`]
        );
        await db.query(`UPDATE warmnet_messages SET replied_at = NOW() WHERE id = $1`, [msg.id]);
        sent += 1;
      } catch (error) {
        await db.query(`UPDATE warmnet_messages SET reply_due_at = NOW() + INTERVAL '45 minutes', error = $2 WHERE id = $1`, [msg.id, String(error.message || error).slice(0, 300)]);
      }
    }
    return sent;
  }

  /** Our mailbox answers a seed's reply, closing the thread the way a person would. */
  async sendCounterReplies(settings, summary) {
    const { rows } = await db.query(
      `SELECT r.id, r.thread_key, r.rfc_message_id, r.subject, r.seed_id, r.mailbox_id,
              m.email, m.display_name, m.provider
       FROM warmnet_messages r JOIN mailboxes m ON m.id = r.mailbox_id AND m.is_deleted = FALSE
       WHERE r.direction = 'from_seed' AND r.status = 'received' AND r.followup_due_at IS NOT NULL AND r.followup_due_at <= NOW() AND r.followed_up_at IS NULL
       ORDER BY r.followup_due_at LIMIT 40`
    );
    let sent = 0;
    for (const r of rows) {
      const { rows: seeds } = await db.query(`SELECT * FROM warmnet_seeds WHERE id = $1`, [r.seed_id]);
      if (!seeds[0]) continue;
      const ok = await this.deliver({
        row: { mailbox_id: r.mailbox_id, email: r.email, display_name: r.display_name, provider: r.provider },
        seed: seeds[0],
        subject: /^re:/i.test(r.subject || "") ? r.subject : `Re: ${r.subject}`,
        body: buildCounterReply({ senderName: r.display_name || r.email.split("@")[0] }),
        kind: "reply",
        threadKey: r.thread_key,
        inReplyTo: r.rfc_message_id,
      });
      await db.query(`UPDATE warmnet_messages SET followed_up_at = NOW() WHERE id = $1`, [r.id]);
      if (ok) sent += 1;
      else summary.failed += 1;
    }
    return sent;
  }

  /**
   * Hook for the inbound pipeline: a reply from one of our seeds to a warm-up email. Returns { handled: true } when the
   * message belongs to warm-up traffic, so the normal pipeline (AI agent, suppression, inbox) never sees it.
   */
  async handleInbound(parsed) {
    const parent = String(parsed.inReplyTo || "").trim();
    if (!parent) return { handled: false };
    const { rows } = await db.query(`SELECT id, mailbox_id, seed_id, thread_key, subject FROM warmnet_messages WHERE rfc_message_id = $1`, [parent]);
    if (!rows[0]) return { handled: false };
    const settings = await getSettings();
    const msgId = parsed.messageId || null;
    const { rows: self } = msgId ? await db.query(`SELECT id FROM warmnet_messages WHERE rfc_message_id = $1`, [msgId]) : { rows: [] };
    const { rows: depth } = await db.query(`SELECT COUNT(*) AS n FROM warmnet_messages WHERE thread_key = $1`, [rows[0].thread_key]);
    const wantsCounter = Number(depth[0].n) < 4 && Math.random() < Number(settings.counterReplyRate);
    const due = wantsCounter ? 10 + Math.floor(Math.random() * 80) : null;
    if (self[0]) {
      await db.query(
        `UPDATE warmnet_messages SET status = 'received', followup_due_at = CASE WHEN $2::int IS NULL THEN NULL ELSE NOW() + ($2::int * INTERVAL '1 minute') END WHERE id = $1`,
        [self[0].id, due]
      );
    } else if (msgId) {
      await db.query(
        `INSERT INTO warmnet_messages (mailbox_id, seed_id, direction, kind, thread_key, rfc_message_id, in_reply_to, subject, status, followup_due_at)
         VALUES ($1, $2, 'from_seed', 'reply', $3, $4, $5, $6, 'received', CASE WHEN $7::int IS NULL THEN NULL ELSE NOW() + ($7::int * INTERVAL '1 minute') END)
         ON CONFLICT (rfc_message_id) DO NOTHING`,
        [rows[0].mailbox_id, rows[0].seed_id, rows[0].thread_key, msgId, parent, parsed.subject || rows[0].subject, due]
      );
    }
    return { handled: true };
  }
}

const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

module.exports = new WarmnetEngineService();
module.exports.DEFAULTS = DEFAULTS;
module.exports.getSettings = getSettings;
module.exports.localParts = localParts;
module.exports.dailyTarget = dailyTarget;
