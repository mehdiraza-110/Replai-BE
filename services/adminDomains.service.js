// Super-admin domain management: list/detail of every domain on the platform, and the shared logic behind assigning
// domains (with all their mailboxes) from one workspace to another (preview + apply). adminOrder.assignDomains runs the
// real transaction and calls `buildPlan` / `applyPlan` from here; nothing in this file imports adminOrder (no cycle).
const db = require("../config/db.config");
const quota = require("./quota.service");
const eventLog = require("./eventLog.service");
const email = require("./email.service");
const systemMail = require("./systemMail.service");
const { WorkspaceError } = require("./workspace.service");

const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PLATFORM_SLUG = "koval-group";
const PROVIDER_LABELS = { maildoso: "Maildoso", postal: "Hetzner (Postal)", ses: "Amazon SES" };

const normProvider = (p) => {
  const v = String(p || "").trim().toLowerCase();
  return v === "amazon ses" || v === "ses" || v === "" ? "ses" : v;
};
const providerLabel = (p) => PROVIDER_LABELS[normProvider(p)] || String(p || "");
const ownerName = (o) => [o.first_name, o.last_name].filter(Boolean).join(" ") || o.email;
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

function parseDomains(list) {
  if (!Array.isArray(list) || list.length === 0) throw new WorkspaceError("Provide the list of domains to assign.", 400);
  if (list.length > 100) throw new WorkspaceError("You can assign at most 100 domains at a time.", 400);
  const names = [];
  for (const d of list) {
    const v = typeof d === "string" ? d.trim().toLowerCase() : "";
    if (!DOMAIN_RE.test(v)) throw new WorkspaceError(`"${String(d).slice(0, 80)}" is not a valid domain name.`, 400);
    if (!names.includes(v)) names.push(v);
  }
  return names;
}

function parseWorkspaceId(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 2147483647) throw new WorkspaceError("That workspace could not be found.", 404);
  return n;
}

function parseNotes(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new WorkspaceError("Notes must be text.", 400);
  const t = v.trim();
  if (t.length > 2000) throw new WorkspaceError("Notes can be at most 2000 characters.", 400);
  return t || null;
}

async function loadTarget(q, targetId, lock) {
  const ws = await q.query(`SELECT id, name, slug FROM workspaces WHERE id = $1 AND is_deleted = FALSE${lock ? " FOR UPDATE" : ""}`, [targetId]);
  if (!ws.rows[0]) throw new WorkspaceError("That workspace could not be found.", 404);
  return ws.rows[0];
}

const sameStrategy = (a, b) =>
  a.name === b.name &&
  a.start_daily_limit === b.start_daily_limit &&
  a.steady_state_daily_limit === b.steady_state_daily_limit &&
  a.increment_per_stage === b.increment_per_stage &&
  a.stage_duration_days === b.stage_duration_days &&
  a.steady_state_market_daily_limit === b.steady_state_market_daily_limit &&
  (a.description || null) === (b.description || null) &&
  JSON.stringify(a.safety_tiers || []) === JSON.stringify(b.safety_tiers || []);

/**
 * Reads everything an assignment needs and works out its impact. With `lock` (inside the assignment transaction) the
 * domain, mailbox and campaign rows are locked FOR UPDATE. Never writes. Returns the impact plus `blocked`
 * ({message,status,code?}[]) for real blockers: callers throw the first one (assign) or list them (preview).
 */
