const db = require("../config/db.config");
const warmnet = require("./warmnet.service");

const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const MAX_ROWS = 5000;
const BULK_CHUNK = 150;
const BULK_MAX = 500;

/**
 * Health score, 0-100, with the reasons behind it so the number is never a mystery. It only uses signals we really
 * record: the inbox's own status and reputation, its domain's authentication and bounce/complaint rates, and the
 * warm-up network's pause reason and failure streak. A missing signal costs nothing, it is never guessed.
 */
function healthOf(row) {
  const reasons = [];
  let score = 100;
  const take = (points, reason) => {
    score -= points;
    reasons.push(`${reason} (−${points})`);
  };

  if (row.status === "Error") take(50, "The inbox is in an error state");
  if (row.reputation_status === "At Risk") take(30, "Reputation is at risk");
  else if (row.reputation_status === "Watch") take(12, "Reputation needs watching");

  const bounce = row.domain_bounce_rate === null || row.domain_bounce_rate === undefined ? null : Number(row.domain_bounce_rate);
  if (bounce !== null) {
    if (bounce >= 5) take(35, `Domain bounce rate is ${bounce}%`);
    else if (bounce >= 2) take(20, `Domain bounce rate is ${bounce}%`);
    else if (bounce >= 1) take(8, `Domain bounce rate is ${bounce}%`);
  }
  const complaint = row.domain_complaint_rate === null || row.domain_complaint_rate === undefined ? null : Number(row.domain_complaint_rate);
  if (complaint !== null) {
    if (complaint >= 0.3) take(35, `Domain complaint rate is ${complaint}%`);
    else if (complaint >= 0.1) take(15, `Domain complaint rate is ${complaint}%`);
  }

  if (row.domain_status && row.domain_status !== "Verified") take(30, `The domain is ${String(row.domain_status).toLowerCase()}`);
  for (const [label, value] of [["SPF", row.spf_status], ["DKIM", row.dkim_status], ["DMARC", row.dmarc_status]]) {
    if (value && value !== "Success") take(10, `${label} is not passing`);
  }

  if (row.wn_pause_reason) take(15, "Warm-up is paused");
  if ((row.wn_consecutive_failures || 0) >= 3) take(15, "Warm-up sends keep failing");

  score = Math.max(0, Math.min(100, score));
  return { score, reasons, label: score >= 90 ? "Excellent" : score >= 75 ? "Good" : score >= 50 ? "Fair" : "Poor" };
}

/** What kind of account this is, for the badge: where it comes from and whether it has finished warming. */
function typeOf(row) {
  const provider = String(row.provider || "").toLowerCase();
  const state = row.wn_state;
  if (provider === "postal" || state) {
    if (state === "ready" || state === "released") return { kind: "warmed", label: "Warmed", source: "Own server" };
    if (state === "warming") return { kind: "warming", label: "Warming up", source: "Own server" };
    if (state === "queued") return { kind: "queued", label: "Queued for warm-up", source: "Own server" };
    if (state === "paused") return { kind: "paused", label: "Warm-up paused", source: "Own server" };
    return { kind: "external", label: "Own server", source: "Own server" };
  }
  if (provider === "maildoso") return { kind: "prewarmed", label: "Pre-warmed", source: "Maildoso" };
  return { kind: "external", label: row.provider || "SES", source: row.provider || "SES" };
}

function mapInbox(row) {
  const health = healthOf(row);
  return {
    id: row.id,
    name: row.display_name || row.local_part,
    email: row.email,
    domain: row.domain_name,
    status: row.status,
    sentToday: row.sent_today || 0,
    dailyLimit: row.daily_limit || 0,
    warmupSent: Number(row.wn_total_sent || 0),
    warmupStage: row.warmup_stage,
    warmupState: row.wn_state || null,
    warmupDay: row.wn_ramp_day ?? null,
    health,
    accountType: typeOf(row),
    lastSentAt: row.last_sent_at,
    createdAt: row.created_at,
  };
}

