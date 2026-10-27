const db = require("../config/db.config");
const { parseLeadsFile } = require("./leadFileParser");

const EMAIL_PATTERN = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const INSERT_CHUNK = 2000;
const EXPORT_BATCH = 2000;
const MAX_MANUAL_CONTACTS = 5000;
const MAX_ID_SELECTION = 10000;

const SORTS = {
  newest: "c.id DESC",
  oldest: "c.id ASC",
  email: "c.email ASC, c.id ASC",
  name: "COALESCE(NULLIF(c.full_name, ''), c.email) ASC, c.id ASC",
  company: "COALESCE(NULLIF(c.company, ''), '~') ASC, c.id ASC",
};

function fail(statusCode, message, code) {
  return Object.assign(new Error(message), { statusCode, code });
}

function clean(value, max) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str ? str.slice(0, max) : null;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function pageParams(page, limit, defaultLimit = 25, maxLimit = 100) {
  const pageNum = Math.max(1, Number.parseInt(page, 10) || 1);
  const limitNum = Math.min(Math.max(Number.parseInt(limit, 10) || defaultLimit, 1), maxLimit);
  return { pageNum, limitNum, offset: (pageNum - 1) * limitNum };
}

function pageResult(items, total, pageNum, limitNum) {
  return { items, page: pageNum, limit: limitNum, total, totalPages: Math.max(1, Math.ceil(total / limitNum)) };
}

function likeTerm(search) {
  const term = String(search || "").trim();
  if (!term) return null;
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function toIdArray(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map((id) => Number(id)).filter((id) => Number.isSafeInteger(id) && id > 0)));
}

/**
 * Turns a "which contacts" description into a SQL fragment over lead_contacts aliased `c`.
 * Selection is either an explicit id list, or a filter ("everything matching this search / list / status") with
 * optional exclusions, so "select all N results" works server-side without sending N ids.
 * Returns null when nothing is selected. Pushes bind values onto `params`.
 */
function selectionClause(selection, params) {
  const sel = selection || {};
  const ids = toIdArray(sel.ids);
  if (ids.length > MAX_ID_SELECTION) throw fail(400, `Select up to ${MAX_ID_SELECTION} leads by id, or use "select all results".`, "LEAD_SELECTION_TOO_LARGE");
  if (ids.length) {
    params.push(ids);
    return `c.id = ANY($${params.length}::bigint[])`;
  }
  if (!sel.filter || typeof sel.filter !== "object") return null;
  const conditions = filterConditions(sel.filter, params);
  const excluded = toIdArray(sel.excludeIds);
  if (excluded.length) {
    params.push(excluded);
    conditions.push(`NOT (c.id = ANY($${params.length}::bigint[]))`);
  }
  return conditions.length ? conditions.join(" AND ") : "TRUE";
}

function filterConditions(filter, params) {
  const conditions = [];
  const listId = Number(filter.listId);
  if (Number.isInteger(listId) && listId > 0) {
    params.push(listId);
    conditions.push(`c.list_id = $${params.length}`);
  }
  const like = likeTerm(filter.search);
  if (like) {
    params.push(like);
    const n = params.length;
    conditions.push(`(c.email ILIKE $${n} OR c.full_name ILIKE $${n} OR c.company ILIKE $${n} OR c.role ILIKE $${n})`);
  }
  const suppressed = `EXISTS (SELECT 1 FROM suppressions s WHERE s.workspace_id = c.workspace_id AND s.email = c.email)`;
  if (filter.status === "suppressed") conditions.push(suppressed);
  if (filter.status === "active") conditions.push(`NOT ${suppressed}`);
  return conditions;
}

function normalizeContact(input) {
  const isString = typeof input === "string";
  const email = normalizeEmail(isString ? input : input?.email);
  if (!email || !EMAIL_PATTERN.test(email) || email.length > 350) return null;
  if (isString) return { email, raw: {} };
  const firstName = clean(input.firstName, 120);
  const lastName = clean(input.lastName, 120);
  return {
    email,
    fullName: clean(input.fullName, 220) || ([firstName, lastName].filter(Boolean).join(" ") || null),
    firstName,
    lastName,
    company: clean(input.company, 220),
    role: clean(input.role, 180),
    phone: clean(input.phone, 60),
    location: clean(input.location, 220),
    website: clean(input.website, 300),
    linkedinUrl: clean(input.linkedinUrl, 400),
    raw: input.raw && typeof input.raw === "object" && !Array.isArray(input.raw) ? input.raw : {},
  };
}