async function buildPlan(q, target, names, { lock = false } = {}) {
  const fu = lock ? " FOR UPDATE" : "";
  const blocked = [];
  const dom = await q.query(
    `SELECT d.id, d.domain, d.provider, d.workspace_id, w.slug AS ws_slug, w.name AS ws_name,
       (SELECT u.email FROM workspace_members wm JOIN users u ON u.id = wm.user_id
         WHERE wm.workspace_id = d.workspace_id AND wm.role = 'owner' AND COALESCE(u.is_deleted, FALSE) = FALSE
         ORDER BY wm.created_at, u.id LIMIT 1) AS owner_email
     FROM domains d LEFT JOIN workspaces w ON w.id = d.workspace_id
     WHERE d.domain = ANY($1::text[]) AND COALESCE(d.is_deleted, FALSE) = FALSE
     ORDER BY d.id${lock ? " FOR UPDATE OF d" : ""}`,
    [names],
  );
  const domains = dom.rows;
  const found = new Set(domains.map((r) => r.domain));
  const missing = names.filter((n) => !found.has(n));
  if (missing.length) blocked.push({ message: `These domains don't exist: ${missing.join(", ")}.`, status: 404 });
  const already = domains.filter((r) => r.workspace_id === target.id).map((r) => r.domain);
  if (already.length) blocked.push({ message: `Already in ${target.name}: ${already.join(", ")}.`, status: 409 });
  const fromPlatform = domains.filter((r) => r.ws_slug === PLATFORM_SLUG).map((r) => r.domain);

  const plan = { target, domains, fromPlatform, blocked, mailboxes: [], campaigns: [], strategies: [], warnings: [], workflows: [], sourceIds: [] };
  if (missing.length) return plan;

  const domainIds = domains.map((r) => r.id);
  const mb = await q.query(
    `SELECT id, email, domain_id, workspace_id, status, is_deleted, provider, daily_limit, warmup_stage, warmup_strategy_id
     FROM mailboxes WHERE domain_id = ANY($1::int[]) ORDER BY id${fu}`,
    [domainIds],
  );
  const domById = new Map(domains.map((d) => [d.id, d]));
  const stray = mb.rows.filter((r) => r.workspace_id !== domById.get(r.domain_id).workspace_id);
  if (stray.length) {
    blocked.push({ message: `Mailbox ${stray[0].email} is not in the same workspace as its domain. Fix that data issue before assigning.`, status: 409 });
  }
  plan.mailboxes = mb.rows;
  plan.sourceIds = [...new Set(domains.map((r) => r.workspace_id).filter((x) => x != null))];
  const movedIds = mb.rows.map((r) => r.id);
  const movedSet = new Set(movedIds);

  // ---- strategies (per workspace): clone the source strategy into the target, reuse an earlier clone ----
  const stratIds = [...new Set(mb.rows.map((r) => r.warmup_strategy_id).filter((x) => x != null))];
  const stratRows = stratIds.length ? (await q.query(`SELECT * FROM warmup_strategies WHERE id = ANY($1::int[]) ORDER BY id`, [stratIds])).rows : [];
  plan.strategyById = new Map(stratRows.map((s) => [s.id, s]));
  if (stratRows.length) {
    const existing = (await q.query(`SELECT * FROM warmup_strategies WHERE workspace_id = $1 AND is_deleted = FALSE ORDER BY id`, [target.id])).rows;
    for (const s of stratRows) {
      if (s.workspace_id === target.id) {
        plan.strategies.push({ from_strategy_id: s.id, name: s.name, action: "keep", to_strategy_id: s.id });
        continue;
      }
      const clone = existing.find((e) => sameStrategy(e, s));
      plan.strategies.push({ from_strategy_id: s.id, name: s.name, action: clone ? "reuse" : "clone", to_strategy_id: clone ? clone.id : null, _src: s });
    }
  }

  // ---- campaigns of the source workspaces that use a moved mailbox ----
  if (plan.sourceIds.length && movedIds.length) {
    const camps = await q.query(
      `SELECT c.id, c.name, c.status, c.mailbox_mode, c.mailbox_ids, c.is_warmup, c.workspace_id, w.name AS ws_name
       FROM campaigns c JOIN workspaces w ON w.id = c.workspace_id
       WHERE c.is_deleted = FALSE AND c.workspace_id = ANY($1::int[]) ORDER BY c.id${lock ? " FOR UPDATE OF c" : ""}`,
      [plan.sourceIds],
    );
    const usable = await q.query(
      `SELECT id, workspace_id FROM mailboxes WHERE workspace_id = ANY($1::int[]) AND is_deleted = FALSE AND status = 'Active' AND id <> ALL($2::int[])`,
      [plan.sourceIds, movedIds],
    );
    const usableBy = new Map();
    for (const r of usable.rows) {
      if (!usableBy.has(r.workspace_id)) usableBy.set(r.workspace_id, new Set());
      usableBy.get(r.workspace_id).add(r.id);
    }
    const liveMovedBy = new Map();
    for (const r of mb.rows) {
      if (r.is_deleted) continue;
      liveMovedBy.set(r.workspace_id, (liveMovedBy.get(r.workspace_id) || 0) + 1);
    }
    for (const c of camps.rows) {
      const set = usableBy.get(c.workspace_id) || new Set();
      if (c.mailbox_mode === "specific") {
        const ids = c.mailbox_ids || [];
        const removed = ids.filter((i) => movedSet.has(i));
        if (!removed.length) continue;
        const keep = ids.filter((i) => !movedSet.has(i));
        const remaining = keep.filter((i) => set.has(i)).length;
        plan.campaigns.push(entry(c, "specific", remaining, removed.length, keep));
      } else {
        const lost = liveMovedBy.get(c.workspace_id) || 0;
        if (!lost) continue;
        plan.campaigns.push(entry(c, "all", set.size, lost, null));
      }
    }
  }
  plan.warnings = [];

  // ---- workflows that reference a moved mailbox (left untouched) ----
  if (plan.sourceIds.length && movedIds.length) {
    const wfs = await q.query(`SELECT id, name, graph FROM workflows WHERE is_deleted = FALSE AND workspace_id = ANY($1::int[])`, [plan.sourceIds]);
    plan.workflows = wfs.rows.filter((w) =>
      ((w.graph && w.graph.nodes) || []).some((n) => {
        const d = n.data || {};
        const ids = [...(Array.isArray(d.mailboxIds) ? d.mailboxIds : []), ...(d.mailboxId != null ? [d.mailboxId] : [])];
        return ids.some((x) => movedSet.has(Number(x)));
      }),
    ).map((w) => ({ id: w.id, name: w.name }));
  }
  return plan;
}