const INBOX_SELECT = `
  SELECT m.id, m.email, m.local_part, m.display_name, m.status, m.daily_limit, m.sent_today, m.warmup_stage, m.reputation_status,
         m.provider, m.last_sent_at, m.created_at,
         d.domain AS domain_name, d.status AS domain_status, d.bounce_rate AS domain_bounce_rate, d.complaint_rate AS domain_complaint_rate,
         d.spf_status, d.dkim_status, d.dmarc_status,
         w.state AS wn_state, w.total_sent AS wn_total_sent, w.ramp_day AS wn_ramp_day, w.pause_reason AS wn_pause_reason, w.consecutive_failures AS wn_consecutive_failures
  FROM mailboxes m
  JOIN domains d ON d.id = m.domain_id AND d.workspace_id = m.workspace_id
  LEFT JOIN warmnet_mailboxes w ON w.mailbox_id = m.id
  WHERE m.workspace_id = $1 AND m.is_deleted = FALSE`;

const SORTS = {
  name: (a) => String(a.name).toLowerCase(),
  email: (a) => a.email,
  sent: (a) => a.sentToday,
  warmup: (a) => a.warmupSent,
  health: (a) => a.health.score,
  status: (a) => a.status,
  created: (a) => new Date(a.createdAt).getTime(),
};

class EmailAccountsService {
  /**
   * Every inbox in the workspace with its health and type. Health depends on several joined tables, so the whole
   * workspace is read once (a few thousand rows at most) and filtered, sorted and paged here, which keeps the score
   * and the sort order from ever disagreeing.
   */
  async listInboxes(workspaceId, { search = "", status = "", type = "", health = "", sort = "created", dir = "desc", page = 1, limit = 50 } = {}) {
    const pageNum = Math.max(1, Number.parseInt(page, 10) || 1);
    const limitNum = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    if (status && !["Active", "Paused", "Error"].includes(status)) throw bad("Unknown status.");
    if (health && !["attention", "healthy"].includes(health)) throw bad("Unknown health filter.");
    if (!(sort in SORTS)) throw bad("Unknown sort.");

    const { rows } = await db.query(`${INBOX_SELECT} ORDER BY m.created_at DESC LIMIT ${MAX_ROWS}`, [workspaceId]);
    const all = rows.map(mapInbox);

    const needle = String(search || "").trim().toLowerCase();
    let items = all.filter((inbox) => (!needle || inbox.email.toLowerCase().includes(needle) || String(inbox.name).toLowerCase().includes(needle))
      && (!status || inbox.status === status)
      && (!type || inbox.accountType.kind === type)
      && (!health || (health === "attention" ? inbox.health.score < 75 : inbox.health.score >= 75)));

    const key = SORTS[sort];
    const sign = dir === "asc" ? 1 : -1;
    items = items.slice().sort((a, b) => {
      const av = key(a);
      const bv = key(b);
      return (av < bv ? -1 : av > bv ? 1 : 0) * sign || a.id - b.id;
    });

    const summary = {
      total: all.length,
      active: all.filter((i) => i.status === "Active").length,
      paused: all.filter((i) => i.status === "Paused").length,
      error: all.filter((i) => i.status === "Error").length,
      warming: all.filter((i) => ["warming", "queued"].includes(i.accountType.kind)).length,
      needAttention: all.filter((i) => i.health.score < 75).length,
      averageHealth: all.length ? Math.round(all.reduce((sum, i) => sum + i.health.score, 0) / all.length) : null,
    };
    return { items: items.slice((pageNum - 1) * limitNum, pageNum * limitNum), page: pageNum, limit: limitNum, total: items.length, totalPages: Math.max(1, Math.ceil(items.length / limitNum)), summary };
  }

