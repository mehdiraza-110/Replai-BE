const db = require("../config/db.config");
const { WorkspaceError } = require("./workspace.service");
const quota = require("./quota.service");

const OPEN = ["requested", "approved", "in_progress"];
const MAX_OPEN = 10;
const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const SELECT = `SELECT r.id, r.workspace_id, r.type, r.quantity, r.details, r.status, r.admin_notes, r.created_at, r.updated_at,
    r.fulfilled_at, r.requested_by AS requested_by_id, u.email AS req_email, u.first_name AS req_first, u.last_name AS req_last
  FROM provisioning_requests r LEFT JOIN users u ON u.id = r.requested_by`;

function mapRow(r) {
  return {
    id: r.id,
    type: r.type,
    quantity: r.quantity,
    details: r.details || {},
    status: r.status,
    admin_notes: r.admin_notes,
    created_at: r.created_at,
    updated_at: r.updated_at,
    fulfilled_at: r.fulfilled_at,
    requested_by: r.requested_by_id
      ? { id: r.requested_by_id, name: [r.req_first, r.req_last].filter(Boolean).join(" ") || r.req_email, email: r.req_email }
      : null,
  };
}

function parseId(v) {
  const id = Number(v);
  if (!Number.isInteger(id) || id < 1 || id > 2147483647) throw new WorkspaceError("That request could not be found.", 404);
  return id;
}

function isInt(v) {
  return typeof v === "number" && Number.isInteger(v);
}

// Returns a cleaned details object or throws a 400 with a specific message.
async function validateDetails(workspaceId, type, raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new WorkspaceError("Details must be an object.", 400);
  const out = {};
  if (raw.preferredDomains !== undefined) {
    if (!Array.isArray(raw.preferredDomains)) throw new WorkspaceError("Preferred domains must be a list.", 400);
    if (raw.preferredDomains.length > 50) throw new WorkspaceError("You can list at most 50 preferred domains.", 400);
    const seen = new Set();
    for (const d of raw.preferredDomains) {
      const v = typeof d === "string" ? d.trim().toLowerCase() : "";
      if (!DOMAIN_RE.test(v)) throw new WorkspaceError(`"${String(d).slice(0, 80)}" is not a valid domain name (example: yourbrand.com).`, 400);
      seen.add(v);
    }
    out.preferredDomains = [...seen];
  }
  if (raw.mailboxesPerDomain !== undefined) {
    if (!isInt(raw.mailboxesPerDomain) || raw.mailboxesPerDomain < 1 || raw.mailboxesPerDomain > 50) {
      throw new WorkspaceError("Mailboxes per domain must be a whole number between 1 and 50.", 400);
    }
    out.mailboxesPerDomain = raw.mailboxesPerDomain;
  }
  if (raw.mailboxNames !== undefined) {
    if (!Array.isArray(raw.mailboxNames)) throw new WorkspaceError("Mailbox names must be a list.", 400);
    if (raw.mailboxNames.length > 50) throw new WorkspaceError("You can list at most 50 mailbox names.", 400);
    out.mailboxNames = raw.mailboxNames.map((n) => {
      const v = typeof n === "string" ? n.trim().toLowerCase() : "";
      if (!NAME_RE.test(v)) {
        throw new WorkspaceError(`"${String(n).slice(0, 80)}" is not a valid mailbox name. Use letters, numbers, dots, dashes or underscores (for example "sam" or "sales.team").`, 400);
      }
      return v;
    });
  }
  if (raw.notes !== undefined && raw.notes !== null) {
    if (typeof raw.notes !== "string") throw new WorkspaceError("Notes must be text.", 400);
    if (raw.notes.length > 1000) throw new WorkspaceError("Notes can be at most 1000 characters.", 400);
    if (raw.notes.trim()) out.notes = raw.notes.trim();
  }
  if (raw.domainIds !== undefined) {
    if (!Array.isArray(raw.domainIds) || raw.domainIds.length > 500) throw new WorkspaceError("Domain IDs must be a list of at most 500 domains.", 400);
    if (!raw.domainIds.every((x) => isInt(x) && x > 0 && x <= 2147483647)) throw new WorkspaceError("Domain IDs must be whole numbers.", 400);
    const ids = [...new Set(raw.domainIds)];
    if (ids.length) {
      const { rows } = await db.query(
        `SELECT id FROM domains WHERE id = ANY($1::int[]) AND workspace_id = $2 AND COALESCE(is_deleted, FALSE) = FALSE`,
        [ids, workspaceId],
      );
      if (rows.length !== ids.length) throw new WorkspaceError("One or more selected domains don't belong to your workspace.", 400);
    }
    out.domainIds = ids;
  }
  return out;
}

const orderService = {
  OPEN,
  mapRow,
  parseId,
  SELECT,

  async list(workspaceId) {
    const { rows } = await db.query(`${SELECT} WHERE r.workspace_id = $1 ORDER BY r.created_at DESC, r.id DESC`, [workspaceId]);
    return rows.map(mapRow);
  },

  async get(workspaceId, idRaw) {
    const id = parseId(idRaw);
    const { rows } = await db.query(`${SELECT} WHERE r.id = $1 AND r.workspace_id = $2`, [id, workspaceId]);
    if (!rows[0]) throw new WorkspaceError("That request could not be found.", 404);
    return mapRow(rows[0]);
  },

  async create(workspaceId, userId, body = {}) {
    if (body.type !== "domains" && body.type !== "mailboxes") throw new WorkspaceError('Choose what you want to order: "domains" or "mailboxes".', 400);
    if (!isInt(body.quantity) || body.quantity < 1 || body.quantity > 500) {
      throw new WorkspaceError("Quantity must be a whole number between 1 and 500.", 400);
    }
    const details = await validateDetails(workspaceId, body.type, body.details);
    await quota.assertOrderQuantity(workspaceId, body.type, body.quantity);

    const client = await db.getClient();
    try {
      await client.query("BEGIN");
      // Serialise concurrent submissions of the same workspace so the open-request cap can't be raced.
      await client.query(`SELECT id FROM workspaces WHERE id = $1 FOR UPDATE`, [workspaceId]);
      const { rows: cnt } = await client.query(
        `SELECT COUNT(*)::int AS n FROM provisioning_requests WHERE workspace_id = $1 AND status = ANY($2)`,
        [workspaceId, OPEN],
      );
      if (cnt[0].n >= MAX_OPEN) {
        throw new WorkspaceError(`You already have ${MAX_OPEN} open requests. Wait for some to be completed or cancel one before sending another.`, 409);
      }
      const { rows } = await client.query(
        `INSERT INTO provisioning_requests (workspace_id, type, quantity, details, requested_by)
         VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id`,
        [workspaceId, body.type, body.quantity, JSON.stringify(details), userId],
      );
      await client.query("COMMIT");
      return this.get(workspaceId, rows[0].id);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  },

  async cancel(workspaceId, idRaw) {
    const id = parseId(idRaw);
    const { rows } = await db.query(
      `UPDATE provisioning_requests SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND workspace_id = $2 AND status IN ('requested','approved') RETURNING id`,
      [id, workspaceId],
    );
    if (!rows[0]) {
      const cur = await db.query(`SELECT status FROM provisioning_requests WHERE id = $1 AND workspace_id = $2`, [id, workspaceId]);
      if (!cur.rows[0]) throw new WorkspaceError("That request could not be found.", 404);
      throw new WorkspaceError(`This request is already ${cur.rows[0].status.replace("_", " ")} and can no longer be cancelled.`, 409);
    }
    return this.get(workspaceId, id);
  },
};

module.exports = orderService;