function entry(c, mode, remaining, removed, newIds) {
  const active = c.status === "Active";
  return {
    id: c.id,
    name: c.name,
    workspaceId: c.workspace_id,
    workspaceName: c.ws_name,
    mode,
    isWarmup: c.is_warmup,
    status: c.status,
    removedMailboxes: removed,
    remainingMailboxes: remaining,
    willKeepRunning: active && remaining > 0,
    willPause: active && remaining === 0,
    _newIds: newIds,
  };
}

const publicCampaign = (c) => {
  const { _newIds, ...rest } = c;
  return rest;
};

function blockedError(b) {
  return new WorkspaceError(b.message, b.status, b.code);
}

/** Writes the move. Runs inside the caller's transaction (everything in `plan` is already locked). */
async function applyPlan(client, plan, { adminId, orderId = null, notes = null }) {
  const targetId = plan.target.id;
  const domainIds = plan.domains.map((r) => r.id);
  const mailboxIds = plan.mailboxes.map((r) => r.id);
  const mailboxEmails = plan.mailboxes.map((r) => r.email.toLowerCase());

  await client.query(`UPDATE domains SET workspace_id = $1, updated_at = NOW() WHERE id = ANY($2::int[])`, [targetId, domainIds]);

  if (mailboxIds.length) {
    // Warm-up progress is kept as is (stage, daily limit, start/tick/last action). Only the strategy pointer changes:
    // strategies are per workspace, so each moved mailbox points at the target's copy of its strategy.
    for (const s of plan.strategies) {
      if (s.action === "clone") {
        const src = s._src;
        const ins = await client.query(
          `INSERT INTO warmup_strategies (name, description, start_daily_limit, steady_state_daily_limit, increment_per_stage,
             stage_duration_days, safety_tiers, is_ai_generated, ai_rationale, created_by, steady_state_market_daily_limit, workspace_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12) RETURNING id`,
          [src.name, src.description, src.start_daily_limit, src.steady_state_daily_limit, src.increment_per_stage, src.stage_duration_days,
            JSON.stringify(src.safety_tiers || []), src.is_ai_generated, src.ai_rationale, adminId, src.steady_state_market_daily_limit, targetId],
        );
        s.to_strategy_id = ins.rows[0].id;
      }
    }
    await client.query(`UPDATE mailboxes SET workspace_id = $1, updated_at = NOW() WHERE id = ANY($2::int[])`, [targetId, mailboxIds]);
    for (const s of plan.strategies) {
      if (s.action === "keep") continue;
      await client.query(`UPDATE mailboxes SET warmup_strategy_id = $1 WHERE id = ANY($2::int[]) AND warmup_strategy_id = $3`, [s.to_strategy_id, mailboxIds, s.from_strategy_id]);
    }
    // Plain inbox history moves with the mailbox. Anything tied to a source campaign / agent / integration stays.
    await client.query(`UPDATE messages SET workspace_id = $1 WHERE mailbox_id = ANY($2::int[]) AND campaign_id IS NULL AND campaign_lead_id IS NULL`, [targetId, mailboxIds]);
    await client.query(`UPDATE ai_response_drafts SET workspace_id = $1 WHERE mailbox_id = ANY($2::int[]) AND ai_agent_id IS NULL AND integration_id IS NULL`, [targetId, mailboxIds]);
    await client.query(
      `UPDATE inbound_messages SET workspace_id = $1 WHERE workspace_id = ANY($2::int[]) AND LOWER(to_address) = ANY($3::text[])`,
      [targetId, plan.sourceIds, mailboxEmails],
    );
  }

  // Source campaigns lose the moved mailboxes; the ones left with nothing usable pause.
  for (const c of plan.campaigns) {
    const sets = ["updated_at = NOW()"];
    const params = [c.id];
    if (c.mode === "specific") {
      params.push(c._newIds);
      sets.push(`mailbox_ids = $${params.length}::int[]`);
    }
    if (c.willPause) sets.push("status = 'Paused'");
    await client.query(`UPDATE campaigns SET ${sets.join(", ")} WHERE id = $1`, params);
  }

  for (const d of plan.domains) {
    await client.query(
      `INSERT INTO domain_assignments (domain_id, from_workspace_id, to_workspace_id, assigned_by, order_id, notes) VALUES ($1,$2,$3,$4,$5,$6)`,
      [d.id, d.workspace_id, targetId, adminId, orderId, notes],
    );
  }
  // Assigned domains/mailboxes count as the workspace's usage, but an admin assignment is never blocked by a limit.
  await quota.record(targetId, "domains", domainIds.length, { source: "admin_assign" }, client);
  if (mailboxIds.length) await quota.record(targetId, "mailboxes", mailboxIds.length, { source: "admin_assign" }, client);
}

