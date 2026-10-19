const db = require("../config/db.config");
const workspaceService = require("./workspace.service");
const memberService = require("./member.service");
const quota = require("./quota.service");

const { WorkspaceError } = workspaceService;
const PROVIDERS = ["openai", "anthropic", "gemini"];

function pageParams(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  return { page, limit, offset: (page - 1) * limit };
}

function likePattern(search) {
  return `%${String(search || "").trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function parseId(value, what = "workspace") {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new WorkspaceError(`That ${what} could not be found.`, 404);
  return id;
}

function ownerName(o) {
  return [o.first_name, o.last_name].filter(Boolean).join(" ") || o.email;
}

const WORKSPACE_COLUMNS = `w.id, w.name, w.slug, w.type, w.status, w.auto_responder_enabled, w.cold_mailer_enabled,
  w.platform_ai_enabled, w.created_at, ${quota.planColumns("w")}`;

// Decorates workspace rows with member_count, owner and resource counts using grouped queries (no N+1).
async function decorate(rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [members, owners, counts] = await Promise.all([
    db.query(
      `SELECT wm.workspace_id, COUNT(*)::int AS n FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id AND COALESCE(u.is_deleted, FALSE) = FALSE
       WHERE wm.workspace_id = ANY($1) GROUP BY wm.workspace_id`,
      [ids],
    ),
    db.query(
      `SELECT DISTINCT ON (wm.workspace_id) wm.workspace_id, u.id, u.email, u.first_name, u.last_name
       FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id AND COALESCE(u.is_deleted, FALSE) = FALSE
       WHERE wm.workspace_id = ANY($1) AND wm.role = 'owner'
       ORDER BY wm.workspace_id, wm.created_at, u.id`,
      [ids],
    ),
    db.query(
      `SELECT w.id AS workspace_id,
         (SELECT COUNT(*)::int FROM domains t WHERE t.workspace_id = w.id AND COALESCE(t.is_deleted, FALSE) = FALSE) AS domains,
         (SELECT COUNT(*)::int FROM mailboxes t WHERE t.workspace_id = w.id AND COALESCE(t.is_deleted, FALSE) = FALSE) AS mailboxes,
         (SELECT COUNT(*)::int FROM campaigns t WHERE t.workspace_id = w.id AND COALESCE(t.is_deleted, FALSE) = FALSE) AS campaigns,
         (SELECT COUNT(*)::int FROM ai_agents t WHERE t.workspace_id = w.id AND COALESCE(t.is_deleted, FALSE) = FALSE) AS agents
       FROM workspaces w WHERE w.id = ANY($1)`,
      [ids],
    ),
  ]);
  const memberBy = new Map(members.rows.map((r) => [r.workspace_id, r.n]));
  const ownerBy = new Map(owners.rows.map((r) => [r.workspace_id, r]));
  const countBy = new Map(counts.rows.map((r) => [r.workspace_id, r]));
  return rows.map((r) => {
    const o = ownerBy.get(r.id);
    const c = countBy.get(r.id) || {};
    const light = quota.lightPlan(r);
    const { plan: _p, trial_started_at: _a, trial_ends_at: _b, trial_expired: _c, trial_secs_left: _d, limits: _e, ...base } = r;
    return {
      ...base,
      plan: light.type,
      trial_ends_at: light.trial_ends_at,
      days_left: light.days_left,
      member_count: memberBy.get(r.id) || 0,
      owner: o ? { id: o.id, email: o.email, name: ownerName(o) } : null,
      counts: { domains: c.domains || 0, mailboxes: c.mailboxes || 0, campaigns: c.campaigns || 0, agents: c.agents || 0 },
    };
  });
}

async function loadWorkspace(id, withPlanSummary = false) {
  const { rows } = await db.query(`SELECT ${WORKSPACE_COLUMNS} FROM workspaces w WHERE w.id = $1 AND w.is_deleted = FALSE`, [id]);
  if (!rows[0]) throw new WorkspaceError("That workspace could not be found.", 404);
  const decorated = (await decorate(rows))[0];
  // List/PATCH shape: flat `plan` ("trial"|"standard"), trial_ends_at, days_left. GET /:id swaps `plan` for the full object.
  return withPlanSummary ? { ...decorated, plan: await quota.planSummary(rows[0]) } : decorated;
}

const isKoval = (slug) => slug === "koval-group";
const badRequest = (m) => new WorkspaceError(m, 400);
const KOVAL_PLAN_MSG = "Koval Group is the platform's own workspace and can't be put on a trial or given limits.";

const adminService = {
  async listWorkspaces(query) {
    const { page, limit, offset } = pageParams(query);
    const where = ["w.is_deleted = FALSE"];
    const params = [];
    if (query.search && String(query.search).trim()) {
      params.push(likePattern(query.search));
      where.push(`(w.name ILIKE $${params.length} OR w.slug ILIKE $${params.length})`);
    }
    if (query.status) {
      if (!["active", "suspended"].includes(query.status)) throw new WorkspaceError("Status must be active or suspended.", 400);
      params.push(query.status);
      where.push(`w.status = $${params.length}`);
    }
    const clause = where.join(" AND ");
    const total = (await db.query(`SELECT COUNT(*)::int AS n FROM workspaces w WHERE ${clause}`, params)).rows[0].n;
    const { rows } = await db.query(
      `SELECT ${WORKSPACE_COLUMNS} FROM workspaces w WHERE ${clause} ORDER BY w.created_at DESC, w.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    return { items: await decorate(rows), total, page, limit };
  },

  async createWorkspace(body = {}) {
    const email = String(body.ownerEmail || "").trim().toLowerCase();
    if (!email) throw new WorkspaceError("Enter the email of the workspace owner.", 400);
    const { rows } = await db.query(
      `SELECT id FROM users WHERE LOWER(email) = $1 AND COALESCE(is_deleted, FALSE) = FALSE ORDER BY id LIMIT 1`,
      [email],
    );
    if (!rows[0]) throw new WorkspaceError("No user with that email exists. Ask them to sign up first.", 404);
    const ws = await workspaceService.createWorkspace(rows[0].id, { name: body.name, type: body.type });
    return loadWorkspace(ws.id);
  },

  async getWorkspace(idRaw) {
    const id = parseId(idRaw);
    const workspace = await loadWorkspace(id, true);
    const [members, keys, usage] = await Promise.all([
      memberService.list(id, null),
      db.query(`SELECT provider, key_preview, updated_at FROM workspace_ai_keys WHERE workspace_id = $1`, [id]),
      db.query(
        `SELECT
           (SELECT COUNT(*)::int FROM messages WHERE workspace_id = $1 AND direction = 'outbound' AND created_at >= NOW() - INTERVAL '30 days') AS "emailsSent",
           (SELECT COUNT(*)::int FROM messages WHERE workspace_id = $1 AND direction = 'inbound' AND created_at >= NOW() - INTERVAL '30 days') AS "repliesReceived",
           (SELECT COUNT(*)::int FROM ai_response_drafts WHERE workspace_id = $1 AND COALESCE(is_deleted, FALSE) = FALSE AND created_at >= NOW() - INTERVAL '30 days') AS "draftsGenerated"`,
        [id],
      ),
    ]);
    const keyBy = new Map(keys.rows.map((k) => [k.provider, k]));
    const aiProviders = PROVIDERS.map((p) => ({
      provider: p,
      configured: keyBy.has(p),
      preview: keyBy.get(p)?.key_preview || null,
      updated_at: keyBy.get(p)?.updated_at || null,
    }));
    return { ...workspace, members, aiProviders, usage: usage.rows[0] };
  },

  async updateWorkspace(idRaw, body = {}) {
    const id = parseId(idRaw);
    const sets = [];
    const params = [id];
    const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

    // Koval Group is the platform's own, live workspace: suspending it or switching off its products / platform AI
    // would stop production sending and replying, so those changes are refused here.
    const { rows: current } = await db.query(`SELECT slug FROM workspaces WHERE id = $1 AND is_deleted = FALSE`, [id]);
    if (current[0] && current[0].slug === "koval-group") {
      if (body.status === "suspended") throw new WorkspaceError("Koval Group is the platform's primary workspace and can't be suspended.", 409);
      if (body.auto_responder_enabled === false || body.cold_mailer_enabled === false) {
        throw new WorkspaceError("Koval Group's products can't be switched off: it runs the live platform.", 409);
      }
      if (body.platform_ai_enabled === false) {
        throw new WorkspaceError("Koval Group relies on the platform AI keys and can't have them switched off.", 409);
      }
    }

    // ---- plan / trial / limits ----
    const wantsPlan = body.plan !== undefined, wantsEnd = body.trial_ends_at !== undefined, wantsExtend = body.extend_trial_days !== undefined;
    if (wantsPlan && !["trial", "standard"].includes(body.plan)) throw badRequest('Plan must be "trial" or "standard".');
    if (wantsEnd && wantsExtend) throw badRequest("Send either trial_ends_at or extend_trial_days, not both.");
    let cleanLimits;
    if (body.limits !== undefined) cleanLimits = quota.validateLimits(body.limits, badRequest);
    let endsAt;
    if (wantsEnd) {
      endsAt = new Date(body.trial_ends_at);
      if (typeof body.trial_ends_at !== "string" || Number.isNaN(endsAt.getTime())) throw badRequest("trial_ends_at must be a date like 2026-12-31T23:59:00Z.");
    }
    if (wantsExtend && (!Number.isInteger(body.extend_trial_days) || body.extend_trial_days < 1 || body.extend_trial_days > 365)) {
      throw badRequest("extend_trial_days must be a whole number of days between 1 and 365.");
    }
    if (wantsPlan || wantsEnd || wantsExtend || body.limits !== undefined) {
      const { rows: cur } = await db.query(`SELECT plan, trial_ends_at, limits FROM workspaces WHERE id = $1 AND is_deleted = FALSE`, [id]);
      if (!cur[0]) throw new WorkspaceError("That workspace could not be found.", 404);
      const willBeTrial = wantsPlan ? body.plan === "trial" : cur[0].plan === "trial";
      if (isKoval(current[0] && current[0].slug) && (body.plan === "trial" || wantsEnd || wantsExtend || (cleanLimits && Object.keys(cleanLimits).length))) {
        throw new WorkspaceError(KOVAL_PLAN_MSG, 409);
      }
      if ((wantsEnd || wantsExtend) && !willBeTrial) throw badRequest('Only a workspace on a trial has an end date. Set plan to "trial" first (or use the trial endpoint).');
      if (wantsPlan) add("plan", body.plan);
      if (body.plan === "trial") {
        if (cur[0].plan !== "trial") sets.push("trial_started_at = NOW()");
        if (!wantsEnd && !wantsExtend && (cur[0].plan !== "trial" || !cur[0].trial_ends_at)) sets.push(`trial_ends_at = NOW() + INTERVAL '${quota.TRIAL_DAYS} days'`);
        if (cleanLimits === undefined && !Object.keys(cur[0].limits || {}).length) cleanLimits = { ...JSON.parse(JSON.stringify(quota.TRIAL_DEFAULTS)) };
      }
      if (wantsEnd) {
        params.push(endsAt.toISOString());
        sets.push(`trial_ends_at = $${params.length}::timestamptz`);
      }
      if (wantsExtend) {
        params.push(body.extend_trial_days);
        sets.push(`trial_ends_at = GREATEST(COALESCE(trial_ends_at, NOW()), NOW()) + ($${params.length}::int * INTERVAL '1 day')`);
      }
      if (cleanLimits !== undefined) {
        params.push(JSON.stringify(cleanLimits));
        sets.push(`limits = $${params.length}::jsonb`);
      }
    }

    if (body.name !== undefined) {
      const name = String(body.name || "").trim();
      if (name.length < 2 || name.length > 120) throw new WorkspaceError("Workspace name must be between 2 and 120 characters.", 400);
      add("name", name);
    }
    if (body.type !== undefined) {
      if (!["organization", "individual"].includes(body.type)) throw new WorkspaceError("Type must be organization or individual.", 400);
      add("type", body.type);
    }
    if (body.status !== undefined) {
      if (!["active", "suspended"].includes(body.status)) throw new WorkspaceError("Status must be active or suspended.", 400);
      add("status", body.status);
    }
    for (const flag of ["auto_responder_enabled", "cold_mailer_enabled", "platform_ai_enabled"]) {
      if (body[flag] !== undefined) {
        if (typeof body[flag] !== "boolean") throw new WorkspaceError(`${flag} must be true or false.`, 400);
        add(flag, body[flag]);
      }
    }
    if (!sets.length) throw new WorkspaceError("Nothing to update.", 400);
    const { rowCount } = await db.query(
      `UPDATE workspaces SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $1 AND is_deleted = FALSE`,
      params,
    );
    if (!rowCount) throw new WorkspaceError("That workspace could not be found.", 404);
    return loadWorkspace(id);
  },

  // Starts (or restarts) a trial: plan=trial, a fresh start/end, and the given or default limits.
  async startTrial(idRaw, body = {}) {
    const id = parseId(idRaw);
    const { rows } = await db.query(`SELECT slug FROM workspaces WHERE id = $1 AND is_deleted = FALSE`, [id]);
    if (!rows[0]) throw new WorkspaceError("That workspace could not be found.", 404);
    if (isKoval(rows[0].slug)) throw new WorkspaceError(KOVAL_PLAN_MSG, 409);
    let days = quota.TRIAL_DAYS;
    if (body.days !== undefined && body.days !== null) {
      if (!Number.isInteger(body.days) || body.days < 1 || body.days > 365) throw badRequest("Trial length must be a whole number of days between 1 and 365.");
      days = body.days;
    }
    const limits = body.limits !== undefined && body.limits !== null
      ? quota.validateLimits(body.limits, badRequest)
      : JSON.parse(JSON.stringify(quota.TRIAL_DEFAULTS));
    await db.query(
      `UPDATE workspaces SET plan = 'trial', trial_started_at = NOW(), trial_ends_at = NOW() + ($2::int * INTERVAL '1 day'), limits = $3::jsonb, updated_at = NOW() WHERE id = $1`,
      [id, days, JSON.stringify(limits)],
    );
    return loadWorkspace(id);
  },

  // Clears rolling usage (all kinds, or one) so the workspace can use its allowance again.
  async resetUsage(idRaw, body = {}) {
    const id = parseId(idRaw);
    await this.assertWorkspace(id);
    const kind = body.kind;
    if (kind !== undefined && kind !== null && !["ai_requests", "domains", "mailboxes", "emails"].includes(kind)) {
      throw badRequest('kind must be one of: ai_requests, domains, mailboxes, emails. (Workflow limits count existing workflows, so there is no usage to reset.)');
    }
    const { rowCount } = kind
      ? await db.query(`DELETE FROM workspace_usage_events WHERE workspace_id = $1 AND kind = $2`, [id, kind])
      : await db.query(`DELETE FROM workspace_usage_events WHERE workspace_id = $1`, [id]);
    return { kind: kind || null, cleared: rowCount };
  },

  async deleteWorkspace(idRaw) {
    const id = parseId(idRaw);
    const { rows } = await db.query(`SELECT slug FROM workspaces WHERE id = $1 AND is_deleted = FALSE`, [id]);
    if (!rows[0]) throw new WorkspaceError("That workspace could not be found.", 404);
    if (rows[0].slug === "koval-group") throw new WorkspaceError("Koval Group is the platform's primary workspace and can't be deleted.", 409);
    await db.query(`UPDATE workspaces SET is_deleted = TRUE, updated_at = NOW() WHERE id = $1`, [id]);
  },

  // Member management for any workspace: same rules as /members, but the actor is a super admin.
  async assertWorkspace(idRaw) {
    const id = parseId(idRaw);
    const { rows } = await db.query(`SELECT 1 FROM workspaces WHERE id = $1 AND is_deleted = FALSE`, [id]);
    if (!rows[0]) throw new WorkspaceError("That workspace could not be found.", 404);
    return id;
  },

  async listUsers(query) {
    const { page, limit, offset } = pageParams(query);
    const params = [];
    let where = "";
    if (query.search && String(query.search).trim()) {
      params.push(likePattern(query.search));
      where = `WHERE (u.email ILIKE $1 OR u.first_name ILIKE $1 OR u.last_name ILIKE $1 OR CONCAT_WS(' ', u.first_name, u.last_name) ILIKE $1)`;
    }
    const total = (await db.query(`SELECT COUNT(*)::int AS n FROM users u ${where}`, params)).rows[0].n;
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.is_super_admin, COALESCE(u.is_deleted, FALSE) AS is_deleted, u.created_at,
         COALESCE((SELECT json_agg(json_build_object('id', w.id, 'name', w.name, 'role', wm.role) ORDER BY w.id)
                   FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id AND w.is_deleted = FALSE
                   WHERE wm.user_id = u.id), '[]'::json) AS workspaces
       FROM users u ${where} ORDER BY u.created_at DESC, u.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    return { items: rows, total, page, limit };
  },

  async updateUser(actorId, idRaw, body = {}) {
    const id = parseId(idRaw, "user");
    if (body.is_super_admin === undefined && body.is_deleted === undefined) throw new WorkspaceError("Nothing to update.", 400);
    for (const k of ["is_super_admin", "is_deleted"]) {
      if (body[k] !== undefined && typeof body[k] !== "boolean") throw new WorkspaceError(`${k} must be true or false.`, 400);
    }
    if (Number(actorId) === id) {
      if (body.is_super_admin === false) throw new WorkspaceError("You can't remove your own super admin access.", 400);
      if (body.is_deleted === true) throw new WorkspaceError("You can't delete your own account.", 400);
    }
    const sets = [];
    const params = [id];
    if (body.is_super_admin !== undefined) { params.push(body.is_super_admin); sets.push(`is_super_admin = $${params.length}`); }
    if (body.is_deleted !== undefined) { params.push(body.is_deleted); sets.push(`is_deleted = $${params.length}`); }
    const { rows } = await db.query(
      `UPDATE users SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $1
       RETURNING id, email, first_name, last_name, is_super_admin, COALESCE(is_deleted, FALSE) AS is_deleted, created_at`,
      params,
    );
    if (!rows[0]) throw new WorkspaceError("That user could not be found.", 404);
    return rows[0];
  },

  async analytics(query) {
    const days = Math.min(365, Math.max(1, parseInt(query.days, 10) || 30));
    const [totals, series, byWs] = await Promise.all([
      db.query(
        `SELECT
           (SELECT COUNT(*)::int FROM workspaces WHERE is_deleted = FALSE) AS workspaces,
           (SELECT COUNT(*)::int FROM users WHERE COALESCE(is_deleted, FALSE) = FALSE) AS users,
           (SELECT COUNT(*)::int FROM domains d JOIN workspaces w ON w.id = d.workspace_id AND w.is_deleted = FALSE WHERE COALESCE(d.is_deleted, FALSE) = FALSE) AS domains,
           (SELECT COUNT(*)::int FROM mailboxes d JOIN workspaces w ON w.id = d.workspace_id AND w.is_deleted = FALSE WHERE COALESCE(d.is_deleted, FALSE) = FALSE) AS mailboxes,
           (SELECT COUNT(*)::int FROM campaigns d JOIN workspaces w ON w.id = d.workspace_id AND w.is_deleted = FALSE WHERE COALESCE(d.is_deleted, FALSE) = FALSE) AS campaigns,
           (SELECT COUNT(*)::int FROM messages m JOIN workspaces w ON w.id = m.workspace_id AND w.is_deleted = FALSE
              WHERE m.direction = 'outbound' AND m.created_at >= date_trunc('day', NOW()) - ($1::int - 1) * INTERVAL '1 day') AS "emailsSent",
           (SELECT COUNT(*)::int FROM messages m JOIN workspaces w ON w.id = m.workspace_id AND w.is_deleted = FALSE
              WHERE m.direction = 'inbound' AND m.created_at >= date_trunc('day', NOW()) - ($1::int - 1) * INTERVAL '1 day') AS "repliesReceived",
           (SELECT COUNT(*)::int FROM ai_response_drafts d JOIN workspaces w ON w.id = d.workspace_id AND w.is_deleted = FALSE
              WHERE COALESCE(d.is_deleted, FALSE) = FALSE AND d.created_at >= date_trunc('day', NOW()) - ($1::int - 1) * INTERVAL '1 day') AS "draftsGenerated",
           (SELECT COUNT(*)::int FROM meeting_bookings b JOIN workspaces w ON w.id = b.workspace_id AND w.is_deleted = FALSE
              WHERE b.created_at >= date_trunc('day', NOW()) - ($1::int - 1) * INTERVAL '1 day') AS "meetingsBooked"`,
        [days],
      ),
      db.query(
        `WITH d AS (SELECT generate_series(date_trunc('day', NOW()) - ($1::int - 1) * INTERVAL '1 day', date_trunc('day', NOW()), INTERVAL '1 day') AS day),
         m AS (SELECT date_trunc('day', m.created_at) AS day,
                      COUNT(*) FILTER (WHERE m.direction = 'outbound')::int AS sent,
                      COUNT(*) FILTER (WHERE m.direction = 'inbound')::int AS replies
               FROM messages m JOIN workspaces w ON w.id = m.workspace_id AND w.is_deleted = FALSE
               WHERE m.created_at >= date_trunc('day', NOW()) - ($1::int - 1) * INTERVAL '1 day' GROUP BY 1)
         SELECT to_char(d.day, 'YYYY-MM-DD') AS date, COALESCE(m.sent, 0) AS "emailsSent", COALESCE(m.replies, 0) AS "repliesReceived"
         FROM d LEFT JOIN m ON m.day = d.day ORDER BY d.day`,
        [days],
      ),
      db.query(
        `WITH since AS (SELECT date_trunc('day', NOW()) - ($1::int - 1) * INTERVAL '1 day' AS t),
         msg AS (SELECT workspace_id,
                        COUNT(*) FILTER (WHERE direction = 'outbound' AND created_at >= (SELECT t FROM since))::int AS sent,
                        COUNT(*) FILTER (WHERE direction = 'inbound' AND created_at >= (SELECT t FROM since))::int AS replies,
                        MAX(created_at) AS last_at
                 FROM messages GROUP BY workspace_id),
         dr AS (SELECT workspace_id, COUNT(*) FILTER (WHERE created_at >= (SELECT t FROM since))::int AS drafts, MAX(created_at) AS last_at
                FROM ai_response_drafts WHERE COALESCE(is_deleted, FALSE) = FALSE GROUP BY workspace_id),
         ev AS (SELECT app_workspace_id AS workspace_id, MAX(created_at) AS last_at FROM event_logs WHERE app_workspace_id IS NOT NULL GROUP BY 1),
         dm AS (SELECT workspace_id, COUNT(*)::int AS n FROM domains WHERE COALESCE(is_deleted, FALSE) = FALSE GROUP BY 1),
         mb AS (SELECT workspace_id, COUNT(*)::int AS n FROM mailboxes WHERE COALESCE(is_deleted, FALSE) = FALSE GROUP BY 1),
         cp AS (SELECT workspace_id, COUNT(*)::int AS n FROM campaigns WHERE COALESCE(is_deleted, FALSE) = FALSE GROUP BY 1)
         SELECT w.id AS "workspaceId", w.name,
                COALESCE(msg.sent, 0) AS "emailsSent", COALESCE(msg.replies, 0) AS "repliesReceived",
                COALESCE(dr.drafts, 0) AS "draftsGenerated",
                COALESCE(dm.n, 0) AS domains, COALESCE(mb.n, 0) AS mailboxes, COALESCE(cp.n, 0) AS campaigns,
                GREATEST(msg.last_at, dr.last_at, ev.last_at) AS "lastActivityAt"
         FROM workspaces w
         LEFT JOIN msg ON msg.workspace_id = w.id LEFT JOIN dr ON dr.workspace_id = w.id LEFT JOIN ev ON ev.workspace_id = w.id
         LEFT JOIN dm ON dm.workspace_id = w.id LEFT JOIN mb ON mb.workspace_id = w.id LEFT JOIN cp ON cp.workspace_id = w.id
         WHERE w.is_deleted = FALSE ORDER BY "emailsSent" DESC, w.id`,
        [days],
      ),
    ]);
    return { days, totals: totals.rows[0], series: series.rows, byWorkspace: byWs.rows };
  },
};

module.exports = adminService;
