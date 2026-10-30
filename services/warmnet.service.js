const db = require("../config/db.config");
const engine = require("./warmnetEngine.service");
const seedService = require("./warmnetSeed.service");
const ipService = require("./warmnetIp.service");
const { generatePeople } = require("../utils/warmnetContent");
const { WorkspaceError } = require("./workspace.service");

const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PLATFORM_SLUG = "koval-group";
const STATES = ["queued", "warming", "paused", "ready", "released"];
const iso = (v) => (v ? new Date(v).toISOString() : null);
const num = (v) => Number(v || 0);
const rate = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

// Settings the admin may change, with hard limits so a typo cannot make the engine spam.
const SETTING_LIMITS = {
  startPerDay: [1, 20], incrementPerDay: [0, 5], maxPerDay: [1, 60], maintenancePerDay: [0, 30], weekendFactor: [0, 1],
  windowStartHour: [0, 23], windowEndHour: [1, 24], replyRate: [0, 1], counterReplyRate: [0, 1], starRate: [0, 1],
  readyAfterDays: [7, 90], readyMinInboxRate: [0.3, 1], readyMinPlaced: [5, 500], holdBelowInboxRate: [0, 1], holdMinPlaced: [3, 200],
  maxConsecutiveFailures: [2, 50], maxSendsPerTick: [10, 500],
};

function pageArgs(q = {}) {
  const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 25));
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  return { limit, page, offset: (page - 1) * limit };
}

class WarmnetService {
  // ---------------- settings ----------------
  async getSettings() {
    const s = await engine.getSettings();
    const { rows } = await db.query(`SELECT last_tick_at, last_tick_summary, last_seed_poll_at FROM warmnet_settings WHERE id = 1`);
    const { enabled, ...config } = s;
    return {
      enabled,
      config,
      defaults: engine.DEFAULTS,
      lastTickAt: iso(rows[0]?.last_tick_at),
      lastTickSummary: rows[0]?.last_tick_summary || null,
      lastSeedPollAt: iso(rows[0]?.last_seed_poll_at),
    };
  }

