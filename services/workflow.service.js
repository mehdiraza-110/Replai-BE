const db = require("../config/db.config");
const quota = require("./quota.service");
const executor = require("./workflowExecutor.service");

const MAX_NODES = 50;
const MAX_EDGES = 100;

class WorkflowError extends Error {
  constructor(message, status = 400, problems = null) {
    super(message);
    this.status = status;
    this.problems = problems;
  }
}

const isTrigger = (type) => String(type).startsWith("trigger.");

// ---------------------------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------------------------

const SUMMARY_SELECT = `
  w.id, w.name, w.description, w.is_active, w.updated_at,
  jsonb_array_length(COALESCE(w.graph->'nodes', '[]'::jsonb)) AS node_count,
  (SELECT n->>'type' FROM jsonb_array_elements(COALESCE(w.graph->'nodes', '[]'::jsonb)) n
     WHERE n->>'type' LIKE 'trigger.%' LIMIT 1) AS trigger_type,
  (SELECT n->'data' FROM jsonb_array_elements(COALESCE(w.graph->'nodes', '[]'::jsonb)) n
     WHERE n->>'type' LIKE 'trigger.%' LIMIT 1) AS trigger_data,
  (SELECT jsonb_build_object('status', r.status, 'started_at', r.started_at)
     FROM workflow_runs r WHERE r.workflow_id = w.id AND r.workspace_id = w.workspace_id AND r.dry_run = FALSE
     ORDER BY r.started_at DESC, r.id DESC LIMIT 1) AS last_run`;

async function list(workspaceId) {
  const { rows } = await db.query(
    `SELECT ${SUMMARY_SELECT} FROM workflows w WHERE w.workspace_id = $1 AND w.is_deleted = FALSE ORDER BY w.updated_at DESC, w.id DESC`,
    [workspaceId]
  );
  return rows.map(mapSummary);
}

async function get(workspaceId, id) {
  const { rows } = await db.query(
    `SELECT ${SUMMARY_SELECT}, w.graph FROM workflows w WHERE w.id = $1 AND w.workspace_id = $2 AND w.is_deleted = FALSE`,
    [id, workspaceId]
  );
  if (!rows[0]) throw new WorkflowError("Workflow not found.", 404);
  return { ...mapSummary(rows[0]), graph: rows[0].graph };
}

/** "all" | "specific" | null (no trigger). A missing/"all" filter value means every campaign/mailbox. */
function triggerScope(type, data) {
  if (!type) return null;
  return scopeList(type, data) === "all" ? "all" : "specific";
}

const FILTER_KEY = { "trigger.plusvibe_reply": "campaignIds", "trigger.inbox_mail": "mailboxIds", "trigger.mail_sent": "mailboxIds" };

/** "all" or an array of string ids, read from a trigger node's data. */
function scopeList(type, data) {
  const value = (data || {})[FILTER_KEY[type]];
  if (Array.isArray(value)) return value.map(String);
  return "all";
}

function mapSummary(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    is_active: row.is_active,
    node_count: Number(row.node_count) || 0,
    trigger_type: row.trigger_type || null,
    trigger_scope: triggerScope(row.trigger_type, row.trigger_data),
    updated_at: row.updated_at,
    last_run: row.last_run || null,
  };
}