function resultOf(plan) {
  const mapped = plan.strategies.filter((s) => s.to_strategy_id != null);
  return {
    workspace: { id: plan.target.id, name: plan.target.name, slug: plan.target.slug },
    domains: plan.domains.map((d) => ({
      id: d.id,
      domain: d.domain,
      from_workspace: { id: d.workspace_id, name: d.ws_name, slug: d.ws_slug },
      mailboxes: plan.mailboxes.filter((m) => m.domain_id === d.id).map((m) => ({ id: m.id, email: m.email })),
    })),
    mailboxesMoved: plan.mailboxes.length,
    warmupStrategyId: mapped.length ? mapped[0].to_strategy_id : null,
    warmup: {
      preserved: true,
      strategies: plan.strategies.map((s) => ({ name: s.name, action: s.action, from_strategy_id: s.from_strategy_id, to_strategy_id: s.to_strategy_id })),
    },
    campaigns: plan.campaigns.map(publicCampaign),
  };
}

/** After commit: event log rows for affected/paused campaigns and the email to the target workspace's managers. */
async function afterAssign(plan, result, { adminId }) {
  for (const c of plan.campaigns) {
    try {
      await eventLog.record({
        eventType: c.willPause ? "campaign.paused_mailboxes_moved" : "campaign.mailboxes_moved",
        source: "admin",
        status: "Success",
        appWorkspaceId: c.workspaceId,
        createdBy: adminId,
        campaignId: c.id,
        campaignName: c.name,
        metadata: {
          reason: c.willPause
            ? "Mailboxes were assigned to another workspace and no usable mailbox is left for this campaign, so it was paused."
            : "Mailboxes were assigned to another workspace; the campaign keeps running with the rest.",
          toWorkspaceId: plan.target.id,
          removedMailboxes: c.removedMailboxes,
          remainingMailboxes: c.remainingMailboxes,
          mode: c.mode,
          isWarmup: c.isWarmup,
          paused: c.willPause,
        },
      });
    } catch (e) {
      console.error("Campaign audit log failed:", e.message);
    }
  }
  systemMail.fire(async () => {
    const recipients = await systemMail.managerEmails(plan.target.id, ["owner", "admin"]);
    if (!recipients.length) return;
    const esc = email.escapeHtml;
    const list = result.domains.map((d) => `<li>${esc(d.domain)} (${plural(d.mailboxes.length, "mailbox")})</li>`).join("");
    const { html, text } = email.renderEmail({
      title: "Domains were added to your workspace",
      preheader: `${plural(result.domains.length, "domain")} and ${plural(result.mailboxesMoved, "mailbox")} added`,
      paragraphs: [
        `${plural(result.domains.length, "domain")} with ${plural(result.mailboxesMoved, "mailbox")} ${result.domains.length === 1 ? "was" : "were"} added to <strong>${esc(plan.target.name)}</strong>.`,
        `<ul style="margin:0;padding-left:20px;">${list}</ul>`,
      ],
      cta: { label: "View your domains", url: email.appUrl("mailer/domains") },
    });
    await email.send({
      to: recipients,
      subject: `${plural(result.domains.length, "domain")} added to ${plan.target.name}`,
      html,
      text: `${text}\n${result.domains.map((d) => `- ${d.domain} (${plural(d.mailboxes.length, "mailbox")})`).join("\n")}`,
      category: "domains_assigned",
    });
  });
}