  async updateSettings(input = {}) {
    const config = {};
    for (const [key, [min, max]] of Object.entries(SETTING_LIMITS)) {
      if (input.config && input.config[key] !== undefined) {
        const n = Number(input.config[key]);
        if (!Number.isFinite(n) || n < min || n > max) throw new WorkspaceError(`"${key}" must be between ${min} and ${max}.`, 400);
        config[key] = n;
      }
    }
    if (input.config && input.config.timezone !== undefined) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: String(input.config.timezone) });
      } catch {
        throw new WorkspaceError("That timezone is not valid (use a name like America/New_York).", 400);
      }
      config.timezone = String(input.config.timezone);
    }
    const merged = { ...(await engine.getSettings()), ...config };
    if (merged.windowEndHour <= merged.windowStartHour) throw new WorkspaceError("The sending window must end after it starts.", 400);
    if (merged.maxPerDay < merged.startPerDay) throw new WorkspaceError("The daily maximum cannot be lower than the starting volume.", 400);
    const sets = [`config = COALESCE(config, '{}'::jsonb) || $1::jsonb`, `updated_at = NOW()`];
    const params = [JSON.stringify(config)];
    if (typeof input.enabled === "boolean") {
      params.push(input.enabled);
      sets.push(`enabled = $${params.length}`);
    }
    await db.query(`UPDATE warmnet_settings SET ${sets.join(", ")} WHERE id = 1`, params);
    return this.getSettings();
  }

  // ---------------- overview ----------------
  async overview() {
    const settings = await engine.getSettings();
    const local = engine.localParts(settings.timezone);
    const [states, seeds, today, placement, mbRows, ips, domains, tick, replies] = await Promise.all([
      db.query(`SELECT state, COUNT(*) AS n FROM warmnet_mailboxes GROUP BY state`),
      db.query(`SELECT status, COUNT(*) AS n, COALESCE(SUM(daily_receive_cap), 0) AS cap FROM warmnet_seeds GROUP BY status`),
      db.query(
        `SELECT COUNT(*) FILTER (WHERE direction = 'to_seed' AND status = 'sent') AS sent,
                COUNT(*) FILTER (WHERE direction = 'to_seed' AND status = 'failed') AS failed,
                COUNT(*) FILTER (WHERE direction = 'from_seed') AS replies
         FROM warmnet_messages WHERE sent_at >= date_trunc('day', NOW() AT TIME ZONE $1) AT TIME ZONE $1`,
        [settings.timezone]
      ),
      db.query(
        `SELECT COUNT(*) FILTER (WHERE placement = 'inbox') AS inbox, COUNT(*) FILTER (WHERE placement = 'spam') AS spam,
                COUNT(*) FILTER (WHERE placement = 'unknown') AS unknown, COUNT(*) FILTER (WHERE rescued) AS rescued
         FROM warmnet_messages WHERE direction = 'to_seed' AND status = 'sent' AND sent_at >= NOW() - INTERVAL '7 days'`
      ),
      db.query(`SELECT wm.state, wm.ramp_day, m.email FROM warmnet_mailboxes wm JOIN mailboxes m ON m.id = wm.mailbox_id AND m.is_deleted = FALSE WHERE wm.state IN ('warming', 'released')`),
      db.query(`SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE clean = FALSE) AS listed, COUNT(*) FILTER (WHERE last_checked_at IS NULL) AS unchecked FROM warmnet_ips`),
      db.query(`SELECT COUNT(*) AS n FROM warmnet_domains`),
      db.query(`SELECT last_tick_at, last_tick_summary, last_seed_poll_at FROM warmnet_settings WHERE id = 1`),
      db.query(`SELECT COUNT(*) AS n FROM warmnet_messages WHERE direction = 'to_seed' AND replied_at IS NOT NULL AND sent_at >= NOW() - INTERVAL '7 days'`),
    ]);

    const stateCounts = Object.fromEntries(STATES.map((s) => [s, 0]));
    states.rows.forEach((r) => (stateCounts[r.state] = num(r.n)));
    const seedCounts = { active: 0, paused: 0, error: 0, activeCapacity: 0 };
    seeds.rows.forEach((r) => {
      seedCounts[r.status] = num(r.n);
      if (r.status === "active") seedCounts.activeCapacity = num(r.cap);
    });
    const demand = mbRows.rows.reduce((sum, r) => sum + engine.dailyTarget({ state: r.state, ramp_day: r.ramp_day }, settings, local), 0);
    const p = placement.rows[0];
    const inbox = num(p.inbox);
    const spam = num(p.spam);
    const warnings = [];
    if (!settings.enabled) warnings.push({ level: "info", text: "The warm-up engine is switched off. Nothing is being sent." });
    if (seedCounts.active === 0) warnings.push({ level: "error", text: "No active seed inboxes. Without seeds nothing can be warmed; add some under Seed inboxes." });
    if (seedCounts.error > 0) warnings.push({ level: "error", text: `${seedCounts.error} seed inbox(es) have a login problem. Open Seed inboxes to fix them.` });
    if (demand > seedCounts.activeCapacity && seedCounts.active > 0) {
      warnings.push({ level: "warn", text: `Today's planned volume (${demand}) is above seed capacity (${seedCounts.activeCapacity}). Add seeds or raise their caps, or some mailboxes will fall behind.` });
    }
    if (num(ips.rows[0].listed) > 0) warnings.push({ level: "error", text: `${num(ips.rows[0].listed)} sending IP(s) are on a blocklist. Their mailboxes are not sending.` });
    if (num(ips.rows[0].n) > 0 && num(ips.rows[0].unchecked) > 0) warnings.push({ level: "info", text: "Some IPs have never been checked against blocklists." });
    if (num(stateCounts.ready) > 0) warnings.push({ level: "success", text: `${stateCounts.ready} mailbox(es) met the readiness bar and are waiting to be released.` });

    return {
      enabled: settings.enabled,
      timezone: settings.timezone,
      mailboxes: stateCounts,
      mailboxTotal: Object.values(stateCounts).reduce((a, b) => a + b, 0),
      domains: num(domains.rows[0].n),
      seeds: seedCounts,
      today: { sent: num(today.rows[0].sent), failed: num(today.rows[0].failed), replies: num(today.rows[0].replies) },
      placement7d: {
        inbox,
        spam,
        unknown: num(p.unknown),
        rescued: num(p.rescued),
        inboxRate: rate(inbox, inbox + spam),
        replied: num(replies.rows[0].n),
      },
      capacity: { demand, seedCapacity: seedCounts.activeCapacity, shortBy: Math.max(0, demand - seedCounts.activeCapacity) },
      ips: { total: num(ips.rows[0].n), listed: num(ips.rows[0].listed), unchecked: num(ips.rows[0].unchecked) },
      engine: {
        lastTickAt: iso(tick.rows[0]?.last_tick_at),
        lastTickSummary: tick.rows[0]?.last_tick_summary || null,
        lastSeedPollAt: iso(tick.rows[0]?.last_seed_poll_at),
      },
      warnings,
    };
  }

  async trend(days = 14) {
    const d = Math.min(60, Math.max(3, parseInt(days, 10) || 14));
    const settings = await engine.getSettings();
    const { rows } = await db.query(
      `SELECT to_char((sent_at AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS day,
              COUNT(*) FILTER (WHERE direction = 'to_seed' AND status = 'sent') AS sent,
              COUNT(*) FILTER (WHERE direction = 'to_seed' AND placement = 'inbox') AS inbox,
              COUNT(*) FILTER (WHERE direction = 'to_seed' AND placement = 'spam') AS spam,
              COUNT(*) FILTER (WHERE direction = 'from_seed') AS replies
       FROM warmnet_messages WHERE sent_at >= NOW() - ($1::int * INTERVAL '1 day') GROUP BY 1 ORDER BY 1`,
      [d, settings.timezone]
    );
    return rows.map((r) => ({ day: r.day, sent: num(r.sent), inbox: num(r.inbox), spam: num(r.spam), replies: num(r.replies) }));
  }

  // ---------------- mailboxes ----------------
  async listMailboxes(q = {}) {
    const { limit, page, offset } = pageArgs(q);
    const settings = await engine.getSettings();
    const local = engine.localParts(settings.timezone);
    const where = [`m.is_deleted = FALSE`];
    const params = [];
    if (q.state && STATES.includes(q.state)) {
      params.push(q.state);
      where.push(`wm.state = $${params.length}`);
    }
    if (q.domainId) {
      params.push(parseInt(q.domainId, 10) || 0);
      where.push(`m.domain_id = $${params.length}`);
    }
    if (q.search) {
      params.push(`%${String(q.search).trim().toLowerCase()}%`);
      where.push(`(LOWER(m.email) LIKE $${params.length} OR LOWER(m.display_name) LIKE $${params.length})`);
    }
    const sql = `FROM warmnet_mailboxes wm
      JOIN mailboxes m ON m.id = wm.mailbox_id
      JOIN domains d ON d.id = m.domain_id
      LEFT JOIN warmnet_domains wd ON wd.domain_id = d.id
      LEFT JOIN warmnet_ips ip ON ip.id = wd.ip_id
      WHERE ${where.join(" AND ")}`;
    const { rows: count } = await db.query(`SELECT COUNT(*) AS n ${sql}`, params);
    params.push(limit, offset);
    const { rows } = await db.query(
      `SELECT wm.*, m.email, m.display_name, m.status AS mailbox_status, d.id AS domain_id, d.domain, ip.ip, ip.clean AS ip_clean,
         (SELECT COUNT(*) FILTER (WHERE x.placement = 'inbox') FROM warmnet_messages x WHERE x.mailbox_id = wm.mailbox_id AND x.direction = 'to_seed' AND x.sent_at >= NOW() - INTERVAL '7 days') AS inbox7,
         (SELECT COUNT(*) FILTER (WHERE x.placement = 'spam') FROM warmnet_messages x WHERE x.mailbox_id = wm.mailbox_id AND x.direction = 'to_seed' AND x.sent_at >= NOW() - INTERVAL '7 days') AS spam7,
         (SELECT COUNT(*) FROM warmnet_messages x WHERE x.mailbox_id = wm.mailbox_id AND x.direction = 'from_seed' AND x.sent_at >= NOW() - INTERVAL '7 days') AS replies7
       ${sql} ORDER BY wm.state = 'ready' DESC, wm.updated_at DESC, wm.mailbox_id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return {
      total: num(count[0].n),
      page,
      limit,
      items: rows.map((r) => ({
        mailboxId: r.mailbox_id,
        email: r.email,
        displayName: r.display_name,
        domainId: r.domain_id,
        domain: r.domain,
        ip: r.ip,
        ipClean: r.ip_clean,
        state: r.state,
        rampDay: r.ramp_day,
        heldDays: r.held_days,
        todayTarget: ["warming", "released"].includes(r.state) ? engine.dailyTarget(r, settings, local) : 0,
        todaySent: r.today_date && String(r.today_date).slice(0, 10) === local.date ? r.today_sent : 0,
        totalSent: r.total_sent,
        inbox7d: num(r.inbox7),
        spam7d: num(r.spam7),
        inboxRate7d: rate(num(r.inbox7), num(r.inbox7) + num(r.spam7)),
        replies7d: num(r.replies7),
        pauseReason: r.pause_reason,
        consecutiveFailures: r.consecutive_failures,
        startedAt: iso(r.started_at),
        readyAt: iso(r.ready_at),
        releasedAt: iso(r.released_at),
        lastSentAt: iso(r.last_sent_at),
        mailboxStatus: r.mailbox_status,
      })),
    };
  }

  /** start | pause | resume | reset | release for a list of mailboxes. Release hands them to the normal sending lane. */
  async mailboxAction(input = {}) {
    const ids = [...new Set((Array.isArray(input.ids) ? input.ids : []).map((n) => parseInt(n, 10)).filter((n) => n > 0))];
    if (!ids.length) throw new WorkspaceError("Select at least one mailbox.", 400);
    if (ids.length > 1000) throw new WorkspaceError("At most 1000 mailboxes at a time.", 400);
    const action = input.action;
    let affected = 0;
    if (action === "start" || action === "resume") {
      const { rowCount } = await db.query(
        `UPDATE warmnet_mailboxes SET state = 'warming', started_at = COALESCE(started_at, NOW()), pause_reason = NULL, consecutive_failures = 0, updated_at = NOW()
         WHERE mailbox_id = ANY($1::int[]) AND state IN ('queued', 'paused')`,
        [ids]
      );
      affected = rowCount;
    } else if (action === "pause") {
      const reason = String(input.reason || "Paused by an administrator.").slice(0, 300);
      const { rowCount } = await db.query(
        `UPDATE warmnet_mailboxes SET state = 'paused', pause_reason = $2, updated_at = NOW() WHERE mailbox_id = ANY($1::int[]) AND state IN ('warming', 'ready', 'released')`,
        [ids, reason]
      );
      affected = rowCount;
    } else if (action === "reset") {
      const { rowCount } = await db.query(
        `UPDATE warmnet_mailboxes SET state = 'queued', ramp_day = 1, held_days = 0, today_sent = 0, today_date = NULL, started_at = NULL, ready_at = NULL,
           released_at = NULL, pause_reason = NULL, consecutive_failures = 0, updated_at = NOW() WHERE mailbox_id = ANY($1::int[])`,
        [ids]
      );
      affected = rowCount;
    } else if (action === "release") {
      affected = await this.release(ids, input);
    } else {
      throw new WorkspaceError("Unknown action.", 400);
    }
    return { affected };
  }

  /**
   * Hands warmed mailboxes to the workspace: they become Active with the chosen warm-up strategy, so the normal sending
   * lane and campaigns can use them. Warm-up continues in the background at the low maintenance volume.
   */
  async release(ids, { strategyId, force } = {}) {
    const { rows } = await db.query(
      `SELECT wm.mailbox_id, wm.state, m.workspace_id FROM warmnet_mailboxes wm JOIN mailboxes m ON m.id = wm.mailbox_id AND m.is_deleted = FALSE WHERE wm.mailbox_id = ANY($1::int[])`,
      [ids]
    );
    const eligible = rows.filter((r) => r.state === "ready" || (force === true && ["warming", "paused"].includes(r.state)));
    if (!eligible.length) throw new WorkspaceError("Only mailboxes marked Ready can be released. Use force to release earlier ones.", 409);
    let affected = 0;
    for (const r of eligible) {
      let sid = strategyId ? parseInt(strategyId, 10) : null;
      if (!sid) {
        const { rows: s } = await db.query(`SELECT id FROM warmup_strategies WHERE workspace_id = $1 AND is_deleted = FALSE ORDER BY id LIMIT 1`, [r.workspace_id]);
        sid = s[0] ? s[0].id : null;
      } else {
        const { rows: ok } = await db.query(`SELECT id FROM warmup_strategies WHERE id = $1 AND workspace_id = $2 AND is_deleted = FALSE`, [sid, r.workspace_id]);
        if (!ok[0]) throw new WorkspaceError("That warm-up strategy does not belong to the mailbox's workspace.", 400);
      }
      if (!sid) throw new WorkspaceError("The workspace has no warm-up strategy yet. Create one first.", 409);
      await db.query(
        `UPDATE mailboxes SET status = 'Active', warmup_stage = 'New', warmup_strategy_id = $2, warmup_started_at = NOW(), reputation_status = 'Healthy', updated_at = NOW() WHERE id = $1`,
        [r.mailbox_id, sid]
      );
      await db.query(`UPDATE warmnet_mailboxes SET state = 'released', released_at = NOW(), pause_reason = NULL, updated_at = NOW() WHERE mailbox_id = $1`, [r.mailbox_id]);
      affected += 1;
    }
    return affected;
  }

  // ---------------- domains ----------------
  async listDomains() {
    const { rows } = await db.query(
      `SELECT d.id, d.domain, d.status, d.workspace_id, w.name AS workspace_name, ip.id AS ip_id, ip.ip, ip.pool_name, ip.clean AS ip_clean,
         COUNT(m.id) AS mailboxes,
         COUNT(*) FILTER (WHERE wm.state = 'queued') AS queued, COUNT(*) FILTER (WHERE wm.state = 'warming') AS warming,
         COUNT(*) FILTER (WHERE wm.state = 'paused') AS paused, COUNT(*) FILTER (WHERE wm.state = 'ready') AS ready,
         COUNT(*) FILTER (WHERE wm.state = 'released') AS released,
         COALESCE(SUM(wm.total_sent), 0) AS total_sent,
         (SELECT COUNT(*) FILTER (WHERE x.placement = 'inbox') FROM warmnet_messages x JOIN mailboxes xm ON xm.id = x.mailbox_id WHERE xm.domain_id = d.id AND x.direction = 'to_seed' AND x.sent_at >= NOW() - INTERVAL '7 days') AS inbox7,
         (SELECT COUNT(*) FILTER (WHERE x.placement = 'spam') FROM warmnet_messages x JOIN mailboxes xm ON xm.id = x.mailbox_id WHERE xm.domain_id = d.id AND x.direction = 'to_seed' AND x.sent_at >= NOW() - INTERVAL '7 days') AS spam7
       FROM warmnet_domains wd
       JOIN domains d ON d.id = wd.domain_id AND d.is_deleted = FALSE
       LEFT JOIN workspaces w ON w.id = d.workspace_id
       LEFT JOIN warmnet_ips ip ON ip.id = wd.ip_id
       LEFT JOIN mailboxes m ON m.domain_id = d.id AND m.is_deleted = FALSE
       LEFT JOIN warmnet_mailboxes wm ON wm.mailbox_id = m.id
       GROUP BY d.id, w.name, ip.id ORDER BY d.id`
    );
    return rows.map((r) => ({
      id: r.id,
      domain: r.domain,
      status: r.status,
      workspaceId: r.workspace_id,
      workspaceName: r.workspace_name,
      ipId: r.ip_id,
      ip: r.ip,
      poolName: r.pool_name,
      ipClean: r.ip_clean,
      mailboxes: num(r.mailboxes),
      states: { queued: num(r.queued), warming: num(r.warming), paused: num(r.paused), ready: num(r.ready), released: num(r.released) },
      totalSent: num(r.total_sent),
      inbox7d: num(r.inbox7),
      spam7d: num(r.spam7),
      inboxRate7d: rate(num(r.inbox7), num(r.inbox7) + num(r.spam7)),
    }));
  }

  /**
   * Registers domains already set up in Postal (DNS verified there) with the app: a `domains` row (Postal, Verified),
   * the sending IP link, and N mailboxes with American names. Mailboxes are created Paused and out of the old
   * warm-up lane, enrolled in the warm-up network as "queued" (or "warming" with autoStart).
   */
  async registerDomains(actorId, input = {}) {
    const list = Array.isArray(input.domains) ? input.domains : [];
    if (!list.length) throw new WorkspaceError("Provide at least one domain.", 400);
    if (list.length > 150) throw new WorkspaceError("At most 150 domains at a time.", 400);
    const perDomain = input.mailboxesPerDomain === 0 ? 0 : Math.min(10, Math.max(1, parseInt(input.mailboxesPerDomain, 10) || 5));
    let workspaceId = parseInt(input.workspaceId, 10) || null;
    if (!workspaceId) {
      const { rows } = await db.query(`SELECT id FROM workspaces WHERE slug = $1 AND is_deleted = FALSE`, [PLATFORM_SLUG]);
      workspaceId = rows[0]?.id;
    }
    const ws = workspaceId ? await db.query(`SELECT id FROM workspaces WHERE id = $1 AND is_deleted = FALSE`, [workspaceId]) : { rows: [] };
    if (!ws.rows[0]) throw new WorkspaceError("That workspace could not be found.", 404);

    const used = new Set();
    const { rows: existingNames } = await db.query(`SELECT display_name FROM mailboxes WHERE workspace_id = $1 AND display_name IS NOT NULL`, [workspaceId]);
    existingNames.forEach((r) => used.add(r.display_name));

    // Check each domain's real DNS first (a few at a time). A domain whose DNS isn't ready yet is still registered, as
    // Pending Verification, and starts warming once a re-check finds the records.
    const postalDns = require("./postalDns.service");
    const dnsByName = new Map();
    const names = [...new Set(list.map((e) => String((typeof e === "string" ? e : e?.domain) || "").trim().toLowerCase()).filter((n) => DOMAIN_RE.test(n)))];
    for (let i = 0; i < names.length; i += 10) {
      await Promise.all(names.slice(i, i + 10).map(async (n) => {
        const entry = list.find((e) => String((typeof e === "string" ? e : e?.domain) || "").trim().toLowerCase() === n);
        const selector = typeof entry === "object" && entry?.dkimSelector ? String(entry.dkimSelector).trim().toLowerCase() : null;
        dnsByName.set(n, { selector, ...(await postalDns.check(n, { dkimSelector: selector }).catch(() => ({ unreliable: true, statuses: {} }))) });
      }));
    }

    const results = [];
    for (const entry of list) {
      const item = typeof entry === "string" ? { domain: entry } : entry || {};
      const name = String(item.domain || "").trim().toLowerCase();
      if (!DOMAIN_RE.test(name)) {
        results.push({ domain: name || String(item.domain), ok: false, error: "Not a valid domain name." });
        continue;
      }
      const client = await db.getClient();
      try {
        await client.query("BEGIN");
        const exists = await client.query(`SELECT id FROM domains WHERE domain = $1`, [name]);
        if (exists.rows[0]) throw new WorkspaceError("This domain is already in the system.", 409);

        const dnsResult = dnsByName.get(name);
        const dbStatus = (v) => (!v || v === "Unknown" ? "Pending" : v);
        const dnsStatus = dnsResult && !dnsResult.unreliable
          ? { overall: postalDns.overall(dnsResult.statuses) === "Failed" ? "Pending Verification" : postalDns.overall(dnsResult.statuses), mx: dbStatus(dnsResult.statuses.mx), spf: dbStatus(dnsResult.statuses.spf), dmarc: dbStatus(dnsResult.statuses.dmarc), dkim: dbStatus(dnsResult.statuses.dkim), note: postalDns.overall(dnsResult.statuses) === "Verified" ? null : "DNS isn't ready yet: MX and SPF must point at the mail server. Check the DNS records, then re-check." }
          : { overall: "Pending Verification", mx: "Pending", spf: "Pending", dmarc: "Pending", dkim: "Pending", note: "DNS couldn't be checked yet. Re-check shortly." };

        let ipId = null;
        const ipText = String(item.ip || "").trim();
        if (ipText) {
          const ip = await client.query(
            `INSERT INTO warmnet_ips (ip, hostname, pool_name) VALUES ($1, $2, $3)
             ON CONFLICT (ip) DO UPDATE SET pool_name = COALESCE(EXCLUDED.pool_name, warmnet_ips.pool_name) RETURNING id`,
            [ipText, String(item.hostname || "").trim() || null, String(item.pool || "").trim() || null]
          );
          ipId = ip.rows[0].id;
        }
        const dom = await client.query(
          `INSERT INTO domains (domain, registrar, dns_provider, provider, status, spf_status, dkim_status, dmarc_status, mx_status, created_by, workspace_id, dkim_selector, last_checked_at, last_error)
           VALUES ($1, 'Porkbun', 'Porkbun', 'Postal', $4, $5, $6, $7, $8, $2, $3, $9, NOW(), $10) RETURNING id`,
          [name, actorId || null, workspaceId, dnsStatus.overall, dnsStatus.spf, dnsStatus.dkim, dnsStatus.dmarc, dnsStatus.mx, dnsByName.get(name)?.selector || null, dnsStatus.note]
        );
        const domainId = dom.rows[0].id;
        await client.query(`INSERT INTO warmnet_domains (domain_id, ip_id) VALUES ($1, $2)`, [domainId, ipId]);

        const people = generatePeople(perDomain, used);
        let created = 0;
        for (const person of people) {
          const email = `${person.localPart}@${name}`;
          const mb = await client.query(
            `INSERT INTO mailboxes (domain_id, email, local_part, display_name, status, daily_limit, warmup_stage, provider, created_by, workspace_id, market_daily_limit)
             VALUES ($1, $2, $3, $4, 'Paused', 0, 'Paused', 'postal', $5, $6, 0) RETURNING id`,
            [domainId, email, person.localPart, person.displayName, actorId || null, workspaceId]
          );
          await client.query(
            `INSERT INTO warmnet_mailboxes (mailbox_id, state, started_at) VALUES ($1, $2, $3)`,
            [mb.rows[0].id, input.autoStart ? "warming" : "queued", input.autoStart ? new Date() : null]
          );
          created += 1;
        }
        await client.query("COMMIT");
        results.push({ domain: name, ok: true, domainId, mailboxes: created });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        results.push({ domain: name, ok: false, error: error instanceof WorkspaceError ? error.message : "Could not register this domain." });
        if (!(error instanceof WorkspaceError)) console.error("warmnet registerDomains:", error);
      } finally {
        client.release();
      }
    }
    return { workspaceId, perDomain, registered: results.filter((r) => r.ok).length, results };
  }

  /**
   * Adds inboxes to a domain that is already registered (Postal domain in the warm-up network). Same shape as registration:
   * Paused, outside the old warm-up lane, enrolled as "queued" (or "warming" with autoStart), American names that are unique
   * across the workspace. A domain holds at most 10 inboxes.
   */
  async addMailboxes(actorId, input = {}) {
    const domainId = parseInt(input.domainId, 10);
    const count = parseInt(input.count, 10);
    if (!Number.isInteger(domainId) || domainId < 1) throw new WorkspaceError("That domain could not be found.", 404);
    if (!Number.isInteger(count) || count < 1 || count > 10) throw new WorkspaceError("Choose between 1 and 10 inboxes to add.", 400);

    const client = await db.getClient();
    try {
      await client.query("BEGIN");
      const { rows: found } = await client.query(
        `SELECT d.id, d.domain, d.provider, d.workspace_id FROM domains d JOIN warmnet_domains wd ON wd.domain_id = d.id
          WHERE d.id = $1 AND d.is_deleted = FALSE FOR UPDATE OF d`,
        [domainId]
      );
      const dom = found[0];
      if (!dom) throw new WorkspaceError("That domain isn't in the warm-up network.", 404);
      if (dom.provider !== "Postal") throw new WorkspaceError("Inboxes can only be added to domains on our own mail server.", 409);

      const { rows: have } = await client.query(`SELECT email FROM mailboxes WHERE domain_id = $1 AND is_deleted = FALSE`, [domainId]);
      if (have.length + count > 10) throw new WorkspaceError(`A domain holds at most 10 inboxes; ${dom.domain} already has ${have.length}.`, 409);

      const used = new Set();
      const { rows: names } = await client.query(`SELECT display_name FROM mailboxes WHERE workspace_id = $1 AND display_name IS NOT NULL`, [dom.workspace_id]);
      names.forEach((r) => used.add(r.display_name));
      const taken = new Set(have.map((r) => r.email.toLowerCase()));

      const created = [];
      for (const person of generatePeople(count, used)) {
        const email = `${person.localPart}@${dom.domain}`;
        if (taken.has(email.toLowerCase())) continue;
        const mb = await client.query(
          `INSERT INTO mailboxes (domain_id, email, local_part, display_name, status, daily_limit, warmup_stage, provider, created_by, workspace_id, market_daily_limit)
           VALUES ($1, $2, $3, $4, 'Paused', 0, 'Paused', 'postal', $5, $6, 0) RETURNING id`,
          [domainId, email, person.localPart, person.displayName, actorId || null, dom.workspace_id]
        );
        await client.query(
          `INSERT INTO warmnet_mailboxes (mailbox_id, state, started_at) VALUES ($1, $2, $3)`,
          [mb.rows[0].id, input.autoStart ? "warming" : "queued", input.autoStart ? new Date() : null]
        );
        created.push({ id: mb.rows[0].id, email, displayName: person.displayName });
      }
      await client.query("COMMIT");
      return { domainId, domain: dom.domain, created: created.length, mailboxes: created, total: have.length + created.length };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // ---------------- activity ----------------
  async listMessages(q = {}) {
    const { limit, page, offset } = pageArgs(q);
    const where = [`TRUE`];
    const params = [];
    const add = (cond, val) => {
      params.push(val);
      where.push(cond.replace("?", `$${params.length}`));
    };
    if (["inbox", "spam", "unknown", "other"].includes(q.placement)) add("x.placement = ?", q.placement);
    if (["to_seed", "from_seed"].includes(q.direction)) add("x.direction = ?", q.direction);
    if (q.status === "failed") add("x.status = ?", "failed");
    if (q.mailboxId) add("x.mailbox_id = ?", parseInt(q.mailboxId, 10) || 0);
    if (q.seedId) add("x.seed_id = ?", parseInt(q.seedId, 10) || 0);
    const { rows: count } = await db.query(`SELECT COUNT(*) AS n FROM warmnet_messages x WHERE ${where.join(" AND ")}`, params);
    params.push(limit, offset);
    const { rows } = await db.query(
      `SELECT x.*, m.email AS mailbox_email, s.email AS seed_email
       FROM warmnet_messages x JOIN mailboxes m ON m.id = x.mailbox_id JOIN warmnet_seeds s ON s.id = x.seed_id
       WHERE ${where.join(" AND ")} ORDER BY x.sent_at DESC, x.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return {
      total: num(count[0].n),
      page,
      limit,
      items: rows.map((r) => ({
        id: Number(r.id),
        mailboxEmail: r.mailbox_email,
        seedEmail: r.seed_email,
        direction: r.direction,
        kind: r.kind,
        subject: r.subject,
        status: r.status,
        placement: r.placement,
        rescued: r.rescued,
        seedReadAt: iso(r.seed_read_at),
        repliedAt: iso(r.replied_at),
        error: r.error,
        sentAt: iso(r.sent_at),
      })),
    };
  }

  // ---------------- seeds + ips (thin pass-through) ----------------
  listSeeds() { return seedService.list(); }
  createSeed(input) { return seedService.create(input); }
  updateSeed(id, input) { return seedService.update(id, input); }
  removeSeed(id) { return seedService.remove(id); }
  testSeed(id) { return seedService.test(id); }
  seedPresets() { return seedService.presets(); }
  listIps() { return ipService.list(); }
  addIp(input) { return ipService.add(input); }
  removeIp(id) { return ipService.remove(id); }
  checkIp(id) { return ipService.check(id); }
  checkAllIps() { return ipService.checkAll(); }
  runTick(force) { return engine.runTick({ force: force === true }); }
  pollSeeds() { return engine.getSettings().then((s) => seedService.pollAll(s)); }
}

module.exports = new WarmnetService();
