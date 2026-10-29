const db = require("../config/db.config");
const library = require("./settings/library.service");

const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const STAGES = ["lead", "qualified", "meeting", "proposal", "won", "lost"];
const clean = (value, max) => (value == null ? "" : String(value).trim().slice(0, max));
const page = (q, def = 25) => {
  const p = Math.max(1, Number.parseInt(q.page, 10) || 1);
  const l = Math.min(Math.max(Number.parseInt(q.limit, 10) || def, 1), 100);
  return { page: p, limit: l, offset: (p - 1) * l };
};
const like = (term) => `%${clean(term, 200).replace(/[%_\\]/g, "\\$&")}%`;
const paged = (items, total, p) => ({ items, page: p.page, limit: p.limit, total, totalPages: Math.max(1, Math.ceil(total / p.limit)) });

async function assertMember(workspaceId, userId) {
  if (userId == null || userId === "") return null;
  const id = Number(userId);
  const { rowCount } = await db.query(`SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, id]);
  if (!rowCount) throw bad("That person is not a member of this workspace.");
  return id;
}

function parseDate(value, field) {
  if (value == null || value === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw bad(`${field} is not a valid date.`);
  return d;
}

// ---- Tasks ----------------------------------------------------------------------------------------------------
// crm_tasks.due_at is a plain TIMESTAMP that node reads and writes in the server's zone, so it round-trips unchanged.
const taskShape = (r) => ({
  id: Number(r.id),
  title: r.title,
  description: r.description,
  dueAt: r.due_at,
  overdue: r.status === "open" && r.due_at !== null && new Date(r.due_at) < new Date(),
  status: r.status,
  source: r.source,
  recordType: r.record_type,
  recordId: r.record_id,
  recordLabel: r.record_label,
  assigneeUserId: r.assignee_user_id,
  assigneeName: r.assignee_name ? r.assignee_name.trim() : null,
  createdAt: r.created_at,
  completedAt: r.completed_at,
});
const TASK_SELECT = `SELECT t.*, NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') AS assignee_name
  FROM crm_tasks t LEFT JOIN users u ON u.id = t.assignee_user_id`;

async function listTasks(workspaceId, q = {}) {
  const p = page(q);
  const where = ["t.workspace_id = $1"];
  const params = [workspaceId];
  const status = q.status === "done" ? "done" : q.status === "all" ? null : "open";
  if (status) { params.push(status); where.push(`t.status = $${params.length}`); }
  if (q.assignee === "me" && q.userId) { params.push(q.userId); where.push(`t.assignee_user_id = $${params.length}`); }
  else if (q.assignee === "none") where.push("t.assignee_user_id IS NULL");
  else if (Number(q.assignee)) { params.push(Number(q.assignee)); where.push(`t.assignee_user_id = $${params.length}`); }
  if (q.overdue === "1" || q.overdue === "true") where.push("t.status = 'open' AND t.due_at < NOW()");
  if (clean(q.search, 200)) { params.push(like(q.search)); where.push(`(t.title ILIKE $${params.length} OR t.record_label ILIKE $${params.length})`); }
  const order = { due: "t.due_at ASC NULLS LAST, t.id DESC", created: "t.id DESC", title: "lower(t.title) ASC, t.id DESC" }[q.sort] || "t.status ASC, t.due_at ASC NULLS LAST, t.id DESC";
  const whereSql = where.join(" AND ");
  const [rows, count, over] = await Promise.all([
    db.query(`${TASK_SELECT} WHERE ${whereSql} ORDER BY ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, p.limit, p.offset]),
    db.query(`SELECT COUNT(*)::int AS n FROM crm_tasks t WHERE ${whereSql}`, params),
    db.query(`SELECT COUNT(*)::int AS n FROM crm_tasks WHERE workspace_id = $1 AND status = 'open' AND due_at < NOW()`, [workspaceId]),
  ]);
  return { ...paged(rows.rows.map(taskShape), count.rows[0].n, p), overdueTotal: over.rows[0].n };
}