function stratNameOf(plan, id) {
  const s = plan.strategyById && plan.strategyById.get(id);
  return s ? s.name : null;
}

async function previewAssign(body = {}) {
  const names = parseDomains(body.domains);
  const targetId = parseWorkspaceId(body.workspaceId);
  const target = await loadTarget(db, targetId, false);
  const plan = await buildPlan(db, target, names);
  const blocked = plan.blocked.map((b) => b.message);
  const warnings = [];
  const requiresConfirmation = plan.fromPlatform.length > 0;
  if (requiresConfirmation) warnings.push(`Koval Group domain: confirmation required (${plan.fromPlatform.join(", ")}). These are the platform's own domains.`);
  for (const c of plan.campaigns) {
    if (c.willPause) warnings.push(`Campaign "${c.name}" (${c.workspaceName}) will pause: no usable mailbox would be left.`);
    else if (c.status !== "Active") warnings.push(`Campaign "${c.name}" (${c.workspaceName}) is ${c.status} and will lose ${plural(c.removedMailboxes, "mailbox")}.`);
  }
  for (const w of plan.workflows) warnings.push(`Workflow "${w.name}" references a moving mailbox and will keep pointing at it.`);
  if (plan.mailboxes.length) {
    const ids = plan.mailboxes.map((m) => m.id);
    const leads = (await db.query(`SELECT COUNT(*)::int AS n FROM campaign_leads WHERE mailbox_id = ANY($1::int[])`, [ids])).rows[0].n;
    if (leads) warnings.push(`${plural(leads, "campaign lead record")} sent from these mailboxes stay in the source workspace.`);
  }
  if (plan.target.id && plan.domains.length && !blocked.length) {
    try {
      const sum = await quota.usageSummary(target.id);
      for (const [key, adding] of [["domains", plan.domains.length], ["mailboxes", plan.mailboxes.length]]) {
        const lim = sum.find((s) => s.key === key);
        if (lim && lim.used + adding >= lim.limit) {
          const over = lim.used + adding > lim.limit;
          warnings.push(`${target.name} will be ${over ? "over" : "at"} its trial limit for ${key} after this (${lim.used + adding}/${lim.limit}). The assignment is not blocked.`);
        }
      }
    } catch (e) {
      console.error("Preview quota check failed:", e.message);
    }
  }
  return {
    workspace: { id: target.id, name: target.name, slug: target.slug },
    domains: plan.domains.map((d) => ({
      domain: d.domain,
      provider: normProvider(d.provider),
      provider_label: providerLabel(d.provider),
      workspace: { id: d.workspace_id, name: d.ws_name, slug: d.ws_slug },
      owner_email: d.owner_email || null,
      mailboxes: plan.mailboxes.filter((m) => m.domain_id === d.id && !m.is_deleted).map((m) => ({
        id: m.id,
        email: m.email,
        status: m.status,
        warmup_stage: m.warmup_stage,
        daily_limit: m.daily_limit,
        warmup_strategy_name: stratNameOf(plan, m.warmup_strategy_id),
      })),
    })),
    campaigns: plan.campaigns.map(publicCampaign),
    warmup: { preserved: true, strategies: plan.strategies.map((s) => ({ name: s.name, action: s.action })) },
    mailboxesMoving: plan.mailboxes.length,
    requiresConfirmation,
    warnings,
    blocked,
  };
}