/** Bulk insert in chunks; duplicates within a list are skipped. Returns the number of rows actually added. */
async function insertContacts(client, { workspaceId, listId, contacts, createdBy = null }) {
  let inserted = 0;
  for (let start = 0; start < contacts.length; start += INSERT_CHUNK) {
    const chunk = contacts.slice(start, start + INSERT_CHUNK);
    const { rowCount } = await client.query(
      `INSERT INTO lead_contacts (workspace_id, list_id, created_by, email, full_name, first_name, last_name, company, role, phone, location, website, linkedin_url, raw_data)
       SELECT $1::int, $2::int, $3::int, * FROM unnest(
         $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::text[], $14::jsonb[]
       )
       ON CONFLICT (list_id, email) DO NOTHING`,
      [
        workspaceId,
        listId,
        createdBy,
        chunk.map((c) => c.email),
        chunk.map((c) => c.fullName || null),
        chunk.map((c) => c.firstName || null),
        chunk.map((c) => c.lastName || null),
        chunk.map((c) => c.company || null),
        chunk.map((c) => c.role || null),
        chunk.map((c) => c.phone || null),
        chunk.map((c) => c.location || null),
        chunk.map((c) => c.website || null),
        chunk.map((c) => c.linkedinUrl || null),
        chunk.map((c) => JSON.stringify(c.raw || {})),
      ]
    );
    inserted += rowCount;
  }
  return inserted;
}

function mapList(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    contactCount: row.contact_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAddedAt: row.last_added_at ?? null,
  };
}