async function createTask(workspaceId, userId, body = {}) {
  const title = clean(body.title, 400);
  if (!title) throw bad("Give the task a title.");
  const due = parseDate(body.dueAt, "The due date");
  const assignee = await assertMember(workspaceId, body.assigneeUserId);
  const { rows } = await db.query(
    `INSERT INTO crm_tasks (workspace_id, title, description, due_at, assignee_user_id, record_type, record_id, record_label, created_by, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL) RETURNING id`,
    [workspaceId, title, clean(body.description, 4000) || null, due, assignee, clean(body.recordType, 40) || null, clean(body.recordId, 400) || null, clean(body.recordLabel, 300) || null, userId]
  );
  return getTask(workspaceId, rows[0].id);
}

async function getTask(workspaceId, id) {
  const { rows } = await db.query(`${TASK_SELECT} WHERE t.workspace_id = $1 AND t.id = $2`, [workspaceId, Number(id)]);
  if (!rows[0]) throw bad("Task not found.", 404);
  return taskShape(rows[0]);
}

async function updateTask(workspaceId, id, body = {}) {
  await getTask(workspaceId, id);
  const sets = [];
  const params = [workspaceId, Number(id)];
  const set = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (body.title !== undefined) { const t = clean(body.title, 400); if (!t) throw bad("Give the task a title."); set("title", t); }
  if (body.description !== undefined) set("description", clean(body.description, 4000) || null);
  if (body.dueAt !== undefined) set("due_at", parseDate(body.dueAt, "The due date"));
  if (body.assigneeUserId !== undefined) set("assignee_user_id", await assertMember(workspaceId, body.assigneeUserId));
  if (body.status !== undefined) {
    if (!["open", "done"].includes(body.status)) throw bad("Status must be open or done.");
    set("status", body.status);
    sets.push(body.status === "done" ? "completed_at = NOW()" : "completed_at = NULL");
  }
  if (!sets.length) return getTask(workspaceId, id);
  await db.query(`UPDATE crm_tasks SET ${sets.join(", ")} WHERE workspace_id = $1 AND id = $2`, params);
  return getTask(workspaceId, id);
}

async function deleteTask(workspaceId, id) {
  const { rowCount } = await db.query(`DELETE FROM crm_tasks WHERE workspace_id = $1 AND id = $2`, [workspaceId, Number(id)]);
  if (!rowCount) throw bad("Task not found.", 404);
  return { deleted: true };
}

// ---- Companies ------------------------------------------------------------------------------------------------
const companyShape = (r) => ({
  id: Number(r.id), name: r.name, website: r.website, industry: r.industry, size: r.size, location: r.location,
  custom: r.custom || {}, people: r.people ?? 0, deals: r.deals ?? 0, openDealValue: Number(r.open_value ?? 0), createdAt: r.created_at,
});

async function listCompanies(workspaceId, q = {}) {
  const p = page(q);
  const params = [workspaceId];
  let where = "c.workspace_id = $1";
  if (clean(q.search, 200)) { params.push(like(q.search)); where += ` AND (c.name ILIKE $2 OR c.industry ILIKE $2 OR c.website ILIKE $2)`; }
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT c.*,
         (SELECT COUNT(DISTINCT lower(lc.email))::int FROM lead_contacts lc WHERE lc.workspace_id = c.workspace_id AND lower(lc.company) = lower(c.name)) AS people,
         (SELECT COUNT(*)::int FROM crm_deals d WHERE d.company_id = c.id) AS deals,
         (SELECT COALESCE(SUM(d.value), 0) FROM crm_deals d WHERE d.company_id = c.id AND d.stage NOT IN ('won','lost')) AS open_value
       FROM crm_companies c WHERE ${where} ORDER BY lower(c.name) LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, p.limit, p.offset]
    ),
    db.query(`SELECT COUNT(*)::int AS n FROM crm_companies c WHERE ${where}`, params),
  ]);
  return paged(rows.rows.map(companyShape), count.rows[0].n, p);
}