async function meta(workspaceId) {
  const [mailboxes, agents, integration, campaigns, coldCampaigns, calendars] = await Promise.all([
    db.query(`SELECT id, email FROM mailboxes WHERE workspace_id = $1 AND is_deleted = FALSE ORDER BY email`, [workspaceId]),
    db.query(`SELECT id, name FROM ai_agents WHERE workspace_id = $1 AND is_deleted = FALSE ORDER BY name`, [workspaceId]),
    hasPlusVibe(workspaceId),
    db.query(`SELECT plusvibe_campaign_id AS id, name, assigned_ai_agent_id AS "agentId" FROM plusvibe_campaigns WHERE workspace_id = $1 AND is_deleted = FALSE ORDER BY name`, [workspaceId]),
    db.query(`SELECT id, name, ai_agent_id AS "agentId" FROM campaigns WHERE workspace_id = $1 AND is_deleted = FALSE AND is_warmup = FALSE ORDER BY name`, [workspaceId]),
    db.query(`SELECT DISTINCT ai_agent_id FROM calendar_connections WHERE workspace_id = $1 AND provider = 'google' AND status = 'connected' ORDER BY ai_agent_id`, [workspaceId]),
  ]);
  return {
    mailboxes: mailboxes.rows,
    agents: agents.rows,
    plusvibeConnected: integration,
    plusvibeCampaigns: campaigns.rows,
    campaigns: coldCampaigns.rows,
    calendarAgentIds: calendars.rows.map((r) => r.ai_agent_id),
    triggers: executor.describeTriggerTypes(),
  };
}

async function hasPlusVibe(workspaceId) {
  const { rows } = await db.query(`SELECT 1 FROM plusvibe_integrations WHERE app_workspace_id = $1 AND is_deleted = FALSE LIMIT 1`, [workspaceId]);
  return rows.length > 0;
}

async function listRuns(workspaceId, id, limit) {
  await get(workspaceId, id); // 404 for another workspace's workflow
  const n = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 100);
  const { rows } = await db.query(
    `SELECT id, workflow_id, trigger_type, status, dry_run, steps, error, started_at, finished_at
     FROM workflow_runs WHERE workflow_id = $1 AND workspace_id = $2 ORDER BY started_at DESC, id DESC LIMIT $3`,
    [id, workspaceId, n]
  );
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------------------------

function cleanName(value) {
  const name = String(value ?? "").trim();
  if (!name) throw new WorkflowError("Give the workflow a name.");
  if (name.length > 180) throw new WorkflowError("The workflow name must be 180 characters or fewer.");
  return name;
}

function defaultReplyGraph() {
  return {
    nodes: [
      { id: "trigger", type: "trigger.inbox_mail", position: { x: 60, y: 160 }, data: { mailboxIds: "all" } },
      { id: "save", type: "action.save_to_db", position: { x: 360, y: 160 }, data: {} },
      { id: "agent", type: "action.ai_agent", position: { x: 660, y: 160 }, data: { mode: "review" } },
      { id: "send", type: "action.send_reply", position: { x: 960, y: 160 }, data: { via: "mailbox" } },
    ],
    edges: [
      { id: "e-trigger-save", source: "trigger", target: "save" },
      { id: "e-save-agent", source: "save", target: "agent" },
      { id: "e-agent-send", source: "agent", target: "send" },
    ],
  };
}

const TEMPLATES = ["default_reply", "book_meetings"];

/**
 * "Book meetings": every reply either picks one of the times offered earlier (-> book it, confirm with the Meet link) or
 * gets new times offered. A time that turns out to be taken goes back to offering times, with an apology.
 * Agents are "the campaign's agent" so it works out of the box for campaigns that have an agent assigned.
 */