function mapContact(row) {
  return {
    id: Number(row.id),
    listId: row.list_id,
    listName: row.list_name,
    email: row.email,
    fullName: row.full_name,
    firstName: row.first_name,
    lastName: row.last_name,
    company: row.company,
    role: row.role,
    phone: row.phone,
    location: row.location,
    website: row.website,
    linkedinUrl: row.linkedin_url,
    raw: row.raw_data || {},
    status: row.suppression_reason ? "Suppressed" : "Active",
    suppressionReason: row.suppression_reason || null,
    campaignCount: row.campaign_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const CONTACT_SELECT = `
  c.*, l.name AS list_name,
  (SELECT s.reason FROM suppressions s WHERE s.workspace_id = c.workspace_id AND s.email = c.email LIMIT 1) AS suppression_reason,
  (SELECT COUNT(*)::int FROM campaign_leads cl WHERE cl.workspace_id = c.workspace_id AND cl.email = c.email) AS campaign_count`;

class LeadLibraryService {
  async getStats(workspaceId) {
    const [totals, suppressed] = await Promise.all([
      db.query(
        `SELECT
           (SELECT COUNT(*)::int FROM lead_lists WHERE workspace_id = $1) AS lists,
           (SELECT COUNT(*)::int FROM lead_contacts WHERE workspace_id = $1) AS contacts,
           (SELECT COUNT(DISTINCT email)::int FROM lead_contacts WHERE workspace_id = $1) AS unique_emails,
           (SELECT COUNT(*)::int FROM lead_contacts WHERE workspace_id = $1 AND created_at > NOW() - INTERVAL '7 days') AS added_last_7_days`,
        [workspaceId]
      ),
      db.query(
        `SELECT COUNT(*)::int AS count FROM lead_contacts c
         WHERE c.workspace_id = $1 AND EXISTS (SELECT 1 FROM suppressions s WHERE s.workspace_id = c.workspace_id AND s.email = c.email)`,
        [workspaceId]
      ),
    ]);
    const row = totals.rows[0];
    return {
      totalLists: row.lists,
      totalLeads: row.contacts,
      uniqueEmails: row.unique_emails,
      addedLast7Days: row.added_last_7_days,
      suppressed: suppressed.rows[0].count,
    };
  }

  // ---- Lists ---------------------------------------------------------------------------------------------------

  async listLists({ page, limit, search, workspaceId }) {
    const { pageNum, limitNum, offset } = pageParams(page, limit, 12, 100);
    const params = [workspaceId];
    const conditions = ["l.workspace_id = $1"];
    const like = likeTerm(search);
    if (like) {
      params.push(like);
      conditions.push(`l.name ILIKE $${params.length}`);
    }
    const where = conditions.join(" AND ");
    const [items, total] = await Promise.all([
      db.query(
        `SELECT l.*,
           (SELECT COUNT(*)::int FROM lead_contacts c WHERE c.list_id = l.id) AS contact_count,
           (SELECT MAX(c.created_at) FROM lead_contacts c WHERE c.list_id = l.id) AS last_added_at
         FROM lead_lists l WHERE ${where}
         ORDER BY l.created_at DESC, l.id DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limitNum, offset]
      ),
      db.query(`SELECT COUNT(*)::int AS count FROM lead_lists l WHERE ${where}`, params),
    ]);
    return pageResult(items.rows.map(mapList), total.rows[0].count, pageNum, limitNum);
  }

  async createList({ name, description, workspaceId, userId }) {
    const trimmed = clean(name, 160);
    if (!trimmed) throw fail(400, "Give the list a name.", "LEAD_LIST_NAME_REQUIRED");
    try {
      const { rows } = await db.query(
        `INSERT INTO lead_lists (workspace_id, name, description, created_by) VALUES ($1, $2, $3, $4) RETURNING *`,
        [workspaceId, trimmed, clean(description, 1000), userId]
      );
      return mapList({ ...rows[0], contact_count: 0 });
    } catch (error) {
      throw duplicateListName(error);
    }
  }

  async updateList(listId, { name, description, workspaceId }) {
    const trimmed = clean(name, 160);
    if (!trimmed) throw fail(400, "Give the list a name.", "LEAD_LIST_NAME_REQUIRED");
    try {
      const { rows } = await db.query(
        `UPDATE lead_lists SET name = $3, description = $4, updated_at = NOW() WHERE id = $1 AND workspace_id = $2 RETURNING *`,
        [Number(listId) || 0, workspaceId, trimmed, clean(description, 1000)]
      );
      if (!rows[0]) throw fail(404, "List not found.", "LEAD_LIST_NOT_FOUND");
      const count = await db.query(`SELECT COUNT(*)::int AS count FROM lead_contacts WHERE list_id = $1`, [rows[0].id]);
      return mapList({ ...rows[0], contact_count: count.rows[0].count });
    } catch (error) {
      throw duplicateListName(error);
    }
  }

  /** Deletes the list and its leads. Campaigns already created keep their own copies, so sending is unaffected. */
  async deleteList(listId, { workspaceId }) {
    const { rows } = await db.query(
      `DELETE FROM lead_lists WHERE id = $1 AND workspace_id = $2 RETURNING id, name`,
      [Number(listId) || 0, workspaceId]
    );
    if (!rows[0]) throw fail(404, "List not found.", "LEAD_LIST_NOT_FOUND");
    return rows[0];
  }

  async assertList(listId, workspaceId, client = db) {
    const { rows } = await client.query(`SELECT id, name FROM lead_lists WHERE id = $1 AND workspace_id = $2`, [Number(listId) || 0, workspaceId]);
    if (!rows[0]) throw fail(404, "List not found.", "LEAD_LIST_NOT_FOUND");
    return rows[0];
  }

  // ---- Leads ---------------------------------------------------------------------------------------------------

  async listContacts({ page, limit, search, listId, status, sort, workspaceId }) {
    const { pageNum, limitNum, offset } = pageParams(page, limit, 25, 100);
    const params = [workspaceId];
    const conditions = ["c.workspace_id = $1", ...filterConditions({ search, listId, status }, params)];
    const where = conditions.join(" AND ");
    const orderBy = SORTS[sort] || SORTS.newest;
    const [items, total] = await Promise.all([
      db.query(
        `SELECT ${CONTACT_SELECT}
         FROM lead_contacts c JOIN lead_lists l ON l.id = c.list_id
         WHERE ${where}
         ORDER BY ${orderBy}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limitNum, offset]
      ),
      db.query(`SELECT COUNT(*)::int AS count FROM lead_contacts c WHERE ${where}`, params),
    ]);
    return pageResult(items.rows.map(mapContact), total.rows[0].count, pageNum, limitNum);
  }

  async getContact(contactId, { workspaceId }) {
    const { rows } = await db.query(
      `SELECT ${CONTACT_SELECT} FROM lead_contacts c JOIN lead_lists l ON l.id = c.list_id WHERE c.id = $1 AND c.workspace_id = $2`,
      [Number(contactId) || 0, workspaceId]
    );
    if (!rows[0]) throw fail(404, "Lead not found.", "LEAD_NOT_FOUND");
    const contact = mapContact(rows[0]);
    const [campaigns, otherLists] = await Promise.all([
      db.query(
        `SELECT c.id, c.name, c.status AS campaign_status, cl.status AS lead_status, cl.sent_at
         FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id
         WHERE cl.workspace_id = $1 AND cl.email = $2
         ORDER BY cl.id DESC LIMIT 25`,
        [workspaceId, contact.email]
      ),
      db.query(
        `SELECT l.id, l.name FROM lead_contacts c JOIN lead_lists l ON l.id = c.list_id
         WHERE c.workspace_id = $1 AND c.email = $2 ORDER BY l.name LIMIT 25`,
        [workspaceId, contact.email]
      ),
    ]);
    return {
      ...contact,
      campaigns: campaigns.rows.map((row) => ({
        id: row.id,
        name: row.name,
        campaignStatus: row.campaign_status,
        leadStatus: row.lead_status,
        sentAt: row.sent_at,
      })),
      lists: otherLists.rows,
    };
  }

  async addContacts({ listId, contacts, emails, workspaceId, userId }) {
    await this.assertList(listId, workspaceId);
    const source = [
      ...(Array.isArray(contacts) ? contacts : []),
      ...(typeof emails === "string" ? emails.split(/[\s,;]+/).filter(Boolean) : Array.isArray(emails) ? emails : []),
    ];
    if (source.length === 0) throw fail(400, "Add at least one email address.", "LEAD_EMAIL_REQUIRED");
    if (source.length > MAX_MANUAL_CONTACTS) throw fail(400, `Add up to ${MAX_MANUAL_CONTACTS} leads at a time; use a file import for more.`, "LEAD_BATCH_TOO_LARGE");
    const seen = new Set();
    const valid = [];
    let invalid = 0;
    let duplicatesInInput = 0;
    for (const entry of source) {
      const contact = normalizeContact(entry);
      if (!contact) {
        invalid += 1;
      } else if (seen.has(contact.email)) {
        duplicatesInInput += 1;
      } else {
        seen.add(contact.email);
        valid.push(contact);
      }
    }
    if (valid.length === 0) throw fail(400, "None of those are valid email addresses.", "LEAD_EMAIL_INVALID");
    const client = await db.getClient();
    try {
      const added = await insertContacts(client, { workspaceId, listId: Number(listId), contacts: valid, createdBy: userId });
      return { added, invalid, duplicates: duplicatesInInput + (valid.length - added) };
    } finally {
      client.release();
    }
  }

  /** Parses an uploaded file on the server and stores it straight into a list (existing, or created from `newListName`). */
  async importFile({ buffer, fileName, listId, newListName, workspaceId, userId }) {
    const parsed = parseLeadsFile(buffer, fileName);
    if (parsed.validCount === 0) {
      throw fail(400, parsed.totalRows === 0 ? "That file has no rows." : "No valid email addresses were found in that file. Make sure it has an email column.", "LEAD_FILE_NO_EMAILS");
    }
    const client = await db.getClient();
    try {
      await client.query("BEGIN");
      let list;
      if (listId) {
        list = await this.assertList(listId, workspaceId, client);
      } else {
        const name = clean(newListName, 160) || clean(String(fileName || "").replace(/\.[^.]+$/, ""), 160) || "Imported leads";
        try {
          const { rows } = await client.query(
            `INSERT INTO lead_lists (workspace_id, name, created_by) VALUES ($1, $2, $3) RETURNING id, name`,
            [workspaceId, name, userId]
          );
          list = rows[0];
        } catch (error) {
          throw duplicateListName(error);
        }
      }
      const added = await insertContacts(client, { workspaceId, listId: list.id, contacts: parsed.leads, createdBy: userId });
      await client.query(`UPDATE lead_lists SET updated_at = NOW() WHERE id = $1`, [list.id]);
      await client.query("COMMIT");
      return {
        list,
        totalRows: parsed.totalRows,
        added,
        alreadyInList: parsed.validCount - added,
        invalid: parsed.invalidCount,
        duplicatesInFile: parsed.duplicateCount,
        headers: parsed.headers,
        fieldMap: parsed.fieldMap,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async updateContact(contactId, input, { workspaceId }) {
    const contact = normalizeContact({ ...input, email: input.email });
    if (!contact) throw fail(400, "Enter a valid email address.", "LEAD_EMAIL_INVALID");
    try {
      const { rows } = await db.query(
        `UPDATE lead_contacts SET email = $3, full_name = $4, first_name = $5, last_name = $6, company = $7, role = $8, phone = $9,
           location = $10, website = $11, linkedin_url = $12, updated_at = NOW()
         WHERE id = $1 AND workspace_id = $2 RETURNING id`,
        [
          Number(contactId) || 0, workspaceId, contact.email, contact.fullName, contact.firstName, contact.lastName,
          contact.company, contact.role, contact.phone, contact.location, contact.website, contact.linkedinUrl,
        ]
      );
      if (!rows[0]) throw fail(404, "Lead not found.", "LEAD_NOT_FOUND");
    } catch (error) {
      if (error.code === "23505") throw fail(409, "That email is already in this list.", "LEAD_DUPLICATE");
      throw error;
    }
    return this.getContact(contactId, { workspaceId });
  }

  async deleteContacts(selection, { workspaceId }) {
    const params = [workspaceId];
    const clause = selectionClause(selection, params);
    if (!clause) throw fail(400, "Select at least one lead.", "LEAD_SELECTION_EMPTY");
    const { rowCount } = await db.query(`DELETE FROM lead_contacts c WHERE c.workspace_id = $1 AND ${clause}`, params);
    return { deleted: rowCount };
  }

  async moveContacts(selection, { targetListId, mode, workspaceId }) {
    const target = await this.assertList(targetListId, workspaceId);
    const params = [workspaceId, target.id];
    const clause = selectionClause(selection, params);
    if (!clause) throw fail(400, "Select at least one lead.", "LEAD_SELECTION_EMPTY");
    const where = `c.workspace_id = $1 AND c.list_id <> $2 AND ${clause}`;
    const client = await db.getClient();
    try {
      await client.query("BEGIN");
      const copied = await client.query(
        `INSERT INTO lead_contacts (workspace_id, list_id, created_by, email, full_name, first_name, last_name, company, role, phone, location, website, linkedin_url, raw_data)
         SELECT c.workspace_id, $2, c.created_by, c.email, c.full_name, c.first_name, c.last_name, c.company, c.role, c.phone, c.location, c.website, c.linkedin_url, c.raw_data
         FROM lead_contacts c WHERE ${where}
         ON CONFLICT (list_id, email) DO NOTHING`,
        params
      );
      const matched = await client.query(`SELECT COUNT(*)::int AS count FROM lead_contacts c WHERE ${where}`, params);
      let removed = 0;
      if (mode === "move") {
        removed = (await client.query(`DELETE FROM lead_contacts c WHERE ${where}`, params)).rowCount;
      }
      await client.query(`UPDATE lead_lists SET updated_at = NOW() WHERE id = $1`, [target.id]);
      await client.query("COMMIT");
      return {
        list: target,
        mode: mode === "move" ? "move" : "copy",
        matched: matched.rows[0].count,
        added: copied.rowCount,
        alreadyInTarget: matched.rows[0].count - copied.rowCount,
        removedFromSource: removed,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * How many leads a campaign would get from library picks: lists and/or a lead selection, de-duplicated by email,
   * with anyone on the suppression list excluded.
   */
  async summarizeSelection({ listIds, contacts, workspaceId }) {
    const params = [workspaceId];
    const clause = librarySourceClause({ listIds, contacts }, params);
    if (!clause) return { leads: 0, uniqueEmails: 0, suppressed: 0, sendable: 0 };
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS leads,
              COUNT(DISTINCT c.email)::int AS unique_emails,
              COUNT(DISTINCT c.email) FILTER (WHERE EXISTS (SELECT 1 FROM suppressions s WHERE s.workspace_id = c.workspace_id AND s.email = c.email))::int AS suppressed
       FROM lead_contacts c WHERE c.workspace_id = $1 AND (${clause})`,
      params
    );
    const row = rows[0];
    return { leads: row.leads, uniqueEmails: row.unique_emails, suppressed: row.suppressed, sendable: row.unique_emails - row.suppressed };
  }

  /**
   * Used by campaign creation inside its transaction: copies the picked library leads into the campaign's send queue,
   * skipping suppressed addresses and anyone already queued (e.g. also present in an uploaded file). Returns rows added.
   */
  async copyIntoCampaign(client, { campaignId, workspaceId, listIds, contacts }) {
    const params = [campaignId, workspaceId];
    const clause = librarySourceClause({ listIds, contacts }, params);
    if (!clause) return 0;
    const { rowCount } = await client.query(
      `INSERT INTO campaign_leads (campaign_id, workspace_id, email, full_name, first_name, last_name, company, role, phone, raw_data)
       SELECT DISTINCT ON (c.email) $1::int, c.workspace_id, c.email, c.full_name, c.first_name, c.last_name, c.company, c.role, c.phone, c.raw_data
       FROM lead_contacts c
       WHERE c.workspace_id = $2 AND (${clause})
         AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.workspace_id = c.workspace_id AND s.email = c.email)
         AND NOT EXISTS (SELECT 1 FROM campaign_leads cl WHERE cl.campaign_id = $1 AND cl.email = c.email)
       ORDER BY c.email, c.id`,
      params
    );
    return rowCount;
  }

  /** "Also save these to my leads" on campaign creation: files the uploaded leads into a list inside the same transaction. */
  async saveToLibrary(client, { listId, newListName, leads, workspaceId, userId }) {
    let list;
    if (listId) {
      list = await this.assertList(listId, workspaceId, client);
    } else {
      const name = clean(newListName, 160);
      if (!name) throw fail(400, "Give the new lead list a name.", "LEAD_LIST_NAME_REQUIRED");
      try {
        const { rows } = await client.query(`INSERT INTO lead_lists (workspace_id, name, created_by) VALUES ($1, $2, $3) RETURNING id, name`, [workspaceId, name, userId]);
        list = rows[0];
      } catch (error) {
        throw duplicateListName(error);
      }
    }
    const contacts = leads.map(normalizeContact).filter(Boolean);
    const added = await insertContacts(client, { workspaceId, listId: list.id, contacts, createdBy: userId });
    return { list, added };
  }

  /** Streams a CSV of the leads matching the filters, in keyset-paged batches so large exports never hold everything in memory. */
  async streamCsv({ search, listId, status, workspaceId }, res) {
    const header = ["Email", "First name", "Last name", "Full name", "Company", "Role", "Phone", "Location", "Website", "LinkedIn", "List", "Status", "Added"];
    const write = (line) => (res.write(`${line}\n`) ? Promise.resolve() : new Promise((resolve) => res.once("drain", resolve)));
    await write(header.join(","));
    let lastId = 0;
    for (;;) {
      const params = [workspaceId];
      const conditions = ["c.workspace_id = $1", ...filterConditions({ search, listId, status }, params)];
      params.push(lastId);
      conditions.push(`c.id > $${params.length}`);
      params.push(EXPORT_BATCH);
      const { rows } = await db.query(
        `SELECT c.*, l.name AS list_name,
           (SELECT s.reason FROM suppressions s WHERE s.workspace_id = c.workspace_id AND s.email = c.email LIMIT 1) AS suppression_reason
         FROM lead_contacts c JOIN lead_lists l ON l.id = c.list_id
         WHERE ${conditions.join(" AND ")} ORDER BY c.id ASC LIMIT $${params.length}`,
        params
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        await write(
          [
            row.email, row.first_name, row.last_name, row.full_name, row.company, row.role, row.phone, row.location, row.website,
            row.linkedin_url, row.list_name, row.suppression_reason ? "Suppressed" : "Active", row.created_at ? new Date(row.created_at).toISOString() : "",
          ].map(csvCell).join(",")
        );
      }
      lastId = Number(rows[rows.length - 1].id);
      if (rows.length < EXPORT_BATCH) break;
    }
  }
}

/** SQL for "leads in these lists OR in this lead selection" (null when neither is given). */
function librarySourceClause({ listIds, contacts }, params) {
  const parts = [];
  const lists = toIdArray(listIds);
  if (lists.length) {
    params.push(lists);
    parts.push(`c.list_id = ANY($${params.length}::int[])`);
  }
  const selected = selectionClause(contacts, params);
  if (selected) parts.push(`(${selected})`);
  return parts.length ? parts.join(" OR ") : null;
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  let text = String(value);
  // Spreadsheet apps run cells that start with these characters as formulas.
  if (/^[=+\-@\t\r]/.test(text) && !EMAIL_PATTERN.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function duplicateListName(error) {
  if (error?.code === "23505") return fail(409, "You already have a list with that name.", "LEAD_LIST_NAME_TAKEN");
  return error;
}

module.exports = new LeadLibraryService();