function companyFields(body, requireName) {
  const name = clean(body.name, 220);
  if (requireName && !name) throw bad("Give the company a name.");
  return { name, website: clean(body.website, 300), industry: clean(body.industry, 160), size: clean(body.size, 60), location: clean(body.location, 220) };
}

async function createCompany(workspaceId, userId, body = {}) {
  const f = companyFields(body, true);
  const custom = (await library.cleanCustomValues(workspaceId, "company", body.custom)) ?? {};
  try {
    const { rows } = await db.query(
      `INSERT INTO crm_companies (workspace_id, name, website, industry, size, location, created_by, custom) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING *`,
      [workspaceId, f.name, f.website || null, f.industry || null, f.size || null, f.location || null, userId, JSON.stringify(custom)]
    );
    return companyShape(rows[0]);
  } catch (error) {
    if (error.code === "23505") throw bad("You already have a company with that name.", 409);
    throw error;
  }
}

async function updateCompany(workspaceId, id, body = {}) {
  const f = companyFields({ ...body, name: body.name ?? "x" }, false);
  const sets = [];
  const params = [workspaceId, Number(id)];
  const set = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (body.name !== undefined) { if (!f.name || body.name === "") throw bad("Give the company a name."); set("name", f.name); }
  for (const [key, col] of [["website", "website"], ["industry", "industry"], ["size", "size"], ["location", "location"]]) if (body[key] !== undefined) set(col, f[key] || null);
  if (body.custom !== undefined) {
    const { rows: cur } = await db.query(`SELECT custom FROM crm_companies WHERE workspace_id = $1 AND id = $2`, [workspaceId, Number(id)]);
    if (!cur[0]) throw bad("Company not found.", 404);
    set("custom", JSON.stringify(await library.cleanCustomValues(workspaceId, "company", body.custom, cur[0].custom)));
    sets[sets.length - 1] = `custom = $${params.length}::jsonb`;
  }
  if (!sets.length) throw bad("Nothing to update.");
  try {
    const { rows } = await db.query(`UPDATE crm_companies SET ${sets.join(", ")}, updated_at = NOW() WHERE workspace_id = $1 AND id = $2 RETURNING *`, params);
    if (!rows[0]) throw bad("Company not found.", 404);
    return companyShape(rows[0]);
  } catch (error) {
    if (error.code === "23505") throw bad("You already have a company with that name.", 409);
    throw error;
  }
}

async function deleteCompany(workspaceId, id) {
  const { rowCount } = await db.query(`DELETE FROM crm_companies WHERE workspace_id = $1 AND id = $2`, [workspaceId, Number(id)]);
  if (!rowCount) throw bad("Company not found.", 404);
  return { deleted: true };
}

// ---- Deals ----------------------------------------------------------------------------------------------------
const dealShape = (r) => ({
  id: Number(r.id), title: r.title, value: Number(r.value), stage: r.stage, companyId: r.company_id === null ? null : Number(r.company_id), companyName: r.company_name,
  personEmail: r.person_email, personName: r.person_name, ownerUserId: r.owner_user_id, ownerName: r.owner_name ? r.owner_name.trim() : null,
  expectedClose: r.expected_close_s, custom: r.custom || {}, createdAt: r.created_at, closedAt: r.closed_at,
});
// A DATE is read as text: node would turn it into local midnight and a UTC conversion would then land on the previous day.
const DEAL_SELECT = `SELECT d.*, to_char(d.expected_close, 'YYYY-MM-DD') AS expected_close_s, c.name AS company_name, NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') AS owner_name
  FROM crm_deals d LEFT JOIN crm_companies c ON c.id = d.company_id LEFT JOIN users u ON u.id = d.owner_user_id`;