function bookMeetingsGraph({ trigger = "inbox_mail", mode = "review" } = {}) {
  const plusvibe = trigger === "plusvibe_reply";
  const aiMode = ["auto_send", "review", "agent_default"].includes(mode) ? mode : "review";
  const node = (id, type, x, y, data = {}) => ({ id, type, position: { x, y }, data });
  const send = plusvibe ? { via: "plusvibe" } : { via: "mailbox" };
  return {
    nodes: [
      node("trigger", plusvibe ? "trigger.plusvibe_reply" : "trigger.inbox_mail", 40, 220, plusvibe ? { campaignIds: "all" } : { mailboxIds: "all" }),
      node("save", "action.save_to_db", 320, 220),
      node("selected", "condition.slot_selected", 600, 220),
      node("book", "action.book_meeting", 900, 80, { agentId: "campaign" }),
      node("ai-booked", "action.ai_agent", 1200, 20, { agentId: "campaign", mode: aiMode }),
      node("send-booked", "action.send_reply", 1500, 20, send),
      node("offer", "action.offer_times", 1200, 360, { agentId: "campaign", count: 3 }),
      node("ai-offer", "action.ai_agent", 1500, 360, { agentId: "campaign", mode: aiMode }),
      node("send-offer", "action.send_reply", 1800, 360, send),
    ],
    edges: [
      { id: "e-trigger-save", source: "trigger", target: "save" },
      { id: "e-save-selected", source: "save", target: "selected" },
      { id: "e-selected-book", source: "selected", target: "book", sourceHandle: "yes" },
      { id: "e-selected-offer", source: "selected", target: "offer", sourceHandle: "no" },
      { id: "e-book-ai-booked", source: "book", target: "ai-booked", sourceHandle: "booked" },
      { id: "e-book-offer", source: "book", target: "offer", sourceHandle: "unavailable" },
      { id: "e-ai-booked-send", source: "ai-booked", target: "send-booked" },
      { id: "e-offer-ai", source: "offer", target: "ai-offer" },
      { id: "e-ai-offer-send", source: "ai-offer", target: "send-offer" },
    ],
  };
}

