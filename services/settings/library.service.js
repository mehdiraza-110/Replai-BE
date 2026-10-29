const db = require("../../config/db.config");

const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const str = (v, max) => String(v ?? "").trim().slice(0, max);
const isUnique = (error) => error.code === "23505";

// ---- Email templates ------------------------------------------------------------------------------------------
const MERGE_KEYS = ["firstName", "lastName", "fullName", "company", "role", "email", "senderName"];
const unknownVariables = (text) => [...new Set([...String(text).matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)].map((m) => m[1]).filter((k) => !MERGE_KEYS.includes(k)))];

const templateShape = (r, userId) => ({ id: Number(r.id), name: r.name, subject: r.subject, body: r.body, shared: r.shared, mine: r.owner_user_id === userId, ownerName: r.owner_name ? r.owner_name.trim() : null, updatedAt: r.updated_at });

async function listTemplates(workspaceId, userId, { search = "" } = {}) {
  const params = [workspaceId, userId];
  let where = "t.workspace_id = $1 AND (t.shared OR t.owner_user_id = $2)";
  if (str(search, 100)) { params.push(`%${str(search, 100).replace(/[%_\\]/g, "\\$&")}%`); where += ` AND (t.name ILIKE $3 OR t.subject ILIKE $3)`; }
  const { rows } = await db.query(
    `SELECT t.*, NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') AS owner_name FROM email_templates t LEFT JOIN users u ON u.id = t.owner_user_id WHERE ${where} ORDER BY lower(t.name)`,
    params
  );
  return { items: rows.map((r) => templateShape(r, userId)), variables: MERGE_KEYS };
}

function templateFields(body, partial) {
  const out = {};
  if (!partial || body.name !== undefined) { const n = str(body.name, 160); if (!n) throw bad("Give the template a name."); out.name = n; }
  if (body.subject !== undefined) out.subject = str(body.subject, 400);
  if (body.body !== undefined) out.body = String(body.body).slice(0, 20000);
  if (body.shared !== undefined) { if (typeof body.shared !== "boolean") throw bad("Shared must be on or off."); out.shared = body.shared; }
  const unknown = unknownVariables(`${out.subject ?? ""} ${out.body ?? ""}`);
  if (unknown.length) throw bad(`These placeholders aren't supported: ${unknown.map((k) => `{{${k}}}`).join(", ")}. Use ${MERGE_KEYS.map((k) => `{{${k}}}`).join(", ")}.`);
  return out;
}

