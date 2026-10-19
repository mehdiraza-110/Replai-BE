const db = require("../config/db.config");

// Plans, trials and limits. `limits` on a workspace is enforced whenever a key is present (missing key or null limit =
// unlimited), regardless of plan. period "day" = rolling 24h of workspace_usage_events; "total" = a plain cap on what
// exists (domains/mailboxes/workflows count non-deleted rows; ai_requests/emails count all recorded usage).
const TRIAL_DAYS = 30;
const TRIAL_DEFAULTS = {
  domains: { limit: 10, period: "total" },
  mailboxes: { limit: 20, period: "total" },
  emails: { limit: 1000, period: "day" },
  workflows: { limit: 5, period: "total" },
};
const KINDS = ["domains", "mailboxes", "emails", "workflows", "ai_requests"];
const USAGE_KINDS = ["ai_requests", "domains", "mailboxes", "emails"]; // kinds stored in workspace_usage_events
const PERIODS = ["day", "total"];
const LABELS = { ai_requests: "AI requests", domains: "Domains", mailboxes: "Mailboxes", emails: "Emails sent", workflows: "Workflows" };
const NOUNS = { ai_requests: "AI requests", domains: "domains", mailboxes: "mailboxes", emails: "emails", workflows: "workflows" };
const ROW_TABLES = { domains: "domains", mailboxes: "mailboxes", workflows: "workflows" };
const WINDOW = "24 hours";
const LOCK_NS = 7002;

class QuotaError extends Error {
  constructor(message, data) {
    super(message);
    this.name = "QuotaError";
    this.status = 403;
    this.statusCode = 403;
    this.code = "TRIAL_LIMIT_REACHED";
    this.data = data;
  }
}

// Body every controller sends for a quota error.
function errorBody(error) {
  return { success: false, code: error.code, message: error.message, data: error.data || null };
}
const isQuotaError = (e) => Boolean(e) && e.code === "TRIAL_LIMIT_REACHED" && e.name === "QuotaError";

// SQL fragment selecting the plan columns of workspaces aliased `a` (timestamps normalised to timestamptz and the
// expiry maths done by the database so server/DB timezone differences cannot skew it).
const planColumns = (a = "w") => `${a}.plan, ${a}.trial_started_at::timestamptz AS trial_started_at, ${a}.trial_ends_at::timestamptz AS trial_ends_at,
  (${a}.trial_ends_at IS NOT NULL AND ${a}.trial_ends_at < NOW()) AS trial_expired,
  EXTRACT(EPOCH FROM (${a}.trial_ends_at - NOW()))::float8 AS trial_secs_left, ${a}.limits`;

function normalizeLimit(raw) {
  if (!raw || typeof raw !== "object") return null;
  const limit = raw.limit;
  if (limit === null || limit === undefined || typeof limit !== "number" || !Number.isFinite(limit) || limit < 0) return null;
  return { limit: Math.floor(limit), period: raw.period === "day" ? "day" : "total" };
}

function limitFor(limits, kind) {
  if (!limits || typeof limits !== "object") return null;
  return normalizeLimit(limits[kind]);
}

// Light plan object from a workspace row selected with planColumns().
function lightPlan(row) {
  const trial = row.plan === "trial";
  const ended = trial && row.trial_expired === true;
  return {
    type: row.plan === "trial" ? "trial" : "standard",
    trial_ends_at: trial ? row.trial_ends_at || null : null,
    days_left: trial && row.trial_ends_at ? Math.max(0, Math.ceil(Number(row.trial_secs_left) / 86400)) : null,
    ended,
  };
}

const RAW_PLAN_KEYS = ["plan", "trial_started_at", "trial_ends_at", "trial_expired", "trial_secs_left", "limits"];
// Row -> same row minus the raw plan columns, plus `plan` (light).
function withLightPlan(row) {
  const out = { ...row, plan: lightPlan(row) };
  for (const k of RAW_PLAN_KEYS) if (k !== "plan") delete out[k];
  return out;
}

async function loadLimits(workspaceId, client) {
  const { rows } = await (client || db).query(`SELECT limits FROM workspaces WHERE id = $1`, [workspaceId]);
  return rows[0] ? rows[0].limits || {} : {};
}

async function usedNow(workspaceId, kind, period, client) {
  const q = client || db;
  if (period === "total" && ROW_TABLES[kind]) {
    const { rows } = await q.query(
      `SELECT COUNT(*)::int AS n FROM ${ROW_TABLES[kind]} WHERE workspace_id = $1 AND COALESCE(is_deleted, FALSE) = FALSE`,
      [workspaceId],
    );
    return rows[0].n;
  }
  if (period === "total") {
    const { rows } = await q.query(`SELECT COALESCE(SUM(quantity), 0)::int AS n FROM workspace_usage_events WHERE workspace_id = $1 AND kind = $2`, [workspaceId, kind]);
    return rows[0].n;
  }
  const { rows } = await q.query(
    `SELECT COALESCE(SUM(quantity), 0)::int AS n FROM workspace_usage_events
     WHERE workspace_id = $1 AND kind = $2 AND created_at > NOW() - INTERVAL '${WINDOW}'`,
    [workspaceId, kind],
  );
  return rows[0].n;
}

