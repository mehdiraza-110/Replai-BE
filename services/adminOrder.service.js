const db = require("../config/db.config");
const quota = require("./quota.service");
const eventLog = require("./eventLog.service");
const orderService = require("./order.service");
const systemMail = require("./systemMail.service");
const { WorkspaceError } = require("./workspace.service");

const STATUSES = ["requested", "approved", "in_progress", "fulfilled", "rejected", "cancelled"];
const TRANSITIONS = {
  requested: ["approved", "rejected"],
  approved: ["in_progress", "rejected", "cancelled"],
  in_progress: ["fulfilled", "rejected"],
  fulfilled: [],
  rejected: [],
  cancelled: [],
};
const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const label = (s) => String(s).replace("_", " ");

const ADMIN_SELECT = `${orderService.SELECT.replace("SELECT r.id,", "SELECT w.name AS ws_name, w.slug AS ws_slug, w.limits AS ws_limits, r.id,")}
  JOIN workspaces w ON w.id = r.workspace_id`;

function mapAdmin(r) {
  const out = { ...orderService.mapRow(r), workspace: { id: r.workspace_id, name: r.ws_name, slug: r.ws_slug } };
  if (r.type === "limits") {
    // Live value of the limit now vs what was asked for (the request itself keeps the value at request time).
    const d = r.details || {};
    const live = quota.limitFor(r.ws_limits, d.limitKey);
    out.limit_info = {
      key: d.limitKey,
      label: quota.LABELS[d.limitKey] || d.limitKey,
      current_limit: live ? live.limit : null,
      period: live ? live.period : d.period || null,
      requested_limit: d.requestedLimit,
    };
  }
  return out;
}

function intParam(v, what) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 2147483647) throw new WorkspaceError(`That ${what} could not be found.`, 404);
  return n;
}

async function audit(event) {
  try {
    await eventLog.record(event);
  } catch (e) {
    console.error("Order audit log failed:", e.message);
  }
}