  /** Pause or resume an inbox, or rename it. Daily limits belong to the warm-up ramp, so they are not editable here. */
  async updateInbox(workspaceId, id, input = {}) {
    const inboxId = Number(id);
    if (!Number.isInteger(inboxId) || inboxId <= 0) throw bad("Inbox not found.", 404);
    const { rows } = await db.query(`${INBOX_SELECT} AND m.id = $2`, [workspaceId, inboxId]);
    const row = rows[0];
    if (!row) throw bad("Inbox not found.", 404);

    const sets = [];
    const values = [inboxId, workspaceId];
    if (input.status !== undefined) {
      if (!["Active", "Paused"].includes(input.status)) throw bad("An inbox can only be set to Active or Paused.");
      if (input.status === "Active") {
        if (row.status === "Error") throw bad("This inbox is in an error state. Fix the problem before resuming it.", 409);
        if (row.domain_status && row.domain_status !== "Verified") throw bad("Its domain is not verified yet, so this inbox can't send.", 409);
        // Own-server inboxes are switched on by the warm-up engine as they finish ramping; resuming one by hand would skip the ramp.
        if (["queued", "warming"].includes(row.wn_state)) throw bad("This inbox is still warming up. It starts sending campaigns automatically once it is ready.", 409);
      }
      values.push(input.status);
      sets.push(`status = $${values.length}`);
    }
    if (input.displayName !== undefined) {
      const name = String(input.displayName || "").trim().slice(0, 120);
      if (!name) throw bad("Give the inbox a name.");
      values.push(name);
      sets.push(`display_name = $${values.length}`);
    }
    if (sets.length === 0) throw bad("Nothing to change.");
    await db.query(`UPDATE mailboxes SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $1 AND workspace_id = $2`, values);
    const { rows: after } = await db.query(`${INBOX_SELECT} AND m.id = $2`, [workspaceId, inboxId]);
    return mapInbox(after[0]);
  }

