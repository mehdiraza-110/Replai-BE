const db = require("../config/db.config");
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

function mapSummary(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    is_active: row.is_active,
    node_count: Number(row.node_count) || 0,
    trigger_type: row.trigger_type || null,
    updated_at: row.updated_at,
    last_run: row.last_run || null,
  };
}

async function meta(workspaceId) {
  const [mailboxes, agents, integration, campaigns] = await Promise.all([
    db.query(`SELECT id, email FROM mailboxes WHERE workspace_id = $1 AND is_deleted = FALSE ORDER BY email`, [workspaceId]),
    db.query(`SELECT id, name FROM ai_agents WHERE workspace_id = $1 AND is_deleted = FALSE ORDER BY name`, [workspaceId]),
    hasPlusVibe(workspaceId),
    db.query(`SELECT plusvibe_campaign_id AS id, name FROM plusvibe_campaigns WHERE workspace_id = $1 AND is_deleted = FALSE ORDER BY name`, [workspaceId]),
  ]);
  return {
    mailboxes: mailboxes.rows,
    agents: agents.rows,
    plusvibeConnected: integration,
    plusvibeCampaigns: campaigns.rows,
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

async function create(workspaceId, userId, { name, description, template } = {}) {
  if (template !== undefined && template !== null && template !== "default_reply") throw new WorkflowError('Unknown template. Use "default_reply" or leave it out.');
  const graph = template === "default_reply" ? defaultReplyGraph() : { nodes: [], edges: [] };
  const { rows } = await db.query(
    `INSERT INTO workflows (workspace_id, name, description, graph, created_by) VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id`,
    [workspaceId, cleanName(name), description ? String(description).slice(0, 2000) : null, JSON.stringify(graph), userId || null]
  );
  return get(workspaceId, rows[0].id);
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
      const triggerType = (graph.nodes.find((n) => isTrigger(n.type)) || {}).type;
      const others = await client.query(`SELECT id, name, graph FROM workflows WHERE workspace_id = $1 AND is_active = TRUE AND is_deleted = FALSE AND id <> $2`, [workspaceId, id]);
      const clash = others.rows.find((w) => (w.graph?.nodes || []).some((n) => n.type === triggerType));
      if (clash) {
        throw new WorkflowError(`"${clash.name}" is already active for the same trigger. Turn it off first, then activate this one.`, 409);
      }
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
    if (src?.type === "condition.keyword") {
      if (e.sourceHandle !== "yes" && e.sourceHandle !== "no") problems.push({ nodeId: e.source, message: 'Connect the keyword check\'s "yes" or "no" output.' });
    } else if (e.sourceHandle) {
      problems.push({ nodeId: e.source, message: "Only a keyword check has separate yes/no outputs." });
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
  const [mailboxRows, agentRows, campaignRows, plusvibe] = await Promise.all([
    db.query(`SELECT id FROM mailboxes WHERE workspace_id = $1 AND is_deleted = FALSE`, [workspaceId]),
    db.query(`SELECT id FROM ai_agents WHERE workspace_id = $1 AND is_deleted = FALSE`, [workspaceId]),
    db.query(`SELECT plusvibe_campaign_id AS id FROM plusvibe_campaigns WHERE workspace_id = $1 AND is_deleted = FALSE`, [workspaceId]),
    hasPlusVibe(workspaceId),
  ]);
  const mailboxIds = new Set(mailboxRows.rows.map((r) => r.id));
  const agentIds = new Set(agentRows.rows.map((r) => r.id));
  const campaignIds = new Set(campaignRows.rows.map((r) => String(r.id)));
  const triggerType = trigger?.type;

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
        if (!isPosInt(d.agentId) || !agentIds.has(d.agentId)) problems.push({ nodeId: n.id, message: "Choose an AI agent from this workspace." });
        if (d.mode !== "auto_send" && d.mode !== "review") problems.push({ nodeId: n.id, message: "Choose whether the AI sends automatically or leaves the reply for review." });
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
      default:
        break;
    }
  }
  return problems;
}

module.exports = { WorkflowError, list, get, meta, listRuns, create, update, remove, test, validateGraph, checkShape };