async function listDeals(workspaceId, q = {}) {
  const params = [workspaceId];
  let where = "d.workspace_id = $1";
  if (STAGES.includes(q.stage)) { params.push(q.stage); where += ` AND d.stage = $${params.length}`; }
  if (clean(q.search, 200)) { params.push(like(q.search)); where += ` AND (d.title ILIKE $${params.length} OR d.person_name ILIKE $${params.length} OR d.person_email ILIKE $${params.length} OR c.name ILIKE $${params.length})`; }
  const [rows, totals] = await Promise.all([
    db.query(`${DEAL_SELECT} WHERE ${where} ORDER BY d.updated_at DESC, d.id DESC LIMIT 500`, params),
    db.query(`SELECT stage, COUNT(*)::int AS n, COALESCE(SUM(value), 0) AS value FROM crm_deals WHERE workspace_id = $1 GROUP BY stage`, [workspaceId]),
  ]);
  const byStage = Object.fromEntries(STAGES.map((s) => [s, { count: 0, value: 0 }]));
  for (const t of totals.rows) byStage[t.stage] = { count: t.n, value: Number(t.value) };
  const open = STAGES.filter((s) => s !== "won" && s !== "lost");
  return {
    items: rows.rows.map(dealShape),
    stages: STAGES,
    byStage,
    summary: { openValue: open.reduce((n, s) => n + byStage[s].value, 0), openCount: open.reduce((n, s) => n + byStage[s].count, 0), wonValue: byStage.won.value, wonCount: byStage.won.count },
  };
}

async function dealFields(workspaceId, body, partial) {
  const out = {};
  if (!partial || body.title !== undefined) { const t = clean(body.title, 300); if (!t) throw bad("Give the deal a title."); out.title = t; }
  if (body.value !== undefined) { const v = Number(body.value); if (!Number.isFinite(v) || v < 0 || v > 1e11) throw bad("The deal value must be a positive number."); out.value = v; }
  if (body.stage !== undefined) { if (!STAGES.includes(body.stage)) throw bad("Unknown deal stage."); out.stage = body.stage; }
  if (body.companyId !== undefined) {
    if (body.companyId === null || body.companyId === "") out.company_id = null;
    else {
      const { rowCount } = await db.query(`SELECT 1 FROM crm_companies WHERE workspace_id = $1 AND id = $2`, [workspaceId, Number(body.companyId)]);
      if (!rowCount) throw bad("That company does not exist.");
      out.company_id = Number(body.companyId);
    }
  }
  if (body.personEmail !== undefined) out.person_email = clean(body.personEmail, 350).toLowerCase() || null;
  if (body.personName !== undefined) out.person_name = clean(body.personName, 220) || null;
  if (body.ownerUserId !== undefined) out.owner_user_id = await assertMember(workspaceId, body.ownerUserId);
  if (body.expectedClose !== undefined) {
    const text = String(body.expectedClose ?? "").trim();
    if (!text) out.expected_close = null;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(new Date(`${text}T00:00:00Z`).getTime())) out.expected_close = text;
    else throw bad("The expected close date must look like 2026-12-31.");
  }
  return out;
}

async function createDeal(workspaceId, userId, body = {}) {
  const f = await dealFields(workspaceId, body, false);
  const custom = (await library.cleanCustomValues(workspaceId, "deal", body.custom)) ?? {};
  const stage = f.stage || "lead";
  const { rows } = await db.query(
    `INSERT INTO crm_deals (workspace_id, title, value, stage, company_id, person_email, person_name, owner_user_id, expected_close, created_by, closed_at, custom)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $11::boolean THEN NOW() END, $12::jsonb) RETURNING id`,
    [workspaceId, f.title, f.value ?? 0, stage, f.company_id ?? null, f.person_email ?? null, f.person_name ?? null, f.owner_user_id ?? userId, f.expected_close ?? null, userId, stage === "won" || stage === "lost", JSON.stringify(custom)]
  );
  return getDeal(workspaceId, rows[0].id);
}

async function getDeal(workspaceId, id) {
  const { rows } = await db.query(`${DEAL_SELECT} WHERE d.workspace_id = $1 AND d.id = $2`, [workspaceId, Number(id)]);
  if (!rows[0]) throw bad("Deal not found.", 404);
  return dealShape(rows[0]);
}