// ---------------------------------------------------------------- list / detail
const escLike = (s) => String(s).replace(/[\\%_]/g, (m) => `\\${m}`);

async function decorate(rows) {
  if (!rows.length) return [];
  const domainIds = rows.map((r) => r.id);
  const wsIds = [...new Set(rows.map((r) => r.workspace_id).filter((x) => x != null))];
  const [mbs, owners, assigns] = await Promise.all([
    db.query(
      `SELECT domain_id, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'Active')::int AS active,
         warmup_stage, AVG(daily_limit)::float8 AS avg_limit, SUM(daily_limit)::float8 AS sum_limit
       FROM mailboxes WHERE domain_id = ANY($1::int[]) AND is_deleted = FALSE GROUP BY domain_id, warmup_stage`,
      [domainIds],
    ),
    db.query(
      `SELECT DISTINCT ON (wm.workspace_id) wm.workspace_id, u.id, u.email, u.first_name, u.last_name
       FROM workspace_members wm JOIN users u ON u.id = wm.user_id AND COALESCE(u.is_deleted, FALSE) = FALSE
       WHERE wm.workspace_id = ANY($1::int[]) AND wm.role = 'owner' ORDER BY wm.workspace_id, wm.created_at, u.id`,
      [wsIds],
    ),
    db.query(
      `SELECT DISTINCT ON (da.domain_id) da.domain_id, da.created_at, da.from_workspace_id, fw.name AS from_name, u.email AS by_email
       FROM domain_assignments da LEFT JOIN workspaces fw ON fw.id = da.from_workspace_id LEFT JOIN users u ON u.id = da.assigned_by
       WHERE da.domain_id = ANY($1::int[]) ORDER BY da.domain_id, da.created_at DESC, da.id DESC`,
      [domainIds],
    ),
  ]);
  const mbBy = new Map();
  for (const r of mbs.rows) {
    const m = mbBy.get(r.domain_id) || { total: 0, active: 0, stages: {}, sum: 0 };
    m.total += r.total;
    m.active += r.active;
    m.stages[r.warmup_stage] = (m.stages[r.warmup_stage] || 0) + r.total;
    m.sum += r.sum_limit || 0;
    mbBy.set(r.domain_id, m);
  }
  const ownerBy = new Map(owners.rows.map((r) => [r.workspace_id, r]));
  const asBy = new Map(assigns.rows.map((r) => [r.domain_id, r]));
  return rows.map((r) => {
    const m = mbBy.get(r.id) || { total: 0, active: 0, stages: {}, sum: 0 };
    const o = ownerBy.get(r.workspace_id);
    const a = asBy.get(r.id);
    return {
      id: r.id,
      domain: r.domain,
      provider: normProvider(r.provider),
      provider_label: providerLabel(r.provider),
      status: r.status,
      mailbox_count: m.total,
      active_mailbox_count: m.active,
      warmup: { stages: m.stages, avg_daily_limit: m.total ? Math.round(m.sum / m.total) : null },
      workspace: r.workspace_id ? { id: r.workspace_id, name: r.ws_name, slug: r.ws_slug, type: r.ws_type, status: r.ws_status } : null,
      owner: o ? { id: o.id, email: o.email, name: ownerName(o) } : null,
      assigned_at: a ? a.created_at : null,
      assigned_by_email: a ? a.by_email || null : null,
      previous_workspace: a && a.from_workspace_id ? { id: a.from_workspace_id, name: a.from_name } : null,
      created_at: r.created_at,
    };
  });
}

const DOMAIN_SELECT = `SELECT d.id, d.domain, d.provider, d.status, d.created_at, d.workspace_id,
    w.name AS ws_name, w.slug AS ws_slug, w.type AS ws_type, w.status AS ws_status
  FROM domains d LEFT JOIN workspaces w ON w.id = d.workspace_id`;