function humanWait(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

// When will `quantity` more fit in a rolling window? null when it never will by waiting (batch bigger than the limit).
async function windowResetsAt(workspaceId, kind, limit, used, quantity, client) {
  if (quantity > limit) return null;
  const need = used + quantity - limit;
  const { rows } = await (client || db).query(
    `SELECT quantity, created_at::timestamptz + INTERVAL '${WINDOW}' AS frees_at FROM workspace_usage_events
     WHERE workspace_id = $1 AND kind = $2 AND created_at > NOW() - INTERVAL '${WINDOW}' ORDER BY created_at ASC, id ASC`,
    [workspaceId, kind],
  );
  let freed = 0;
  for (const r of rows) {
    freed += r.quantity;
    if (freed >= need) return r.frees_at;
  }
  return null;
}

async function buildError(workspaceId, kind, lim, used, quantity, client) {
  const noun = NOUNS[kind];
  let resetsAt = null;
  let message;
  if (lim.period === "day") {
    resetsAt = await windowResetsAt(workspaceId, kind, lim.limit, used, quantity, client);
    if (resetsAt) {
      message = `Trial limit reached: ${lim.limit} ${noun} per 24 hours. Try again in about ${humanWait(new Date(resetsAt).getTime() - Date.now())}.`;
    } else {
      message = `Trial limit reached: ${lim.limit} ${noun} per 24 hours. You asked for ${quantity}, which is more than the limit allows. Reduce the number and try again.`;
    }
  } else if (quantity > 1 && used + quantity > lim.limit && used < lim.limit) {
    message = `Trial limit reached: ${lim.limit} ${noun}. You have ${used} and tried to add ${quantity}, which would go over it. Add fewer or contact support to raise it.`;
  } else {
    message = `Trial limit reached: ${lim.limit} ${noun}. Contact support to raise it.`;
  }
  notifyLimitReached(workspaceId, kind, lim, used, resetsAt);
  return new QuotaError(message, { kind, limit: lim.limit, period: lim.period, used, resetsAt });
}

// Fire-and-forget "limit reached" email to the workspace owners/admins (deduplicated there, once per limit per 24 h).
// Must never add latency to, or throw into, the quota path: deferred to the next tick and every failure swallowed.
function notifyLimitReached(workspaceId, kind, lim, used, resetsAt) {
  try {
    if (used < lim.limit) return;
    setImmediate(() => {
      try {
        Promise.resolve(require("./systemMail.service").limitReached(workspaceId, kind, lim, resetsAt)).catch(() => {});
      } catch (_) { /* best effort */ }
    });
  } catch (_) { /* best effort */ }
}

function assertArgs(kind, quantity) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown quota kind: ${kind}`);
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error("Quota quantity must be a positive whole number");
}

const quotaService = {
  TRIAL_DEFAULTS,
  TRIAL_DAYS,
  KINDS,
  LABELS,
  QuotaError,
  isQuotaError,
  errorBody,
  planColumns,
  lightPlan,
  withLightPlan,
  limitFor,

  async getLimits(workspaceId) {
    return loadLimits(workspaceId);
  },

  // Throws QuotaError when `quantity` more of `kind` would exceed the workspace's limit. `client` lets a caller run the
  // check inside its own transaction (after taking `lock`).
  async check(workspaceId, kind, quantity = 1, client = null) {
    assertArgs(kind, quantity);
    const lim = limitFor(await loadLimits(workspaceId, client), kind);
    if (!lim) return { limited: false };
    const used = await usedNow(workspaceId, kind, lim.period, client);
    if (used + quantity > lim.limit) throw await buildError(workspaceId, kind, lim, used, quantity, client);
    return { limited: true, limit: lim.limit, period: lim.period, used };
  },

  // Takes the per-workspace quota lock for the rest of the client's transaction.
  async lock(client, workspaceId) {
    await client.query(`SELECT pg_advisory_xact_lock($1, $2)`, [LOCK_NS, workspaceId]);
  },

  // Records usage (always, even for unlimited workspaces, so the admin sees it). Returns the event id.
  async record(workspaceId, kind, quantity = 1, meta = null, client = null) {
    assertArgs(kind, quantity);
    if (!USAGE_KINDS.includes(kind)) return null; // workflows are counted from rows, nothing to record
    const { rows } = await (client || db).query(
      `INSERT INTO workspace_usage_events (workspace_id, kind, quantity, meta) VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
      [workspaceId, kind, quantity, meta ? JSON.stringify(meta) : null],
    );
    return rows[0].id;
  },

  // check + record as one step. Limited kinds run under a per-workspace advisory lock so parallel callers can't
  // overshoot; unlimited workspaces just record (best effort: a usage-log failure never blocks real work).
  // Returns the usage event id (for refund) or null.
  async consume(workspaceId, kind, quantity = 1, meta = null) {
    assertArgs(kind, quantity);
    const lim = limitFor(await loadLimits(workspaceId), kind);
    if (!lim) {
      try {
        return await this.record(workspaceId, kind, quantity, meta);
      } catch (error) {
        console.error("Could not record usage:", error.message);
        return null;
      }
    }
    const client = await db.getClient();
    try {
      await client.query("BEGIN");
      await this.lock(client, workspaceId);
      await this.check(workspaceId, kind, quantity, client);
      const id = await this.record(workspaceId, kind, quantity, meta, client);
      await client.query("COMMIT");
      return id;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  },

  // Gives back usage that was consumed up front for work that then did not happen. `keep` = how many of the consumed
  // units really happened (0 removes the event).
  async refund(workspaceId, eventId, keep = 0) {
    if (!eventId) return;
    try {
      if (keep > 0) await db.query(`UPDATE workspace_usage_events SET quantity = $3 WHERE id = $1 AND workspace_id = $2 AND quantity > $3`, [eventId, workspaceId, keep]);
      else await db.query(`DELETE FROM workspace_usage_events WHERE id = $1 AND workspace_id = $2`, [eventId, workspaceId]);
    } catch (error) {
      console.error("Could not refund usage:", error.message);
    }
  },

  // Order requests: more than the limit for that kind (domains/mailboxes) is refused outright. For a "total" cap the
  // existing rows count (the order would push the total past the limit); for "day" only the size of the order counts.
  async assertOrderQuantity(workspaceId, kind, quantity) {
    const lim = limitFor(await loadLimits(workspaceId), kind);
    if (!lim) return;
    const used = lim.period === "total" ? await usedNow(workspaceId, kind, "total") : 0;
    if (used + quantity > lim.limit) {
      const noun = NOUNS[kind];
      const room = Math.max(0, lim.limit - used);
      const message = lim.period === "total"
        ? `Trial limit reached: ${lim.limit} ${noun}. You have ${used}, so you can order at most ${room} more. Contact support to raise the limit.`
        : `Trial limit reached: ${lim.limit} ${noun} per 24 hours. You asked for ${quantity}. Order ${lim.limit} or fewer.`;
      throw new QuotaError(message, { kind, limit: lim.limit, period: lim.period, used, resetsAt: null });
    }
  },

  // `limits[]` of the plan object: only entries that are set, with live usage.
  async usageSummary(workspaceId, limitsRaw) {
    const limits = limitsRaw || (await loadLimits(workspaceId));
    const out = [];
    for (const key of KINDS) {
      const lim = limitFor(limits, key);
      if (!lim) continue;
      const used = await usedNow(workspaceId, key, lim.period);
      // resets_at: when a rolling-window limit that is currently reached frees room again (null otherwise).
      let resetsAt = null;
      if (lim.period === "day" && used >= lim.limit && lim.limit > 0) {
        try {
          const at = await windowResetsAt(workspaceId, key, lim.limit, used, 1);
          resetsAt = at ? new Date(at).toISOString() : null;
        } catch (_) { resetsAt = null; }
      }
      out.push({ key, label: LABELS[key], limit: lim.limit, period: lim.period, used, remaining: Math.max(0, lim.limit - used), resets_at: resetsAt });
    }
    return out;
  },

  // Full `plan` object for a workspace row selected with planColumns() (needs `id`).
  async planSummary(row) {
    const light = lightPlan(row);
    return {
      type: light.type,
      trial_started_at: light.type === "trial" ? row.trial_started_at || null : null,
      trial_ends_at: light.trial_ends_at,
      days_left: light.days_left,
      ended: light.ended,
      limits: await this.usageSummary(row.id, row.limits || {}),
    };
  },

  // Validates a limits object coming from the super admin. Returns the cleaned object.
  validateLimits(input, makeError = (m) => Object.assign(new Error(m), { status: 400, statusCode: 400 })) {
    const bad = makeError;
    if (input === null || typeof input !== "object" || Array.isArray(input)) throw bad("Limits must be an object like { \"domains\": { \"limit\": 10, \"period\": \"total\" } }.");
    const out = {};
    for (const [key, value] of Object.entries(input)) {
      if (!KINDS.includes(key)) throw bad(`Unknown limit "${key}". Use one of: ${KINDS.join(", ")}.`);
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw bad(`Limit "${key}" must be an object like { "limit": 10, "period": "total" }.`);
      const { limit, period } = value;
      if (limit !== null && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0 || limit > 1000000000)) {
        throw bad(`The limit for "${key}" must be a whole number of 0 or more, or null for unlimited.`);
      }
      const defaultPeriod = (TRIAL_DEFAULTS[key] || { period: "day" }).period;
      const p = period === undefined ? defaultPeriod : period;
      if (!PERIODS.includes(p)) throw bad(`The period for "${key}" must be "day" or "total".`);
      out[key] = { limit, period: p };
    }
    return out;
  },
};

module.exports = quotaService;