async function updateDeal(workspaceId, id, body = {}) {
  await getDeal(workspaceId, id);
  const f = await dealFields(workspaceId, body, true);
  if (body.custom !== undefined) {
    const { rows: cur } = await db.query(`SELECT custom FROM crm_deals WHERE workspace_id = $1 AND id = $2`, [workspaceId, Number(id)]);
    f.custom = JSON.stringify(await library.cleanCustomValues(workspaceId, "deal", body.custom, cur[0]?.custom));
  }
  const keys = Object.keys(f);
  if (!keys.length) return getDeal(workspaceId, id);
  const params = [workspaceId, Number(id), ...keys.map((k) => f[k])];
  const sets = keys.map((k, i) => `${k} = $${i + 3}${k === "custom" ? "::jsonb" : ""}`);
  if (f.stage) sets.push(f.stage === "won" || f.stage === "lost" ? "closed_at = COALESCE(closed_at, NOW())" : "closed_at = NULL");
  await db.query(`UPDATE crm_deals SET ${sets.join(", ")}, updated_at = NOW() WHERE workspace_id = $1 AND id = $2`, params);
  return getDeal(workspaceId, id);
}

async function deleteDeal(workspaceId, id) {
  const { rowCount } = await db.query(`DELETE FROM crm_deals WHERE workspace_id = $1 AND id = $2`, [workspaceId, Number(id)]);
  if (!rowCount) throw bad("Deal not found.", 404);
  return { deleted: true };
}

// ---- Notes ----------------------------------------------------------------------------------------------------
const noteShape = (r) => ({ id: Number(r.id), body: r.body, recordType: r.record_type, recordId: r.record_id, recordLabel: r.record_label, authorName: r.author_name ? r.author_name.trim() : null, authorUserId: r.author_user_id, createdAt: r.created_at });