  /** Domains with their authentication, reputation and how many inboxes each carries. */
  async listDomains(workspaceId, { search = "", status = "", page = 1, limit = 50 } = {}) {
    const pageNum = Math.max(1, Number.parseInt(page, 10) || 1);
    const limitNum = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    const params = [workspaceId];
    const where = ["d.workspace_id = $1", "COALESCE(d.is_deleted, FALSE) = FALSE"];
    const term = String(search || "").trim().slice(0, 200);
    if (term) {
      params.push(`%${term.replace(/[%_\\]/g, "\\$&")}%`);
      where.push(`d.domain ILIKE $${params.length}`);
    }
    if (status) {
      params.push(status);
      where.push(`d.status = $${params.length}`);
    }
    const whereSql = where.join(" AND ");
    const [items, count] = await Promise.all([
      db.query(
        `SELECT d.id, d.domain, d.provider, d.status, d.spf_status, d.dkim_status, d.dmarc_status, d.mx_status, d.bounce_rate, d.complaint_rate, d.created_at, d.reputation, d.last_checked_at, d.last_error,
                COUNT(m.id) FILTER (WHERE m.is_deleted = FALSE)::int AS inboxes,
                COUNT(m.id) FILTER (WHERE m.is_deleted = FALSE AND m.status = 'Active')::int AS active_inboxes,
                COUNT(w.mailbox_id) FILTER (WHERE m.is_deleted = FALSE AND w.state IN ('queued', 'warming'))::int AS warming_inboxes
         FROM domains d
         LEFT JOIN mailboxes m ON m.domain_id = d.id AND m.workspace_id = d.workspace_id
         LEFT JOIN warmnet_mailboxes w ON w.mailbox_id = m.id
         WHERE ${whereSql}
         GROUP BY d.id ORDER BY d.created_at DESC, d.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limitNum, (pageNum - 1) * limitNum]
      ),
      db.query(`SELECT COUNT(*)::int AS count FROM domains d WHERE ${whereSql}`, params),
    ]);
    return {
      items: items.rows.map((row) => ({
        id: row.id,
        domain: row.domain,
        provider: row.provider,
        status: row.status,
        spf: row.spf_status,
        dkim: row.dkim_status,
        dmarc: row.dmarc_status,
        mx: row.mx_status,
        reputation: row.reputation || null,
        lastCheckedAt: row.last_checked_at,
        lastError: row.last_error || null,
        bounceRate: row.bounce_rate === null ? null : Number(row.bounce_rate),
        complaintRate: row.complaint_rate === null ? null : Number(row.complaint_rate),
        inboxes: row.inboxes,
        activeInboxes: row.active_inboxes,
        warmingInboxes: row.warming_inboxes,
        createdAt: row.created_at,
      })),
      page: pageNum,
      limit: limitNum,
      total: count.rows[0].count,
      totalPages: Math.max(1, Math.ceil(count.rows[0].count / limitNum)),
    };
  }

  async ownedDomain(workspaceId, id) {
    const { rows } = await db.query(`SELECT * FROM domains WHERE id = $1 AND workspace_id = $2 AND COALESCE(is_deleted, FALSE) = FALSE`, [Number(id) || 0, workspaceId]);
    if (!rows[0]) throw bad("Domain not found.", 404);
    return rows[0];
  }

  /** What DNS the domain needs and how it looks right now. Only own-server (Postal) domains have records we manage. */
  async domainDns(workspaceId, id) {
    const d = await this.ownedDomain(workspaceId, id);
    if (d.provider !== "Postal") {
      return { managed: false, provider: d.provider, domain: d.domain, records: [], note: d.provider === "Maildoso" ? "This domain's DNS is managed at Maildoso. Use Sync Maildoso to refresh it." : "This domain's DNS is checked through its sending provider." };
    }
    const postalDns = require("./postalDns.service");
    const porkbun = require("./porkbun.service");
    const live = await postalDns.check(d.domain, { dkimSelector: d.dkim_selector });
    const records = postalDns.expectedRecords(d.domain, { dkimSelector: d.dkim_selector }).map((r) => ({ ...r, status: live.statuses[r.key] || "Not started" }));
    return { managed: true, provider: d.provider, domain: d.domain, dkimSelector: d.dkim_selector || null, records, unreliable: live.unreliable, canAutoApply: porkbun.configured() && d.registrar === "Porkbun", registrar: d.registrar };
  }

  /** Super admin: set the DKIM selector Postal generated for this domain so DKIM can be verified. */
  async setDkimSelector(workspaceId, id, selector) {
    const d = await this.ownedDomain(workspaceId, id);
    if (d.provider !== "Postal") throw bad("Only domains on the own mail server have a DKIM selector.");
    const value = String(selector ?? "").trim().toLowerCase();
    if (value && !/^[a-z0-9][a-z0-9._-]{0,100}$/.test(value)) throw bad("A DKIM selector uses letters, numbers, dots, dashes and underscores, like postal-abc123.");
    await db.query(`UPDATE domains SET dkim_selector = $2, updated_at = NOW() WHERE id = $1`, [d.id, value || null]);
    return this.domainDns(workspaceId, id);
  }

  /** Super admin: add the missing records at Porkbun. Never edits or deletes; conflicts are reported for a person to resolve. */
  async applyDns(workspaceId, id) {
    const d = await this.ownedDomain(workspaceId, id);
    if (d.provider !== "Postal") throw bad("Only domains on the own mail server can be set up here.");
    const porkbun = require("./porkbun.service");
    if (!porkbun.configured()) throw bad("Porkbun isn't configured on this server, so add the records by hand.", 503);
    if (d.registrar !== "Porkbun") throw bad(`This domain is registered at ${d.registrar || "another registrar"}, not Porkbun. Add the records by hand.`);
    const postalDns = require("./postalDns.service");
    const wanted = postalDns.expectedRecords(d.domain, { dkimSelector: d.dkim_selector }).filter((r) => !r.manual);
    const result = await porkbun.applyRecords(d.domain, wanted);
    return { ...result, dns: await this.domainDns(workspaceId, id) };
  }

  /**
   * Super admin only: register up to 500 domains (each with generated inboxes, queued for warm-up) in a workspace. The
   * warm-up network registers at most 150 at a time, so the list is sent in chunks and one bad domain never stops the rest.
   */
  async bulkRegisterDomains(actorId, { domains, mailboxesPerDomain, workspaceId, autoStart = false } = {}) {
    const list = Array.isArray(domains) ? domains : [];
    const cleaned = [...new Set(list.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))];
    if (cleaned.length === 0) throw bad("Paste at least one domain.");
    if (cleaned.length > BULK_MAX) throw bad(`Add at most ${BULK_MAX} domains at a time.`);

    const results = [];
    for (let start = 0; start < cleaned.length; start += BULK_CHUNK) {
      const chunk = cleaned.slice(start, start + BULK_CHUNK);
      try {
        const out = await warmnet.registerDomains(actorId, { domains: chunk, mailboxesPerDomain, workspaceId, autoStart });
        results.push(...out.results);
      } catch (error) {
        // A workspace-level problem (e.g. unknown workspace) applies to the whole chunk.
        results.push(...chunk.map((domain) => ({ domain, ok: false, error: error.message || "Could not register this domain." })));
      }
    }
    return {
      requested: cleaned.length,
      registered: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      inboxesCreated: results.reduce((sum, r) => sum + (r.mailboxes || 0), 0),
      results,
    };
  }
}

module.exports = new EmailAccountsService();
module.exports.healthOf = healthOf;
module.exports.typeOf = typeOf;