const adminOrderService = {
  async list(query = {}) {
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
    const where = [];
    const params = [];
    if (query.status) {
      if (!STATUSES.includes(query.status)) throw new WorkspaceError(`Status must be one of: ${STATUSES.join(", ")}.`, 400);
      params.push(query.status);
      where.push(`r.status = $${params.length}`);
    }
    if (query.workspaceId) {
      const wid = Number(query.workspaceId);
      if (!Number.isInteger(wid) || wid < 1 || wid > 2147483647) throw new WorkspaceError("Workspace ID must be a number.", 400);
      params.push(wid);
      where.push(`r.workspace_id = $${params.length}`);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (await db.query(`SELECT COUNT(*)::int AS n FROM provisioning_requests r ${clause}`, params)).rows[0].n;
    const { rows } = await db.query(
      `${ADMIN_SELECT} ${clause} ORDER BY r.created_at DESC, r.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, (page - 1) * limit],
    );
    return { items: rows.map(mapAdmin), total, page, limit };
  },

  async count() {
    const { rows } = await db.query(
      `SELECT status, COUNT(*)::int AS n FROM provisioning_requests WHERE status IN ('requested','approved','in_progress') GROUP BY status`,
    );
    const out = { requested: 0, approved: 0, in_progress: 0 };
    rows.forEach((r) => { out[r.status] = r.n; });
    return out;
  },

  async get(idRaw) {
    const id = intParam(idRaw, "request");
    const { rows } = await db.query(`${ADMIN_SELECT} WHERE r.id = $1`, [id]);
    if (!rows[0]) throw new WorkspaceError("That request could not be found.", 404);
    return mapAdmin(rows[0]);
  },

  async update(adminId, idRaw, body = {}) {
    const id = intParam(idRaw, "request");
    const hasStatus = body.status !== undefined;
    const hasNotes = body.admin_notes !== undefined;
    if (!hasStatus && !hasNotes) throw new WorkspaceError("Nothing to update. Send a status and/or admin notes.", 400);
    if (hasStatus && !STATUSES.includes(body.status)) throw new WorkspaceError(`Status must be one of: ${STATUSES.join(", ")}.`, 400);
    let notes;
    if (hasNotes) {
      if (body.admin_notes !== null && typeof body.admin_notes !== "string") throw new WorkspaceError("Admin notes must be text.", 400);
      notes = body.admin_notes === null || !body.admin_notes.trim() ? null : body.admin_notes.trim();
      if (notes && notes.length > 2000) throw new WorkspaceError("Admin notes can be at most 2000 characters.", 400);
    }

    const client = await db.getClient();
    let before;
    let changedStatus = false;
    try {
      await client.query("BEGIN");
      const cur = await client.query(`SELECT id, workspace_id, status, type, quantity FROM provisioning_requests WHERE id = $1 FOR UPDATE`, [id]);
      before = cur.rows[0];
      if (!before) throw new WorkspaceError("That request could not be found.", 404);
      changedStatus = hasStatus && body.status !== before.status;
      if (hasStatus) {
        if (body.status === before.status) {
          throw new WorkspaceError(`This request is already ${label(before.status)}.`, 409);
        }
        if (!TRANSITIONS[before.status].includes(body.status)) {
          const allowed = TRANSITIONS[before.status];
          throw new WorkspaceError(
            allowed.length
              ? `A ${label(before.status)} request can't be moved to ${label(body.status)}. Allowed next steps: ${allowed.map(label).join(", ")}.`
              : `This request is ${label(before.status)} and can no longer be changed.`,
            409,
          );
        }
      }
      const sets = ["updated_at = NOW()", "handled_by = $2"];
      const params = [id, adminId];
      if (hasStatus) {
        params.push(body.status);
        sets.push(`status = $${params.length}`);
        if (body.status === "fulfilled") sets.push("fulfilled_at = NOW()");
      }
      if (hasNotes) {
        params.push(notes);
        sets.push(`admin_notes = $${params.length}`);
      }
      await client.query(`UPDATE provisioning_requests SET ${sets.join(", ")} WHERE id = $1`, params);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    if (changedStatus) {
      await audit({
        eventType: "order.status_changed",
        source: "admin",
        status: "Success",
        appWorkspaceId: before.workspace_id,
        createdBy: adminId,
        metadata: { orderId: id, type: before.type, quantity: before.quantity, from: before.status, to: body.status },
      });
    }
    const result = await this.get(id);
    if (changedStatus) systemMail.fire(() => systemMail.orderStatusChanged({ ...result, workspace_id: before.workspace_id, requested_by_id: result.requested_by && result.requested_by.id }, body.status));
    return result;
  },

  // Raises the workspace limit asked for in a "limits" order (keeps the period) and marks the order fulfilled.
  async applyLimits(adminId, idRaw, body = {}) {
    const id = intParam(idRaw, "request");
    let notes;
    if (body.admin_notes !== undefined && body.admin_notes !== null) {
      if (typeof body.admin_notes !== "string") throw new WorkspaceError("Admin notes must be text.", 400);
      notes = body.admin_notes.trim() || undefined;
      if (notes && notes.length > 2000) throw new WorkspaceError("Admin notes can be at most 2000 characters.", 400);
    }
    const client = await db.getClient();
    let order;
    let from;
    let to;
    let key;
    try {
      await client.query("BEGIN");
      const cur = await client.query(`SELECT id, workspace_id, status, type, details FROM provisioning_requests WHERE id = $1 FOR UPDATE`, [id]);
      order = cur.rows[0];
      if (!order) throw new WorkspaceError("That request could not be found.", 404);
      if (order.type !== "limits") throw new WorkspaceError("Only \"more limits\" requests can be applied this way.", 400);
      if (!["requested", "approved", "in_progress"].includes(order.status)) {
        throw new WorkspaceError(`This request is ${label(order.status)} and can no longer be applied.`, 409);
      }
      const d = order.details || {};
      key = d.limitKey;
      to = d.requestedLimit;
      if (!quota.KINDS.includes(key) || !Number.isInteger(to) || to < 1) throw new WorkspaceError("This request has no valid limit to apply.", 409);
      const ws = await client.query(`SELECT id, limits FROM workspaces WHERE id = $1 FOR UPDATE`, [order.workspace_id]);
      if (!ws.rows[0]) throw new WorkspaceError("That workspace could not be found.", 404);
      const limits = ws.rows[0].limits || {};
      const live = quota.limitFor(limits, key);
      if (!live) throw new WorkspaceError(`${quota.LABELS[key]} has no limit on this workspace any more, so there is nothing to raise.`, 409);
      from = live.limit;
      if (to <= from) {
        throw new WorkspaceError(`The ${quota.LABELS[key].toLowerCase()} limit is already ${from.toLocaleString("en-US")}, which is not below the requested ${to.toLocaleString("en-US")}. Mark the request fulfilled or rejected instead.`, 409);
      }
      const next = { ...limits, [key]: { ...(limits[key] || {}), limit: to, period: live.period } };
      await client.query(`UPDATE workspaces SET limits = $2::jsonb, updated_at = NOW() WHERE id = $1`, [order.workspace_id, JSON.stringify(next)]);
      const sets = ["status = 'fulfilled'", "fulfilled_at = NOW()", "updated_at = NOW()", "handled_by = $2"];
      const params = [id, adminId];
      if (notes !== undefined) {
        params.push(notes);
        sets.push(`admin_notes = $${params.length}`);
      }
      await client.query(`UPDATE provisioning_requests SET ${sets.join(", ")} WHERE id = $1`, params);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    await audit({
      eventType: "order.limits_applied",
      source: "admin",
      status: "Success",
      appWorkspaceId: order.workspace_id,
      createdBy: adminId,
      metadata: { orderId: id, limitKey: key, from, to, previousStatus: order.status },
    });
    const result = await this.get(id);
    systemMail.fire(() => systemMail.limitsApplied({ ...result, workspace_id: order.workspace_id, requested_by_id: result.requested_by && result.requested_by.id }, from, to));
    return result;
  },

  async assignDomains(adminId, workspaceIdRaw, body = {}) {
    const targetId = intParam(workspaceIdRaw, "workspace");
    if (!Array.isArray(body.domains) || body.domains.length === 0) throw new WorkspaceError("Provide the list of domains to assign.", 400);
    if (body.domains.length > 100) throw new WorkspaceError("You can assign at most 100 domains at a time.", 400);
    const names = [];
    for (const d of body.domains) {
      const v = typeof d === "string" ? d.trim().toLowerCase() : "";
      if (!DOMAIN_RE.test(v)) throw new WorkspaceError(`"${String(d).slice(0, 80)}" is not a valid domain name.`, 400);
      if (!names.includes(v)) names.push(v);
    }
    let orderId = null;
    if (body.orderId !== undefined && body.orderId !== null) {
      if (!Number.isInteger(body.orderId) || body.orderId < 1) throw new WorkspaceError("Order ID must be a number.", 400);
      orderId = body.orderId;
    }
    const confirmFromPlatform = body.confirmFromPlatform === true;

    const client = await db.getClient();
    let result;
    try {
      await client.query("BEGIN");
      const ws = await client.query(`SELECT id, name, slug FROM workspaces WHERE id = $1 AND is_deleted = FALSE FOR UPDATE`, [targetId]);
      if (!ws.rows[0]) throw new WorkspaceError("That workspace could not be found.", 404);
      const target = ws.rows[0];

      let order = null;
      if (orderId) {
        const o = await client.query(`SELECT id, status, workspace_id FROM provisioning_requests WHERE id = $1 FOR UPDATE`, [orderId]);
        if (!o.rows[0] || o.rows[0].workspace_id !== targetId) {
          throw new WorkspaceError("That order was not found for this workspace.", 404);
        }
        order = o.rows[0];
        if (order.status === "requested") throw new WorkspaceError("Approve this order first, then assign the domains.", 409);
        if (!["approved", "in_progress"].includes(order.status)) {
          throw new WorkspaceError(`This order is ${label(order.status)} and can't be worked on any more.`, 409);
        }
      }

      const dom = await client.query(
        `SELECT d.id, d.domain, d.workspace_id, w.slug AS ws_slug, w.name AS ws_name
         FROM domains d LEFT JOIN workspaces w ON w.id = d.workspace_id
         WHERE d.domain = ANY($1::text[]) AND COALESCE(d.is_deleted, FALSE) = FALSE
         ORDER BY d.id FOR UPDATE OF d`,
        [names],
      );
      const found = new Set(dom.rows.map((r) => r.domain));
      const missing = names.filter((n) => !found.has(n));
      if (missing.length) throw new WorkspaceError(`These domains don't exist: ${missing.join(", ")}.`, 404);
      const already = dom.rows.filter((r) => r.workspace_id === targetId).map((r) => r.domain);
      if (already.length) throw new WorkspaceError(`Already in ${target.name}: ${already.join(", ")}.`, 409);
      const fromKoval = dom.rows.filter((r) => r.ws_slug === "koval-group").map((r) => r.domain);
      if (fromKoval.length && !confirmFromPlatform) {
        throw new WorkspaceError(
          `Refusing to move ${fromKoval.join(", ")} out of the Koval Group workspace. Koval Group's live sending domains must not be moved by accident. If these domains were provisioned on the platform account and are meant for the client, resend with "confirmFromPlatform": true.`,
          409,
          "CONFIRM_FROM_PLATFORM_REQUIRED",
        );
      }

      const domainIds = dom.rows.map((r) => r.id);
      const mb = await client.query(
        `SELECT id, email, domain_id, workspace_id FROM mailboxes WHERE domain_id = ANY($1::int[]) ORDER BY id FOR UPDATE`,
        [domainIds],
      );
      const mailboxIds = mb.rows.map((r) => r.id);
      const mailboxEmails = mb.rows.map((r) => r.email.toLowerCase());
      const stray = mb.rows.filter((r) => r.workspace_id !== dom.rows.find((d) => d.id === r.domain_id).workspace_id);
      if (stray.length) {
        throw new WorkspaceError(`Mailbox ${stray[0].email} is not in the same workspace as its domain. Fix that data issue before assigning.`, 409);
      }
      const sourceIds = [...new Set(dom.rows.map((r) => r.workspace_id))];

      if (mailboxIds.length) {
        // Active or paused campaigns that list these mailboxes explicitly.
        const camps = await client.query(
          `SELECT id, name FROM campaigns WHERE is_deleted = FALSE AND workspace_id = ANY($1::int[])
             AND mailbox_mode = 'specific' AND mailbox_ids && $2::int[] LIMIT 5`,
          [sourceIds, mailboxIds],
        );
        if (camps.rows.length) {
          throw new WorkspaceError(
            `These mailboxes are selected in campaigns (${camps.rows.map((c) => `"${c.name}"`).join(", ")}). Stop or delete those campaigns before moving them.`,
            409,
          );
        }
        // Mailbox already used to send to campaign leads.
        const leads = await client.query(`SELECT COUNT(*)::int AS n FROM campaign_leads WHERE mailbox_id = ANY($1::int[])`, [mailboxIds]);
        if (leads.rows[0].n) {
          throw new WorkspaceError(
            `Some of these mailboxes have already sent campaign emails (${leads.rows[0].n} campaign lead records). Their history is tied to the current workspace's campaigns and can't be carried over safely.`,
            409,
          );
        }
        const msgs = await client.query(
          `SELECT COUNT(*)::int AS n FROM messages WHERE mailbox_id = ANY($1::int[]) AND (campaign_id IS NOT NULL OR campaign_lead_id IS NOT NULL)`,
          [mailboxIds],
        );
        if (msgs.rows[0].n) {
          throw new WorkspaceError(
            `Some of these mailboxes have campaign message history (${msgs.rows[0].n} messages) tied to the current workspace's campaigns, which can't be carried over safely.`,
            409,
          );
        }
        const drafts = await client.query(
          `SELECT COUNT(*)::int AS n FROM ai_response_drafts WHERE mailbox_id = ANY($1::int[]) AND (ai_agent_id IS NOT NULL OR integration_id IS NOT NULL)`,
          [mailboxIds],
        );
        if (drafts.rows[0].n) {
          throw new WorkspaceError(
            `Some of these mailboxes have AI reply drafts linked to the current workspace's agents (${drafts.rows[0].n} drafts), which can't be carried over safely.`,
            409,
          );
        }
        // Workflows of the source workspace that reference the mailboxes (trigger or send_reply nodes).
        const wfs = await client.query(`SELECT id, name, graph FROM workflows WHERE is_deleted = FALSE AND workspace_id = ANY($1::int[])`, [sourceIds]);
        const idSet = new Set(mailboxIds);
        const usedBy = wfs.rows.filter((w) =>
          ((w.graph && w.graph.nodes) || []).some((n) => {
            const d = n.data || {};
            const ids = [...(Array.isArray(d.mailboxIds) ? d.mailboxIds : []), ...(d.mailboxId != null ? [d.mailboxId] : [])];
            return ids.some((x) => idSet.has(Number(x)));
          }),
        );
        if (usedBy.length) {
          throw new WorkspaceError(
            `These mailboxes are used by automation workflows (${usedBy.slice(0, 5).map((w) => `"${w.name}"`).join(", ")}). Remove them from those workflows first.`,
            409,
          );
        }
      }

      // ---- all checks passed: move everything ----
      await client.query(`UPDATE domains SET workspace_id = $1, updated_at = NOW() WHERE id = ANY($2::int[])`, [targetId, domainIds]);
      let warmupStrategyId = null;
      if (mailboxIds.length) {
        const strat = await client.query(
          `SELECT id, start_daily_limit FROM warmup_strategies WHERE workspace_id = $1 AND is_deleted = FALSE ORDER BY id ASC LIMIT 1`,
          [targetId],
        );
        warmupStrategyId = strat.rows[0] ? strat.rows[0].id : null;
        // The old strategy belongs to the source workspace: reset to the target's default ramp (what Maildoso sync
        // does for new mailboxes) or to none when the target has no strategy yet (sync assigns one once it exists).
        await client.query(
          `UPDATE mailboxes SET workspace_id = $1, warmup_strategy_id = $2,
             daily_limit = COALESCE($3, daily_limit), warmup_stage = 'New',
             warmup_started_at = CASE WHEN $2::int IS NULL THEN NULL ELSE NOW() END,
             warmup_last_tick_at = NULL, warmup_last_action = NULL, updated_at = NOW()
           WHERE id = ANY($4::int[])`,
          [targetId, warmupStrategyId, strat.rows[0] ? strat.rows[0].start_daily_limit : null, mailboxIds],
        );
        await client.query(`UPDATE messages SET workspace_id = $1 WHERE mailbox_id = ANY($2::int[])`, [targetId, mailboxIds]);
        await client.query(`UPDATE ai_response_drafts SET workspace_id = $1 WHERE mailbox_id = ANY($2::int[])`, [targetId, mailboxIds]);
        await client.query(
          `UPDATE inbound_messages SET workspace_id = $1 WHERE workspace_id = ANY($2::int[]) AND LOWER(to_address) = ANY($3::text[])`,
          [targetId, sourceIds, mailboxEmails],
        );
      }
      let orderOut = null;
      if (order) {
        if (order.status === "approved") {
          await client.query(`UPDATE provisioning_requests SET status = 'in_progress', handled_by = $2, updated_at = NOW() WHERE id = $1`, [order.id, adminId]);
        } else {
          await client.query(`UPDATE provisioning_requests SET handled_by = $2, updated_at = NOW() WHERE id = $1`, [order.id, adminId]);
        }
        orderOut = { id: order.id, status: "in_progress", movedFromApproved: order.status === "approved" };
      }
      // Assigned domains/mailboxes count as the workspace's usage, but an admin assignment is never blocked by a limit.
      await quota.record(targetId, "domains", domainIds.length, { source: "admin_assign" }, client);
      if (mailboxIds.length) await quota.record(targetId, "mailboxes", mailboxIds.length, { source: "admin_assign" }, client);
      await client.query("COMMIT");
      result = {
        workspace: { id: target.id, name: target.name, slug: target.slug },
        domains: dom.rows.map((d) => ({
          id: d.id,
          domain: d.domain,
          from_workspace: { id: d.workspace_id, name: d.ws_name, slug: d.ws_slug },
          mailboxes: mb.rows.filter((m) => m.domain_id === d.id).map((m) => ({ id: m.id, email: m.email })),
        })),
        mailboxesMoved: mailboxIds.length,
        warmupStrategyId,
        order: orderOut,
      };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    if (result.order && result.order.movedFromApproved) {
      const oid = result.order.id;
      systemMail.fire(async () => {
        const o = await this.get(oid);
        await systemMail.orderStatusChanged({ ...o, workspace_id: targetId, requested_by_id: o.requested_by && o.requested_by.id }, "in_progress");
      });
    }
    if (result.order) delete result.order.movedFromApproved;
    await audit({
      eventType: "admin.domains_assigned",
      source: "admin",
      status: "Success",
      appWorkspaceId: targetId,
      createdBy: adminId,
      metadata: {
        orderId: orderId,
        domains: result.domains.map((d) => ({ domain: d.domain, fromWorkspaceId: d.from_workspace.id, mailboxes: d.mailboxes.length })),
        mailboxesMoved: result.mailboxesMoved,
        confirmFromPlatform,
      },
    });
    return result;
  },
};

module.exports = adminOrderService;