async function listNotes(workspaceId, q = {}) {
  const p = page(q);
  const params = [workspaceId];
  let where = "n.workspace_id = $1";
  if (clean(q.search, 200)) { params.push(like(q.search)); where += ` AND (n.body ILIKE $${params.length} OR n.record_label ILIKE $${params.length})`; }
  const [rows, count] = await Promise.all([
    db.query(`SELECT n.*, NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') AS author_name FROM crm_notes n LEFT JOIN users u ON u.id = n.author_user_id WHERE ${where} ORDER BY n.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, p.limit, p.offset]),
    db.query(`SELECT COUNT(*)::int AS n FROM crm_notes n WHERE ${where}`, params),
  ]);
  return paged(rows.rows.map(noteShape), count.rows[0].n, p);
}

async function createNote(workspaceId, userId, body = {}) {
  const text = clean(body.body, 10000);
  if (!text) throw bad("Write something in the note.");
  const { rows } = await db.query(
    `INSERT INTO crm_notes (workspace_id, body, record_type, record_id, record_label, author_user_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [workspaceId, text, clean(body.recordType, 40) || null, clean(body.recordId, 400) || null, clean(body.recordLabel, 300) || null, userId]
  );
  const { rows: out } = await db.query(`SELECT n.*, NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') AS author_name FROM crm_notes n LEFT JOIN users u ON u.id = n.author_user_id WHERE n.id = $1`, [rows[0].id]);
  return noteShape(out[0]);
}

async function deleteNote(workspaceId, id) {
  const { rowCount } = await db.query(`DELETE FROM crm_notes WHERE workspace_id = $1 AND id = $2`, [workspaceId, Number(id)]);
  if (!rowCount) throw bad("Note not found.", 404);
  return { deleted: true };
}

// ---- People (lead library + campaign leads), Appointments, Scheduled messages, Lead submissions ----------------------------------
// A person is anyone in the Lead Library or on a campaign. The library row wins when an email is in both, so customers who only
// ever uploaded leads into campaigns (the old Leads pages) still see them here.
const PEOPLE_SOURCE = `(
  SELECT id, workspace_id, email, full_name, first_name, last_name, company, role, phone, location, created_at::timestamptz AS created_at, 0 AS src FROM lead_contacts
  UNION ALL
  SELECT id, workspace_id, email, full_name, first_name, last_name, company, role, phone, NULL::varchar AS location, created_at::timestamptz AS created_at, 1 AS src FROM campaign_leads
) lc`;

async function listPeople(workspaceId, q = {}) {
  const p = page(q);
  const params = [workspaceId];
  let where = "lc.workspace_id = $1";
  if (clean(q.search, 200)) { params.push(like(q.search)); where += ` AND (lc.email ILIKE $2 OR lc.full_name ILIKE $2 OR lc.company ILIKE $2 OR lc.role ILIKE $2)`; }
  const base = `SELECT DISTINCT ON (lower(lc.email)) lc.id, lc.email, COALESCE(NULLIF(lc.full_name, ''), NULLIF(TRIM(CONCAT(lc.first_name, ' ', lc.last_name)), '')) AS name,
      lc.company, lc.role, lc.phone, lc.location, lc.created_at FROM ${PEOPLE_SOURCE} WHERE ${where} ORDER BY lower(lc.email), lc.src, lc.id DESC`;
  const [rows, count] = await Promise.all([
    db.query(
      `WITH people AS (${base})
       SELECT p.*,
         (SELECT COUNT(DISTINCT cl.campaign_id)::int FROM campaign_leads cl WHERE cl.workspace_id = $1 AND lower(cl.email) = lower(p.email)) AS campaigns,
         EXISTS (SELECT 1 FROM messages m WHERE m.workspace_id = $1 AND m.direction = 'inbound' AND lower(m.from_address) = lower(p.email)) AS replied,
         (SELECT MAX(m.created_at) FROM messages m WHERE m.workspace_id = $1 AND m.direction = 'outbound' AND lower(m.to_address) = lower(p.email)) AS last_contacted
       FROM people p ORDER BY p.created_at DESC, p.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, p.limit, p.offset]
    ),
    db.query(`SELECT COUNT(DISTINCT lower(lc.email))::int AS n FROM ${PEOPLE_SOURCE} WHERE ${where}`, params),
  ]);
  const items = rows.rows.map((r) => ({ id: Number(r.id), email: r.email, name: r.name || r.email, company: r.company, role: r.role, phone: r.phone, location: r.location, campaigns: r.campaigns, replied: r.replied, lastContactedAt: r.last_contacted, createdAt: r.created_at }));
  return paged(items, count.rows[0].n, p);
}

async function listAppointments(workspaceId, q = {}) {
  const p = page(q);
  const when = q.when === "past" ? "b.scheduled_start < NOW()" : q.when === "all" ? "TRUE" : "b.scheduled_start >= NOW()";
  const order = q.when === "past" ? "DESC" : "ASC";
  const params = [workspaceId];
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT b.*, mt.name AS meeting_type, NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') AS handler_name
       FROM sdr_bookings b LEFT JOIN meeting_types mt ON mt.id = b.meeting_type_id LEFT JOIN users u ON u.id = b.handler_user_id
       WHERE b.workspace_id = $1 AND ${when} ORDER BY b.scheduled_start ${order} LIMIT $2 OFFSET $3`,
      [...params, p.limit, p.offset]
    ),
    db.query(`SELECT COUNT(*)::int AS n FROM sdr_bookings b WHERE b.workspace_id = $1 AND ${when}`, params),
  ]);
  const items = rows.rows.map((r) => ({ id: r.id, leadName: r.lead_name, leadEmail: r.lead_email, meetingType: r.meeting_type, handlerName: r.handler_name, start: r.scheduled_start, end: r.scheduled_end, meetLink: r.meet_link, status: r.status, outcome: r.outcome, mailboxId: r.mailbox_id, threadId: r.thread_id }));
  return paged(items, count.rows[0].n, p);
}

/** Records how a call or meeting went, chosen from the workspace's outcome list. Null clears it. */
async function updateAppointment(workspaceId, id, body = {}) {
  let outcome = null;
  if (body.outcome !== null && body.outcome !== undefined && body.outcome !== "") {
    const all = await library.listOutcomes(workspaceId);
    const hit = all.find((o) => o.name === String(body.outcome));
    if (!hit) throw bad("That isn't one of your outcomes.");
    outcome = hit.name;
  }
  const { rowCount } = await db.query(`UPDATE sdr_bookings SET outcome = $3 WHERE workspace_id = $1 AND id = $2`, [workspaceId, Number(id) || 0, outcome]);
  if (!rowCount) throw bad("Appointment not found.", 404);
  return { id: Number(id), outcome };
}

async function listScheduled(workspaceId, q = {}) {
  const p = page(q);
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT s.mailbox_id, s.thread_id, s.follow_up_at, s.followup_count, s.followup_by,
         (SELECT m.to_address FROM messages m WHERE m.workspace_id = s.workspace_id AND m.mailbox_id = s.mailbox_id AND m.thread_id = s.thread_id AND m.direction = 'outbound' ORDER BY m.id DESC LIMIT 1) AS prospect,
         (SELECT m.subject FROM messages m WHERE m.workspace_id = s.workspace_id AND m.mailbox_id = s.mailbox_id AND m.thread_id = s.thread_id ORDER BY m.id DESC LIMIT 1) AS subject
       FROM sdr_thread_state s WHERE s.workspace_id = $1 AND s.follow_up_at IS NOT NULL ORDER BY s.follow_up_at ASC LIMIT $2 OFFSET $3`,
      [workspaceId, p.limit, p.offset]
    ),
    db.query(`SELECT COUNT(*)::int AS n FROM sdr_thread_state WHERE workspace_id = $1 AND follow_up_at IS NOT NULL`, [workspaceId]),
  ]);
  const items = rows.rows.map((r) => ({ mailboxId: r.mailbox_id, threadId: r.thread_id, dueAt: r.follow_up_at, sentSoFar: r.followup_count, scheduledBy: r.followup_by, prospect: r.prospect, subject: r.subject }));
  return paged(items, count.rows[0].n, p);
}

async function listSubmissions(workspaceId, q = {}) {
  const p = page(q);
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT f.id, f.to_address, f.created_at, m.from_address, m.subject, m.mailbox_id, m.thread_id
       FROM sdr_forwards f LEFT JOIN messages m ON m.id = f.message_id WHERE f.workspace_id = $1 ORDER BY f.id DESC LIMIT $2 OFFSET $3`,
      [workspaceId, p.limit, p.offset]
    ),
    db.query(`SELECT COUNT(*)::int AS n FROM sdr_forwards WHERE workspace_id = $1`, [workspaceId]),
  ]);
  const items = rows.rows.map((r) => ({ id: r.id, prospect: r.from_address, subject: r.subject, forwardedTo: r.to_address, at: r.created_at, mailboxId: r.mailbox_id, threadId: r.thread_id }));
  return paged(items, count.rows[0].n, p);
}

async function listMembers(workspaceId) {
  const { rows } = await db.query(
    `SELECT u.id, NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') AS name, u.email FROM workspace_members wm JOIN users u ON u.id = wm.user_id AND COALESCE(u.is_deleted, FALSE) = FALSE WHERE wm.workspace_id = $1 ORDER BY lower(u.first_name), u.id`,
    [workspaceId]
  );
  return rows.map((r) => ({ id: r.id, name: r.name || r.email, email: r.email }));
}

module.exports = {
  STAGES, listTasks, createTask, updateTask, deleteTask, listCompanies, createCompany, updateCompany, deleteCompany,
  listDeals, createDeal, updateDeal, deleteDeal, listNotes, createNote, deleteNote, listPeople, listAppointments, updateAppointment, listScheduled, listSubmissions, listMembers,
};