async function create(workspaceId, userId, { name, description, template, trigger, mode } = {}) {
  if (template !== undefined && template !== null && !TEMPLATES.includes(template)) throw new WorkflowError('Unknown template. Use "default_reply", "book_meetings" or leave it out.');
  if (trigger !== undefined && trigger !== null && trigger !== "inbox_mail" && trigger !== "plusvibe_reply") throw new WorkflowError('The trigger must be "inbox_mail" or "plusvibe_reply".');
  if (mode !== undefined && mode !== null && !["auto_send", "review", "agent_default"].includes(mode)) throw new WorkflowError('The reply mode must be "auto_send", "review" or "agent_default".');
  const graph = template === "default_reply" ? defaultReplyGraph() : template === "book_meetings" ? bookMeetingsGraph({ trigger: trigger || "inbox_mail", mode: mode || "review" }) : { nodes: [], edges: [] };
  // The limit check and the insert share one transaction under the workspace's quota lock, so parallel creates can't overshoot.
  const client = await db.getClient();
  let id;
  try {
    await client.query("BEGIN");
    await quota.lock(client, workspaceId);
    await quota.check(workspaceId, "workflows", 1, client);
    const { rows } = await client.query(
      `INSERT INTO workflows (workspace_id, name, description, graph, created_by) VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id`,
      [workspaceId, cleanName(name), description ? String(description).slice(0, 2000) : null, JSON.stringify(graph), userId || null]
    );
    await client.query("COMMIT");
    id = rows[0].id;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return get(workspaceId, id);
}

/**
 * `draft: true` skips the semantic checks (agents/mailboxes/wiring) so the builder can autosave an unfinished
 * INACTIVE graph; the shape of the graph is still enforced. Activating always runs the full validation.
 */
async function update(workspaceId, id, body = {}, { draft = false } = {}) {
  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    // Serialise activation changes per workspace so two requests cannot both activate the same trigger type.
    await client.query(`SELECT pg_advisory_xact_lock(7001, $1)`, [workspaceId]);
    const { rows } = await client.query(`SELECT * FROM workflows WHERE id = $1 AND workspace_id = $2 AND is_deleted = FALSE FOR UPDATE`, [id, workspaceId]);
    const current = rows[0];
    if (!current) throw new WorkflowError("Workflow not found.", 404);

    const name = body.name !== undefined ? cleanName(body.name) : current.name;
    const description = body.description !== undefined ? (body.description ? String(body.description).slice(0, 2000) : null) : current.description;
    const isActive = body.is_active !== undefined ? Boolean(body.is_active) : current.is_active;
    let graph = current.graph;

    if (body.graph !== undefined) {
      const shape = checkShape(body.graph);
      if (shape.problems.length) throw new WorkflowError("This workflow has problems. Fix them and save again.", 400, shape.problems);
      graph = shape.graph;
    }

    if (body.graph !== undefined || (isActive && !current.is_active)) {
      const semantic = draft && !isActive ? [] : await validateGraph(workspaceId, graph);
      if (semantic.length) throw new WorkflowError("This workflow has problems. Fix them and save again.", 400, semantic);
    }

    if (isActive) {
      const clash = await findScopeClash(client, workspaceId, id, graph);
      if (clash) throw new WorkflowError(clash, 409);
    }

    await client.query(
      `UPDATE workflows SET name = $3, description = $4, graph = $5::jsonb, is_active = $6, updated_at = NOW() WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId, name, description, JSON.stringify(graph), isActive]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return get(workspaceId, id);
}

/**
 * Two active workflows of the same trigger type may coexist as long as their scopes do not overlap. Scope is "all" or a
 * list of ids; they overlap only when both are "all" or the lists share an id ("all" + specific is allowed: specific wins).
 * Returns a user-facing message for the first clash, or null.
 */
async function findScopeClash(client, workspaceId, id, graph) {
  const trigger = (graph.nodes || []).find((n) => isTrigger(n.type));
  if (!trigger) return null;
  const isCampaign = trigger.type === "trigger.plusvibe_reply";
  const noun = isCampaign ? "campaigns" : "mailboxes";
  const mine = scopeList(trigger.type, trigger.data);
  const others = await client.query(`SELECT id, name, graph FROM workflows WHERE workspace_id = $1 AND is_active = TRUE AND is_deleted = FALSE AND id <> $2 ORDER BY id`, [workspaceId, id]);
  for (const w of others.rows) {
    const t = (w.graph?.nodes || []).find((n) => n.type === trigger.type);
    if (!t) continue;
    const theirs = scopeList(trigger.type, t.data);
    if (mine === "all" && theirs === "all") {
      return `"${w.name}" is already active and covers all ${noun} for this trigger. Turn it off, or limit one of the two workflows to specific ${noun}.`;
    }
    if (mine === "all" || theirs === "all") continue;
    const shared = mine.filter((v) => theirs.includes(v));
    if (shared.length) {
      const label = await describeScopeItem(client, workspaceId, isCampaign, shared[0]);
      const more = shared.length > 1 ? ` (and ${shared.length - 1} more)` : "";
      return `"${w.name}" is already active for the same ${isCampaign ? "campaign" : "mailbox"} ${label}${more}. Remove it from one of the two workflows or turn "${w.name}" off first.`;
    }
  }
  return null;
}

async function describeScopeItem(client, workspaceId, isCampaign, value) {
  try {
    const { rows } = isCampaign
      ? await client.query(`SELECT name FROM plusvibe_campaigns WHERE plusvibe_campaign_id = $1 AND workspace_id = $2 AND is_deleted = FALSE LIMIT 1`, [String(value), workspaceId])
      : await client.query(`SELECT email AS name FROM mailboxes WHERE id = $1 AND workspace_id = $2 LIMIT 1`, [Number(value), workspaceId]);
    if (rows[0]?.name) return `"${rows[0].name}"`;
  } catch (_) { /* fall through to the raw id */ }
  return `"${value}"`;
}

async function remove(workspaceId, id) {
  const { rowCount } = await db.query(
    `UPDATE workflows SET is_deleted = TRUE, is_active = FALSE, updated_at = NOW() WHERE id = $1 AND workspace_id = $2 AND is_deleted = FALSE`,
    [id, workspaceId]
  );
  if (!rowCount) throw new WorkflowError("Workflow not found.", 404);
}

async function test(workspaceId, id, sample = {}) {
  const workflow = await get(workspaceId, id);
  const problems = await validateGraph(workspaceId, workflow.graph);
  if (problems.length) throw new WorkflowError("Fix the problems in this workflow before testing it.", 400, problems);

  const trigger = workflow.graph.nodes.find((n) => isTrigger(n.type));
  const s = sample && typeof sample === "object" ? sample : {};
  const from = String(s.from || "lead@example.com");
  const configured = Array.isArray(trigger.data?.mailboxIds) ? trigger.data.mailboxIds[0] : null;
  const event = {
    sample: true,
    mailboxId: configured ?? null,
    fromAddress: from,
    leadEmail: from,
    subject: String(s.subject || "Re: Quick question"),
    body: String(s.body || "Yes, I'm interested. Can you tell me more?"),
    campaignId: trigger.type === "trigger.plusvibe_reply" && Array.isArray(trigger.data?.campaignIds) ? trigger.data.campaignIds[0] : null,
  };
  const run = await executor.runWorkflow({ id: workflow.id, workspace_id: workspaceId, graph: workflow.graph }, { event, dryRun: true });
  const { rows } = await db.query(
    `SELECT id, workflow_id, trigger_type, status, dry_run, steps, error, started_at, finished_at FROM workflow_runs WHERE id = $1 AND workspace_id = $2`,
    [run.runId, workspaceId]
  );
  if (!rows[0]) throw new WorkflowError("The test run could not be recorded. Please try again.", 500);
  return rows[0];
}

// ---------------------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------------------

/** Shape + sanitising only (no DB). Returns the cleaned graph (only the fields React Flow needs to round-trip). */
function checkShape(raw) {
  const problems = [];
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
    return { problems: [{ message: "The workflow graph must have a list of nodes and a list of edges." }], graph: null };
  }
  if (raw.nodes.length > MAX_NODES) problems.push({ message: `A workflow can have at most ${MAX_NODES} steps.` });
  if (raw.edges.length > MAX_EDGES) problems.push({ message: `A workflow can have at most ${MAX_EDGES} connections.` });
  if (problems.length) return { problems, graph: null };

  const ids = new Set();
  const nodes = [];
  for (const n of raw.nodes) {
    if (!n || typeof n.id !== "string" || !n.id || n.id.length > 80) {
      problems.push({ message: "Every step needs an id." });
      continue;
    }
    if (ids.has(n.id)) problems.push({ nodeId: n.id, message: "Two steps share the same id." });
    ids.add(n.id);
    if (!executor.NODE_TYPES.includes(n.type)) {
      problems.push({ nodeId: n.id, message: `Unknown step type "${String(n.type).slice(0, 60)}".` });
      continue;
    }
    const pos = n.position;
    if (!pos || typeof pos.x !== "number" || typeof pos.y !== "number" || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
      problems.push({ nodeId: n.id, message: "This step has no valid position." });
      continue;
    }
    const data = n.data && typeof n.data === "object" && !Array.isArray(n.data) ? n.data : {};
    if (JSON.stringify(data).length > 20000) {
      problems.push({ nodeId: n.id, message: "This step's settings are too large." });
      continue;
    }
    nodes.push({ id: n.id, type: n.type, position: { x: pos.x, y: pos.y }, data });
  }

  const edges = [];
  const edgeIds = new Set();
  for (const e of raw.edges) {
    if (!e || typeof e.id !== "string" || typeof e.source !== "string" || typeof e.target !== "string") {
      problems.push({ message: "Every connection needs an id, a source and a target." });
      continue;
    }
    if (edgeIds.has(e.id)) problems.push({ message: "Two connections share the same id." });
    edgeIds.add(e.id);
    if (!ids.has(e.source) || !ids.has(e.target)) {
      problems.push({ message: "A connection points to a step that does not exist." });
      continue;
    }
    const edge = { id: e.id, source: e.source, target: e.target };
    if (e.sourceHandle) edge.sourceHandle = String(e.sourceHandle);
    edges.push(edge);
  }
  return { problems, graph: { nodes, edges } };
}

const isPosInt = (v) => Number.isInteger(v) && v > 0;

/** Full validation against the contract. Returns [{nodeId?, message}] (empty = valid). */
async function validateGraph(workspaceId, rawGraph) {
  const shape = checkShape(rawGraph);
  if (!shape.graph) return shape.problems;
  const problems = [...shape.problems];
  const { nodes, edges } = shape.graph;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const triggers = nodes.filter((n) => isTrigger(n.type));
  if (triggers.length === 0) problems.push({ message: "Add a trigger to start the workflow." });
  if (triggers.length > 1) problems.push({ message: "A workflow can only have one trigger." });
  const trigger = triggers[0];

  // Edges: no self loops, handles only from conditions, nothing flows into the trigger.
  const outgoing = new Map(nodes.map((n) => [n.id, []]));
  const seenEdge = new Set();
  for (const e of edges) {
    const src = byId.get(e.source);
    if (e.source === e.target) problems.push({ nodeId: e.source, message: "A step cannot connect to itself." });
    if (isTrigger(byId.get(e.target)?.type)) problems.push({ nodeId: e.target, message: "Nothing can connect into the trigger." });
    const handles = executor.NODE_HANDLES[src?.type];
    if (handles) {
      if (!handles.includes(e.sourceHandle)) {
        const label = src.type === "condition.keyword" ? "keyword check" : src.type === "condition.slot_selected" ? "slot-selected check" : "book-meeting step";
        problems.push({ nodeId: e.source, message: `Connect the ${label}'s ${handles.map((h) => `"${h}"`).join(" or ")} output.` });
      }
    } else if (e.sourceHandle) {
      problems.push({ nodeId: e.source, message: "Only a keyword check, a slot-selected check and a book-meeting step have separate outputs." });
    }
    const key = `${e.source}|${e.sourceHandle || ""}|${e.target}`;
    if (seenEdge.has(key)) problems.push({ nodeId: e.source, message: "The same connection is drawn twice." });
    seenEdge.add(key);
    outgoing.get(e.source)?.push(e.target);
  }

  // Connected from the trigger, and no loops.
  if (trigger) {
    const reach = new Set([trigger.id]);
    const stack = [trigger.id];
    while (stack.length) for (const next of outgoing.get(stack.pop()) || []) if (!reach.has(next)) { reach.add(next); stack.push(next); }
    for (const n of nodes) if (!reach.has(n.id)) problems.push({ nodeId: n.id, message: "This step is not connected to the trigger." });
  }
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  edges.forEach((e) => indeg.set(e.target, indeg.get(e.target) + 1));
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift();
    visited += 1;
    for (const t of outgoing.get(id) || []) {
      indeg.set(t, indeg.get(t) - 1);
      if (indeg.get(t) === 0) queue.push(t);
    }
  }
  if (visited !== nodes.length) problems.push({ message: "The workflow has a loop. Steps must flow forward only." });

  // Per-node data and ownership of every referenced resource.
  const [mailboxRows, agentRows, campaignRows, plusvibe, calendarRows] = await Promise.all([
    db.query(`SELECT id FROM mailboxes WHERE workspace_id = $1 AND is_deleted = FALSE`, [workspaceId]),
    db.query(`SELECT id FROM ai_agents WHERE workspace_id = $1 AND is_deleted = FALSE`, [workspaceId]),
    db.query(`SELECT plusvibe_campaign_id AS id FROM plusvibe_campaigns WHERE workspace_id = $1 AND is_deleted = FALSE`, [workspaceId]),
    hasPlusVibe(workspaceId),
    db.query(`SELECT DISTINCT ai_agent_id FROM calendar_connections WHERE workspace_id = $1 AND provider = 'google' AND status = 'connected'`, [workspaceId]),
  ]);
  const calendarAgentIds = new Set(calendarRows.rows.map((r) => r.ai_agent_id));
  const mailboxIds = new Set(mailboxRows.rows.map((r) => r.id));
  const agentIds = new Set(agentRows.rows.map((r) => r.id));
  const campaignIds = new Set(campaignRows.rows.map((r) => String(r.id)));
  const triggerType = trigger?.type;

  // Steps reachable from a "Slot selected" check's yes output (a booking only makes sense there).
  const afterSlotYes = new Set();
  {
    const stack = edges.filter((e) => byId.get(e.source)?.type === "condition.slot_selected" && e.sourceHandle === "yes").map((e) => e.target);
    while (stack.length) {
      const id = stack.pop();
      if (afterSlotYes.has(id)) continue;
      afterSlotYes.add(id);
      for (const next of outgoing.get(id) || []) stack.push(next);
    }
  }

  for (const n of nodes) {
    const d = n.data;
    switch (n.type) {
      case "trigger.inbox_mail":
      case "trigger.mail_sent":
        if (d.mailboxIds === "all") break;
        if (!Array.isArray(d.mailboxIds) || d.mailboxIds.length === 0) problems.push({ nodeId: n.id, message: 'Choose "all mailboxes" or at least one mailbox.' });
        else if (!d.mailboxIds.every((m) => isPosInt(m) && mailboxIds.has(m))) problems.push({ nodeId: n.id, message: "One of the selected mailboxes does not exist in this workspace." });
        break;
      case "trigger.plusvibe_reply":
        if (d.campaignIds === "all") break;
        if (!plusvibe) problems.push({ nodeId: n.id, message: "Connect PlusVibe before using this trigger." });
        if (!Array.isArray(d.campaignIds) || d.campaignIds.length === 0) problems.push({ nodeId: n.id, message: 'Choose "all campaigns" or at least one campaign.' });
        else if (!d.campaignIds.every((c) => typeof c === "string" && campaignIds.has(c))) problems.push({ nodeId: n.id, message: "One of the selected campaigns does not exist in this workspace." });
        break;
      case "action.save_to_db":
        break;
      case "action.ai_agent":
        if (d.agentId === "campaign") {
          if (triggerType && triggerType !== "trigger.plusvibe_reply" && triggerType !== "trigger.inbox_mail") problems.push({ nodeId: n.id, message: "\"The campaign's agent\" only works with the PlusVibe reply or mailbox reply trigger." });
        } else if (!isPosInt(d.agentId) || !agentIds.has(d.agentId)) problems.push({ nodeId: n.id, message: "Choose an AI agent from this workspace." });
        if (d.mode !== "auto_send" && d.mode !== "review" && d.mode !== "agent_default") problems.push({ nodeId: n.id, message: "Choose whether the AI sends automatically, leaves the reply for review, or follows the agent's own settings." });
        if (d.tone !== undefined && (typeof d.tone !== "string" || d.tone.length > 200)) problems.push({ nodeId: n.id, message: "Tone must be text of 200 characters or fewer." });
        if (d.instructions !== undefined && (typeof d.instructions !== "string" || d.instructions.length > 4000)) problems.push({ nodeId: n.id, message: "Instructions must be text of 4000 characters or fewer." });
        if (triggerType === "trigger.mail_sent") problems.push({ nodeId: n.id, message: "An AI reply needs a reply trigger, not \"email sent\"." });
        break;
      case "action.send_reply":
        if (d.via !== "plusvibe" && d.via !== "mailbox") problems.push({ nodeId: n.id, message: "Choose how to send: PlusVibe or a mailbox." });
        else if (d.via === "plusvibe") {
          if (!plusvibe) problems.push({ nodeId: n.id, message: "Connect PlusVibe before sending through it." });
          if (triggerType && triggerType !== "trigger.plusvibe_reply") problems.push({ nodeId: n.id, message: "Sending through PlusVibe only works with the PlusVibe reply trigger." });
        } else {
          if (d.mailboxId !== undefined && d.mailboxId !== null && !(isPosInt(d.mailboxId) && mailboxIds.has(d.mailboxId))) problems.push({ nodeId: n.id, message: "The selected mailbox does not exist in this workspace." });
          if (triggerType && triggerType !== "trigger.inbox_mail") problems.push({ nodeId: n.id, message: "Sending from a mailbox only works with the mailbox reply trigger." });
        }
        break;
      case "condition.keyword":
        if (!Array.isArray(d.keywords) || d.keywords.length === 0 || !d.keywords.every((k) => typeof k === "string" && k.trim()) || d.keywords.length > 50) {
          problems.push({ nodeId: n.id, message: "Add at least one keyword (up to 50)." });
        }
        if (d.matchOn !== "reply" && d.matchOn !== "subject") problems.push({ nodeId: n.id, message: "Choose whether to check the reply or the subject." });
        break;
      case "action.offer_times":
      case "action.book_meeting": {
        if (n.type === "action.offer_times" && d.count !== undefined && !(Number.isInteger(d.count) && d.count >= 1 && d.count <= 5)) problems.push({ nodeId: n.id, message: "Offer between 1 and 5 times." });
        if (d.agentId === "campaign") {
          if (triggerType && triggerType !== "trigger.plusvibe_reply" && triggerType !== "trigger.inbox_mail") problems.push({ nodeId: n.id, message: "\"The campaign's agent\" only works with the PlusVibe reply or mailbox reply trigger." });
        } else if (!isPosInt(d.agentId) || !agentIds.has(d.agentId)) problems.push({ nodeId: n.id, message: "Choose an AI agent from this workspace." });
        else if (!calendarAgentIds.has(d.agentId)) problems.push({ nodeId: n.id, message: "Connect Google Calendar for this agent first." });
        if (triggerType === "trigger.mail_sent") problems.push({ nodeId: n.id, message: "Meetings need a reply trigger, not \"email sent\"." });
        if (n.type === "action.book_meeting" && !afterSlotYes.has(n.id)) problems.push({ nodeId: n.id, message: 'Book meeting must come after a "Slot selected" check, on its "yes" output.' });
        break;
      }
      case "condition.slot_selected":
        if (triggerType === "trigger.mail_sent") problems.push({ nodeId: n.id, message: "Checking for a chosen time needs a reply trigger, not \"email sent\"." });
        break;
      case "action.notify_email": {
        const to = d.to === undefined ? [] : d.to;
        if (!Array.isArray(to) || to.length > 10 || !to.every((a) => typeof a === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.trim()))) {
          problems.push({ nodeId: n.id, message: "Recipients must be valid email addresses (up to 10)." });
        } else if (to.length === 0 && d.notifyOwners !== true) problems.push({ nodeId: n.id, message: "Add at least one recipient, or notify the workspace owners and admins." });
        if (d.notifyOwners !== undefined && typeof d.notifyOwners !== "boolean") problems.push({ nodeId: n.id, message: "Notify owners must be on or off." });
        if (d.includeReply !== undefined && typeof d.includeReply !== "boolean") problems.push({ nodeId: n.id, message: "Include reply must be on or off." });
        if (typeof d.subject !== "string" || !d.subject.trim() || d.subject.length > 200) problems.push({ nodeId: n.id, message: "Write a subject of up to 200 characters." });
        if (typeof d.message !== "string" || !d.message.trim() || d.message.length > 4000) problems.push({ nodeId: n.id, message: "Write a message of up to 4000 characters." });
        break;
      }
      default:
        break;
    }
  }
  return problems;
}

module.exports = { WorkflowError, list, get, meta, listRuns, create, update, remove, test, validateGraph, checkShape };