async function createTemplate(workspaceId, userId, body = {}) {
  const f = templateFields(body, false);
  try {
    const { rows } = await db.query(
      `INSERT INTO email_templates (workspace_id, owner_user_id, name, subject, body, shared) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [workspaceId, userId, f.name, f.subject ?? "", f.body ?? "", f.shared ?? true]
    );
    return templateShape(rows[0], userId);
  } catch (error) {
    if (isUnique(error)) throw bad("You already have a template with that name.", 409);
    throw error;
  }
}

async function updateTemplate(workspaceId, userId, id, body = {}, { canManage }) {
  const { rows: found } = await db.query(`SELECT owner_user_id FROM email_templates WHERE workspace_id = $1 AND id = $2`, [workspaceId, Number(id)]);
  if (!found[0]) throw bad("Template not found.", 404);
  if (found[0].owner_user_id !== userId && !canManage) throw bad("Only the person who made a template, or an admin, can change it.", 403);
  const f = templateFields(body, true);
  const keys = Object.keys(f);
  if (!keys.length) throw bad("Nothing to update.");
  try {
    const { rows } = await db.query(`UPDATE email_templates SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(", ")}, updated_at = NOW() WHERE workspace_id = $1 AND id = $2 RETURNING *`, [workspaceId, Number(id), ...keys.map((k) => f[k])]);
    return templateShape(rows[0], userId);
  } catch (error) {
    if (isUnique(error)) throw bad("You already have a template with that name.", 409);
    throw error;
  }
}

async function deleteTemplate(workspaceId, userId, id, { canManage }) {
  const { rows } = await db.query(`SELECT owner_user_id FROM email_templates WHERE workspace_id = $1 AND id = $2`, [workspaceId, Number(id)]);
  if (!rows[0]) throw bad("Template not found.", 404);
  if (rows[0].owner_user_id !== userId && !canManage) throw bad("Only the person who made a template, or an admin, can delete it.", 403);
  await db.query(`DELETE FROM email_templates WHERE id = $1`, [Number(id)]);
  return { deleted: true };
}

// ---- CRM custom fields ----------------------------------------------------------------------------------------
const ENTITIES = ["deal", "company"];
const FIELD_TYPES = ["text", "number", "date", "select", "checkbox"];
const MAX_FIELDS = 25;
const slug = (label) => str(label, 120).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
const fieldShape = (r) => ({ id: Number(r.id), entity: r.entity, key: r.key, label: r.label, type: r.field_type, options: r.options, position: r.position });

async function listFields(workspaceId, entity) {
  const params = [workspaceId];
  let where = "workspace_id = $1";
  if (entity) { if (!ENTITIES.includes(entity)) throw bad("Custom fields are available for deals and companies."); params.push(entity); where += " AND entity = $2"; }
  const { rows } = await db.query(`SELECT * FROM crm_custom_fields WHERE ${where} ORDER BY entity, position, id`, params);
  return rows.map(fieldShape);
}

function cleanOptions(type, options) {
  if (type !== "select") return [];
  if (!Array.isArray(options)) throw bad("Add at least one choice for a dropdown field.");
  const list = [...new Set(options.map((o) => str(o, 80)).filter(Boolean))];
  if (!list.length) throw bad("Add at least one choice for a dropdown field.");
  if (list.length > 30) throw bad("A dropdown can have at most 30 choices.");
  return list;
}

async function createField(workspaceId, body = {}) {
  if (!ENTITIES.includes(body.entity)) throw bad("Custom fields are available for deals and companies.");
  if (!FIELD_TYPES.includes(body.type)) throw bad("Pick a field type: text, number, date, dropdown or checkbox.");
  const label = str(body.label, 120);
  const key = slug(label);
  if (!label || !key) throw bad("Give the field a name.");
  const options = cleanOptions(body.type, body.options);
  const { rows: count } = await db.query(`SELECT COUNT(*)::int AS n FROM crm_custom_fields WHERE workspace_id = $1 AND entity = $2`, [workspaceId, body.entity]);
  if (count[0].n >= MAX_FIELDS) throw bad(`You can have at most ${MAX_FIELDS} custom fields per record type.`);
  try {
    const { rows } = await db.query(
      `INSERT INTO crm_custom_fields (workspace_id, entity, key, label, field_type, options, position) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING *`,
      [workspaceId, body.entity, key, label, body.type, JSON.stringify(options), count[0].n]
    );
    return fieldShape(rows[0]);
  } catch (error) {
    if (isUnique(error)) throw bad("A field with that name already exists.", 409);
    throw error;
  }
}

async function updateField(workspaceId, id, body = {}) {
  const { rows: found } = await db.query(`SELECT * FROM crm_custom_fields WHERE workspace_id = $1 AND id = $2`, [workspaceId, Number(id)]);
  if (!found[0]) throw bad("Field not found.", 404);
  const label = body.label !== undefined ? str(body.label, 120) : found[0].label;
  if (!label) throw bad("Give the field a name.");
  const options = body.options !== undefined ? cleanOptions(found[0].field_type, body.options) : found[0].options;
  const { rows } = await db.query(`UPDATE crm_custom_fields SET label = $3, options = $4::jsonb WHERE workspace_id = $1 AND id = $2 RETURNING *`, [workspaceId, Number(id), label, JSON.stringify(options)]);
  return fieldShape(rows[0]);
}

async function deleteField(workspaceId, id) {
  const { rows } = await db.query(`DELETE FROM crm_custom_fields WHERE workspace_id = $1 AND id = $2 RETURNING entity, key`, [workspaceId, Number(id)]);
  if (!rows[0]) throw bad("Field not found.", 404);
  const table = rows[0].entity === "deal" ? "crm_deals" : "crm_companies";
  await db.query(`UPDATE ${table} SET custom = custom - $2 WHERE workspace_id = $1`, [workspaceId, rows[0].key]);
  return { deleted: true };
}

/** Validates the custom values sent with a deal/company against its field definitions. Unknown keys are refused. */
async function cleanCustomValues(workspaceId, entity, input, current = {}) {
  if (input === undefined) return undefined;
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw bad("Custom fields must be an object.");
  const fields = await listFields(workspaceId, entity);
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
  const out = { ...current };
  for (const [key, raw] of Object.entries(input)) {
    const f = byKey[key];
    if (!f) throw bad(`There is no custom field called "${str(key, 40)}".`);
    if (raw === null || raw === "") { delete out[key]; continue; }
    if (f.type === "number") { const n = Number(raw); if (!Number.isFinite(n)) throw bad(`${f.label} must be a number.`); out[key] = n; }
    else if (f.type === "checkbox") { if (typeof raw !== "boolean") throw bad(`${f.label} must be yes or no.`); out[key] = raw; }
    else if (f.type === "date") { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw)) || Number.isNaN(new Date(`${raw}T00:00:00Z`).getTime())) throw bad(`${f.label} must be a date like 2026-12-31.`); out[key] = String(raw); }
    else if (f.type === "select") { if (!f.options.includes(raw)) throw bad(`${f.label} must be one of: ${f.options.join(", ")}.`); out[key] = raw; }
    else out[key] = str(raw, 1000);
  }
  return out;
}

// ---- Call & meeting outcomes ----------------------------------------------------------------------------------
const SYSTEM_OUTCOMES = [
  ["Answered", "call"], ["No answer", "call"], ["Busy", "call"], ["Left voicemail", "call"], ["Wrong number", "call"], ["Call failed", "call"],
  ["Held", "meeting"], ["No show", "meeting"], ["Rescheduled", "meeting"], ["Canceled", "meeting"],
];
const outcomeShape = (r) => ({ id: Number(r.id), name: r.name, group: r.group_name, system: r.is_system, position: r.position });

async function listOutcomes(workspaceId) {
  const { rows: have } = await db.query(`SELECT COUNT(*)::int AS n FROM crm_outcomes WHERE workspace_id = $1 AND is_system`, [workspaceId]);
  if (have[0].n < SYSTEM_OUTCOMES.length) {
    for (const [i, [name, group]] of SYSTEM_OUTCOMES.entries()) {
      await db.query(`INSERT INTO crm_outcomes (workspace_id, name, group_name, is_system, position) VALUES ($1,$2,$3,TRUE,$4) ON CONFLICT DO NOTHING`, [workspaceId, name, group, i]);
    }
  }
  const { rows } = await db.query(`SELECT * FROM crm_outcomes WHERE workspace_id = $1 ORDER BY group_name, position, id`, [workspaceId]);
  return rows.map(outcomeShape);
}

async function createOutcome(workspaceId, body = {}) {
  const name = str(body.name, 80);
  if (!name) throw bad("Give the outcome a name.");
  if (!["call", "meeting"].includes(body.group)) throw bad("An outcome belongs to either calls or meetings.");
  await listOutcomes(workspaceId);
  const { rows: pos } = await db.query(`SELECT COALESCE(MAX(position), 0) + 1 AS p FROM crm_outcomes WHERE workspace_id = $1 AND group_name = $2`, [workspaceId, body.group]);
  try {
    const { rows } = await db.query(`INSERT INTO crm_outcomes (workspace_id, name, group_name, position) VALUES ($1,$2,$3,$4) RETURNING *`, [workspaceId, name, body.group, pos[0].p]);
    return outcomeShape(rows[0]);
  } catch (error) {
    if (isUnique(error)) throw bad("That outcome already exists.", 409);
    throw error;
  }
}

async function updateOutcome(workspaceId, id, body = {}) {
  const { rows: found } = await db.query(`SELECT * FROM crm_outcomes WHERE workspace_id = $1 AND id = $2`, [workspaceId, Number(id)]);
  if (!found[0]) throw bad("Outcome not found.", 404);
  if (found[0].is_system) throw bad("Built-in outcomes can't be renamed.");
  const name = str(body.name, 80);
  if (!name) throw bad("Give the outcome a name.");
  try {
    const { rows } = await db.query(`UPDATE crm_outcomes SET name = $3 WHERE workspace_id = $1 AND id = $2 RETURNING *`, [workspaceId, Number(id), name]);
    await db.query(`UPDATE sdr_bookings SET outcome = $3 WHERE workspace_id = $1 AND outcome = $2`, [workspaceId, found[0].name, name]);
    return outcomeShape(rows[0]);
  } catch (error) {
    if (isUnique(error)) throw bad("That outcome already exists.", 409);
    throw error;
  }
}

async function deleteOutcome(workspaceId, id) {
  const { rows } = await db.query(`SELECT * FROM crm_outcomes WHERE workspace_id = $1 AND id = $2`, [workspaceId, Number(id)]);
  if (!rows[0]) throw bad("Outcome not found.", 404);
  if (rows[0].is_system) throw bad("Built-in outcomes can't be deleted.");
  await db.query(`DELETE FROM crm_outcomes WHERE id = $1`, [Number(id)]);
  await db.query(`UPDATE sdr_bookings SET outcome = NULL WHERE workspace_id = $1 AND outcome = $2`, [workspaceId, rows[0].name]);
  return { deleted: true };
}

// ---- Workspace snapshots --------------------------------------------------------------------------------------
const BUILT_IN = [
  {
    id: "builtin-cold-outreach", name: "Cold outreach starter", description: "Safe reply rules, two email templates and a 30-minute intro call. A good first setup for B2B outreach.",
    items: {
      rules: ["Never promise results, pricing or timelines that are not in the knowledge base.", "If the prospect asks to stop, apologise once and stop. Do not try to win them back.", "Keep replies under 120 words and end with one clear question or next step."],
      templates: [
        { name: "Intro email", subject: "Quick question, {{firstName}}", body: "Hi {{firstName}},\n\nI help teams like {{company}} get more qualified conversations without adding headcount. Worth a short chat this week?\n\n{{senderName}}" },
        { name: "Follow-up", subject: "Re: Quick question, {{firstName}}", body: "Hi {{firstName}},\n\nJust floating this back up in case it got buried. Happy to send a short summary instead if that's easier.\n\n{{senderName}}" },
      ],
      meetingTypes: [{ name: "Intro call", campaignType: "Direct", durationMinutes: 30, calendarTitle: "Intro call" }],
    },
  },
  {
    id: "builtin-agency", name: "Agency starter", description: "Rules and templates for a services agency booking discovery calls.",
    items: {
      rules: ["Do not quote prices. Offer a discovery call to scope the work.", "Never claim client names, case studies or certifications unless they are in the knowledge base.", "If they are not the right person, ask who is, in one sentence."],
      templates: [{ name: "Agency intro", subject: "Helping {{company}} grow", body: "Hi {{firstName}},\n\nWe work with companies like {{company}} on outbound and lead generation. If it would be useful, I can share how we would approach it in a 20-minute call.\n\n{{senderName}}" }],
      meetingTypes: [{ name: "Discovery call", campaignType: "Direct", durationMinutes: 30, calendarTitle: "Discovery call" }],
    },
  },
];
const countItems = (items) => ({ rules: items.rules?.length ?? 0, templates: items.templates?.length ?? 0, meetingTypes: items.meetingTypes?.length ?? 0, outcomes: items.outcomes?.length ?? 0, customFields: items.customFields?.length ?? 0, knowledgeBase: items.knowledgeBase ? 1 : 0 });
const snapshotShape = (r) => ({ id: String(r.id), name: r.name, description: r.description, version: r.version, builtIn: false, counts: countItems(r.items), updatedAt: r.updated_at });

async function listSnapshots(workspaceId) {
  const { rows } = await db.query(`SELECT * FROM workspace_snapshots WHERE workspace_id = $1 ORDER BY lower(name)`, [workspaceId]);
  return {
    builtIn: BUILT_IN.map((b) => ({ id: b.id, name: b.name, description: b.description, version: 1, builtIn: true, counts: countItems(b.items), updatedAt: null })),
    custom: rows.map(snapshotShape),
  };
}

/** Captures the workspace's current reusable configuration. Saving under an existing name replaces it and bumps the version. */
async function captureSnapshot(workspaceId, userId, body = {}) {
  const name = str(body.name, 160);
  if (!name) throw bad("Give the snapshot a name.");
  const [rules, kb, types, templates, outcomes, fields] = await Promise.all([
    db.query(`SELECT rule FROM sdr_rules WHERE workspace_id = $1 ORDER BY position, id`, [workspaceId]),
    db.query(`SELECT knowledge_base FROM sdr_settings WHERE workspace_id = $1`, [workspaceId]),
    db.query(`SELECT name, campaign_type, duration_minutes, calendar_title FROM meeting_types WHERE workspace_id = $1 ORDER BY id`, [workspaceId]),
    db.query(`SELECT name, subject, body FROM email_templates WHERE workspace_id = $1 AND shared ORDER BY lower(name)`, [workspaceId]),
    db.query(`SELECT name, group_name FROM crm_outcomes WHERE workspace_id = $1 AND NOT is_system ORDER BY id`, [workspaceId]),
    db.query(`SELECT entity, label, field_type, options FROM crm_custom_fields WHERE workspace_id = $1 ORDER BY id`, [workspaceId]),
  ]);
  const items = {
    rules: rules.rows.map((r) => r.rule),
    knowledgeBase: kb.rows[0]?.knowledge_base || "",
    meetingTypes: types.rows.map((t) => ({ name: t.name, campaignType: t.campaign_type, durationMinutes: t.duration_minutes, calendarTitle: t.calendar_title })),
    templates: templates.rows,
    outcomes: outcomes.rows.map((o) => ({ name: o.name, group: o.group_name })),
    customFields: fields.rows.map((f) => ({ entity: f.entity, label: f.label, type: f.field_type, options: f.options })),
  };
  const { rows } = await db.query(
    `INSERT INTO workspace_snapshots (workspace_id, name, description, items, created_by) VALUES ($1,$2,$3,$4::jsonb,$5)
     ON CONFLICT (workspace_id, lower(name)) DO UPDATE SET items = EXCLUDED.items, description = COALESCE(EXCLUDED.description, workspace_snapshots.description), version = workspace_snapshots.version + 1, updated_at = NOW()
     RETURNING *`,
    [workspaceId, name, str(body.description, 1000) || null, JSON.stringify(items), userId]
  );
  return snapshotShape(rows[0]);
}

async function deleteSnapshot(workspaceId, id) {
  const { rowCount } = await db.query(`DELETE FROM workspace_snapshots WHERE workspace_id = $1 AND id = $2`, [workspaceId, Number(id) || 0]);
  if (!rowCount) throw bad("Snapshot not found.", 404);
  return { deleted: true };
}

/** Adds what the snapshot has and the workspace lacks. Never deletes or overwrites; the knowledge base is only filled when empty. */
async function applySnapshot(workspaceId, userId, id) {
  let items;
  const builtIn = BUILT_IN.find((b) => b.id === id);
  if (builtIn) items = builtIn.items;
  else {
    const { rows } = await db.query(`SELECT items FROM workspace_snapshots WHERE workspace_id = $1 AND id = $2`, [workspaceId, Number(id) || 0]);
    if (!rows[0]) throw bad("Snapshot not found.", 404);
    items = rows[0].items;
  }
  const added = { rules: 0, templates: 0, meetingTypes: 0, outcomes: 0, customFields: 0, knowledgeBase: 0 };
  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    const { rows: existingRules } = await client.query(`SELECT lower(rule) AS r FROM sdr_rules WHERE workspace_id = $1`, [workspaceId]);
    const haveRules = new Set(existingRules.map((r) => r.r));
    let position = (await client.query(`SELECT COALESCE(MAX(position), 0) AS p FROM sdr_rules WHERE workspace_id = $1`, [workspaceId])).rows[0].p;
    for (const rule of items.rules || []) {
      if (haveRules.has(rule.toLowerCase())) continue;
      await client.query(`INSERT INTO sdr_rules (workspace_id, rule, position) VALUES ($1,$2,$3)`, [workspaceId, rule, ++position]);
      added.rules++;
    }
    for (const t of items.templates || []) {
      const r = await client.query(`INSERT INTO email_templates (workspace_id, owner_user_id, name, subject, body, shared) VALUES ($1,$2,$3,$4,$5,TRUE) ON CONFLICT DO NOTHING`, [workspaceId, userId, t.name, t.subject, t.body]);
      added.templates += r.rowCount;
    }
    for (const m of items.meetingTypes || []) {
      const r = await client.query(
        `INSERT INTO meeting_types (workspace_id, name, campaign_type, duration_minutes, calendar_title) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [workspaceId, m.name, m.campaignType || "Direct", m.durationMinutes || 30, m.calendarTitle || m.name]
      );
      added.meetingTypes += r.rowCount;
    }
    for (const o of items.outcomes || []) {
      const r = await client.query(`INSERT INTO crm_outcomes (workspace_id, name, group_name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [workspaceId, o.name, o.group]);
      added.outcomes += r.rowCount;
    }
    for (const f of items.customFields || []) {
      const r = await client.query(
        `INSERT INTO crm_custom_fields (workspace_id, entity, key, label, field_type, options) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING`,
        [workspaceId, f.entity, slug(f.label), f.label, f.type, JSON.stringify(f.options || [])]
      );
      added.customFields += r.rowCount;
    }
    if (items.knowledgeBase) {
      const r = await client.query(
        `INSERT INTO sdr_settings (workspace_id, knowledge_base) VALUES ($1,$2) ON CONFLICT (workspace_id) DO UPDATE SET knowledge_base = EXCLUDED.knowledge_base, updated_at = NOW() WHERE sdr_settings.knowledge_base = ''`,
        [workspaceId, items.knowledgeBase]
      );
      added.knowledgeBase += r.rowCount;
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { added };
}

module.exports = {
  MERGE_KEYS, listTemplates, createTemplate, updateTemplate, deleteTemplate,
  listFields, createField, updateField, deleteField, cleanCustomValues,
  listOutcomes, createOutcome, updateOutcome, deleteOutcome,
  listSnapshots, captureSnapshot, deleteSnapshot, applySnapshot, BUILT_IN,
};