async function list(query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  const where = ["COALESCE(d.is_deleted, FALSE) = FALSE"];
  const params = [];
  const add = (v) => { params.push(v); return `$${params.length}`; };
  if (query.workspaceId) {
    const wid = Number(query.workspaceId);
    if (!Number.isInteger(wid) || wid < 1 || wid > 2147483647) throw new WorkspaceError("Workspace ID must be a number.", 400);
    where.push(`d.workspace_id = ${add(wid)}`);
  }
  if (query.provider) {
    const p = normProvider(query.provider);
    if (p === "ses") where.push(`LOWER(d.provider) IN ('ses', 'amazon ses')`);
    else where.push(`LOWER(d.provider) = ${add(p)}`);
  }
  if (query.status) where.push(`LOWER(d.status) = ${add(String(query.status).toLowerCase())}`);
  if (query.search && String(query.search).trim()) {
    const s = add(`%${escLike(String(query.search).trim().toLowerCase().slice(0, 200))}%`);
    where.push(`(LOWER(d.domain) LIKE ${s} OR LOWER(w.name) LIKE ${s} OR EXISTS (
      SELECT 1 FROM workspace_members wm JOIN users u ON u.id = wm.user_id
      WHERE wm.workspace_id = d.workspace_id AND wm.role = 'owner' AND LOWER(u.email) LIKE ${s}))`);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = (await db.query(`SELECT COUNT(*)::int AS n FROM domains d LEFT JOIN workspaces w ON w.id = d.workspace_id ${clause}`, params)).rows[0].n;
  const { rows } = await db.query(`${DOMAIN_SELECT} ${clause} ORDER BY d.domain, d.id LIMIT ${add(limit)} OFFSET ${add((page - 1) * limit)}`, params);
  return { items: await decorate(rows), total, page, limit };
}

async function get(idRaw) {
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id < 1 || id > 2147483647) throw new WorkspaceError("That domain could not be found.", 404);
  const { rows } = await db.query(`${DOMAIN_SELECT} WHERE d.id = $1 AND COALESCE(d.is_deleted, FALSE) = FALSE`, [id]);
  if (!rows[0]) throw new WorkspaceError("That domain could not be found.", 404);
  const [item] = await decorate(rows);
  const [mbs, hist] = await Promise.all([
    db.query(
      `SELECT m.id, m.email, m.status, m.provider, m.daily_limit, m.warmup_stage, s.name AS strategy_name
       FROM mailboxes m LEFT JOIN warmup_strategies s ON s.id = m.warmup_strategy_id
       WHERE m.domain_id = $1 AND m.is_deleted = FALSE ORDER BY m.id`,
      [id],
    ),
    db.query(
      `SELECT da.created_at, da.from_workspace_id, fw.name AS from_name, da.to_workspace_id, tw.name AS to_name, u.email AS by_email, da.notes
       FROM domain_assignments da LEFT JOIN workspaces fw ON fw.id = da.from_workspace_id
       LEFT JOIN workspaces tw ON tw.id = da.to_workspace_id LEFT JOIN users u ON u.id = da.assigned_by
       WHERE da.domain_id = $1 ORDER BY da.created_at DESC, da.id DESC`,
      [id],
    ),
  ]);
  return {
    ...item,
    mailboxes: mbs.rows.map((m) => ({
      id: m.id,
      email: m.email,
      status: m.status,
      provider: m.provider,
      provider_label: providerLabel(m.provider),
      daily_limit: m.daily_limit,
      warmup_stage: m.warmup_stage,
      warmup_strategy_name: m.strategy_name || null,
    })),
    history: hist.rows.map((h) => ({
      at: h.created_at,
      from_workspace: h.from_workspace_id ? { id: h.from_workspace_id, name: h.from_name } : null,
      to_workspace: { id: h.to_workspace_id, name: h.to_name },
      by_email: h.by_email || null,
      notes: h.notes || null,
    })),
  };
}

module.exports = {
  PLATFORM_SLUG, parseDomains, parseWorkspaceId, parseNotes, loadTarget, buildPlan, applyPlan, resultOf, afterAssign,
  blockedError, previewAssign, list, get, normProvider, providerLabel,
};
