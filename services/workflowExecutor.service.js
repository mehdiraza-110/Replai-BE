const db = require("../config/db.config");
const suppressionService = require("./suppression.service");
const messageService = require("./message.service");
const nativeAgentReplyService = require("./nativeAgentReply.service");
const eventLogService = require("./eventLog.service");
const googleCalendarService = require("./googleCalendar.service");
const meetingBookingService = require("./meetingBooking.service");
const slotSelection = require("./slotSelection.service");
const emailService = require("./email.service");

/**
 * Workflow executor (opt-in automation, see API-Contract-Workspaces.md "Workflows").
 *
 * maybeRun() is called by the existing pipelines at their trigger points. A workspace with no active workflow for
 * that trigger type (or whose trigger filter does not match the event) gets `{ handled: false }` and the caller
 * keeps doing exactly what it does today. When a workflow runs, every node reuses an existing service:
 *   save_to_db   -> the persistence the built-in path already performed (verified, plus the PlusVibe lead profile).
 *                   Optional in the graph: when absent it runs automatically right after the trigger.
 *   ai_agent     -> message.service agentHelpers.generateResponse / generateDraftFromWebhook (+ the same draft insert)
 *   send_reply   -> nativeAgentReply.sendDraft (inbox.service.sendReply) or message.service.approveDraft (PlusVibe)
 *
 * Failure semantics (never throws):
 *   - nothing sent and no draft written yet  -> run recorded `failed`, returns { handled:false, status:'failed',
 *     fellBack:true } so the caller runs the built-in handler as if no workflow existed.
 *   - a draft or a reply already exists      -> returns { handled:true, status:'failed' }; the caller must NOT
 *     run the built-in handler (it would duplicate/double-send). A pending draft stays for human review.
 *   - dryRun                                  -> always { handled:true }, never falls back.
 */

const DEFAULT_PRIORITY = 100;

const TRIGGER_TYPES = {
  "trigger.inbox_mail": {
    label: "Reply lands in a mailbox",
    description: "A prospect replies to one of your own mailboxes.",
    configKey: "mailboxIds",
    eventFields: ["mailboxId", "campaignId?", "leadId?", "inboundMessageId", "threadId", "fromAddress", "toAddress", "subject", "body"],
  },
  "trigger.plusvibe_reply": {
    label: "PlusVibe reply",
    description: "PlusVibe reports a reply to one of your campaigns.",
    configKey: "campaignIds",
    eventFields: ["payload", "campaignId?", "leadEmail?", "threadId?"],
  },
  "trigger.mail_sent": {
    label: "Email sent",
    description: "A cold-mailer email was sent from one of your mailboxes.",
    configKey: "mailboxIds",
    eventFields: ["mailboxId", "campaignId", "leadId", "leadEmail", "subject", "body"],
  },
};

const NODE_TYPES = [
  ...Object.keys(TRIGGER_TYPES),
  "action.save_to_db",
  "action.ai_agent",
  "action.send_reply",
  "condition.keyword",
  "action.offer_times",
  "condition.slot_selected",
  "action.book_meeting",
  "action.notify_email",
];

/** Nodes that own the meeting flow: when any is in the graph, the built-in meeting logic is skipped for the AI step. */
const MEETING_NODE_TYPES = ["action.offer_times", "condition.slot_selected", "action.book_meeting"];

/** Output handles of the nodes that branch. Edges leaving one of these must name one of its handles. */
const NODE_HANDLES = {
  "condition.keyword": ["yes", "no"],
  "condition.slot_selected": ["yes", "no"],
  "action.book_meeting": ["booked", "unavailable"],
};

function describeTriggerTypes() {
  return Object.entries(TRIGGER_TYPES).map(([type, t]) => ({
    type,
    label: t.label,
    description: t.description,
    filter: t.configKey,
    eventFields: t.eventFields,
  }));
}

// ---------------------------------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------------------------------

async function maybeRun({ workspaceId, triggerType, event = {}, dryRun = false } = {}) {
  try {
    if (!workspaceId || !TRIGGER_TYPES[triggerType]) return { handled: false };
    const workflows = await findActiveWorkflows(workspaceId, triggerType, normalizeEvent(triggerType, event));
    if (workflows.length === 0) return { handled: false };

    // Every matching workflow runs, one after the other (never in parallel: the shared reply marker below is what
    // guarantees a single reply per event). The marker is set by the first run that produces the reply.
    const shared = { replyOwner: null };
    const results = [];
    for (const workflow of workflows) {
      const result = await runWorkflow(workflow, { event, dryRun, shared });
      results.push({ workflow, result });
    }
    const runs = results.map(({ workflow, result }) => ({
      runId: result.runId ?? null,
      workflowId: workflow.id,
      name: workflow.name,
      priority: workflow.priority ?? DEFAULT_PRIORITY,
      status: result.status ?? null,
      handled: Boolean(result.handled),
      fellBack: Boolean(result.fellBack),
    }));
    // Top-level fields stay as before: those of the first run that handled the event, else of the first run.
    const primary = (results.find(({ result }) => result.handled) || results[0]).result;
    const handled = results.some(({ result }) => result.handled);
    const out = { ...primary, handled, runs };
    if (handled) delete out.fellBack;
    else if (results.every(({ result }) => result.fellBack)) out.fellBack = true;
    return out;
  } catch (error) {
    console.error("Workflow lookup failed, falling back to built-in handling:", error.message);
    return { handled: false, status: "failed", error: error.message };
  }
}

/** Runs one specific workflow (used by maybeRun and by POST /workflows/:id/test). Never throws. */
async function runWorkflow(workflow, { event = {}, dryRun = false, shared = null } = {}) {
  const graph = workflow.graph || { nodes: [], edges: [] };
  const trigger = (graph.nodes || []).find((n) => String(n.type).startsWith("trigger."));
  const triggerType = trigger?.type || "unknown";
  const ev = normalizeEvent(triggerType, event);
  const steps = [];
  const state = { draft: null, draftCreated: false, reviewOnly: false, sent: false, suppressed: false, meeting: null, selectedSlot: null, offer: null, notified: new Set() };
  let runId = null;

  try {
    const { rows } = await db.query(
      `INSERT INTO workflow_runs (workflow_id, workspace_id, trigger_type, status, dry_run) VALUES ($1, $2, $3, 'running', $4) RETURNING id`,
      [workflow.id, workflow.workspace_id, triggerType, dryRun]
    );
    runId = rows[0].id;
  } catch (error) {
    console.error("Could not record workflow run, falling back to built-in handling:", error.message);
    return dryRun ? { handled: true, status: "failed", error: error.message } : { handled: false, status: "failed", error: error.message };
  }

  let status = "success";
  let errorMessage = null;
  try {
    const order = topologicalOrder(graph);
    if (!trigger || !order) throw new Error("The workflow graph is invalid (needs one trigger and no loops).");
    const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
    const activated = new Set([trigger.id]);
    const ctx = { workspaceId: workflow.workspace_id, event: ev, dryRun, state, triggerType, shared, workflow, hasMeetingNodes: graph.nodes.some((n) => MEETING_NODE_TYPES.includes(n.type)) };
    // The save step is optional in the graph, but the data is ALWAYS saved: without a "Save to database" node it runs
    // automatically right after the trigger. It never blocks a reply (a failed save is shown in the trace only).
    const hasSaveNode = graph.nodes.some((n) => n.type === "action.save_to_db");

    for (const nodeId of order) {
      if (!activated.has(nodeId)) continue;
      const node = nodesById.get(nodeId);
      const step = { nodeId, type: node.type, status: "success", startedAt: new Date().toISOString() };
      let result;
      try {
        result = await executeNode(node, ctx);
      } catch (error) {
        step.status = "failed";
        step.error = error.message || String(error);
        step.finishedAt = new Date().toISOString();
        steps.push(step);
        throw Object.assign(new Error(step.error), { nodeId });
      }
      step.status = result.status || "success";
      if (result.output !== undefined) step.output = result.output;
      step.finishedAt = new Date().toISOString();
      steps.push(step);

      if (!hasSaveNode && node.type.startsWith("trigger.")) {
        const auto = { nodeId: "auto-save", type: "action.save_to_db", status: "success", startedAt: new Date().toISOString() };
        try {
          const saved = await saveToDb(ctx);
          auto.status = saved.status || "success";
          auto.output = { ...(saved.output || {}), automatic: true };
        } catch (error) {
          auto.status = "failed";
          auto.error = error.message || String(error);
        }
        auto.finishedAt = new Date().toISOString();
        steps.push(auto);
      }

      for (const edge of graph.edges) {
        if (edge.source !== nodeId) continue;
        if (result.branch !== undefined && edge.sourceHandle !== result.branch) continue;
        activated.add(edge.target);
      }
    }
    if ((state.suppressed || state.noAgent) && !state.sent && !state.draftCreated) status = "skipped";
  } catch (error) {
    status = "failed";
    errorMessage = error.message || String(error);
  }

  await db
    .query(`UPDATE workflow_runs SET status = $1, steps = $2::jsonb, error = $3, finished_at = NOW() WHERE id = $4 AND workspace_id = $5`, [
      status,
      JSON.stringify(steps),
      errorMessage,
      runId,
      workflow.workspace_id,
    ])
    .catch((error) => console.error("Could not finalise workflow run:", error.message));

  const base = { runId, status, steps, error: errorMessage };
  if (dryRun) return { handled: true, ...base };
  if (status === "failed" && !state.sent && !state.draftCreated) return { handled: false, fellBack: true, ...base };
  return { handled: true, ...base };
}

// ---------------------------------------------------------------------------------------------------------------
// Lookup / matching
// ---------------------------------------------------------------------------------------------------------------

/**
 * EVERY active workflow of this trigger type whose scope matches the event, in run order: priority ascending (lower runs
 * first), then specificity (a list containing the event's campaign/mailbox before "all"), then id.
 */
async function findActiveWorkflows(workspaceId, triggerType, event) {
  const { rows } = await db.query(
    `SELECT * FROM workflows WHERE workspace_id = $1 AND is_active = TRUE AND is_deleted = FALSE ORDER BY id`,
    [workspaceId]
  );
  const matched = [];
  for (const workflow of rows) {
    const trigger = (workflow.graph?.nodes || []).find((n) => n.type === triggerType);
    if (!trigger) continue;
    const rank = triggerMatchRank(trigger, event);
    if (rank > 0) matched.push({ workflow, rank });
  }
  matched.sort((x, y) => (x.workflow.priority ?? DEFAULT_PRIORITY) - (y.workflow.priority ?? DEFAULT_PRIORITY) || y.rank - x.rank || x.workflow.id - y.workflow.id);
  return matched.map((m) => m.workflow);
}

/** 0 = no match, 1 = matches via "all", 2 = matches via an explicit list containing the event's id. */
function triggerMatchRank(trigger, event) {
  const data = trigger.data || {};
  if (trigger.type === "trigger.plusvibe_reply") {
    if (data.campaignIds === "all" || data.campaignIds === undefined) return 1;
    return Array.isArray(data.campaignIds) && event.campaignId != null && data.campaignIds.map(String).includes(String(event.campaignId)) ? 2 : 0;
  }
  if (data.mailboxIds === "all" || data.mailboxIds === undefined) return 1;
  return Array.isArray(data.mailboxIds) && event.mailboxId != null && data.mailboxIds.map(Number).includes(Number(event.mailboxId)) ? 2 : 0;
}

function normalizeEvent(triggerType, event = {}) {
  const payload = event.payload || {};
  const ev = { ...event };
  if (triggerType === "trigger.plusvibe_reply") {
    ev.campaignId = event.campaignId ?? payload.campaign_id ?? payload.camp_id ?? null;
    ev.leadEmail = event.leadEmail ?? payload.email ?? payload.lead_email ?? null;
    ev.threadId = event.threadId ?? payload.thread_id ?? payload.source_thread_id ?? null;
    ev.subject = event.subject ?? payload.subject ?? "";
    ev.body = event.body ?? payload.reply_text ?? payload.text ?? payload.body ?? payload.reply ?? payload.content ?? "";
  } else {
    ev.leadEmail = event.leadEmail ?? event.fromAddress ?? event.from ?? null;
    ev.fromAddress = event.fromAddress ?? event.from ?? null;
    ev.subject = event.subject ?? "";
    ev.body = event.body ?? "";
  }
  return ev;
}

/** Kahn's algorithm. Returns node ids in execution order, or null when the graph has a cycle. */
function topologicalOrder(graph) {
  const nodes = graph.nodes || [];
  const indegree = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of graph.edges || []) if (indegree.has(e.target) && indegree.has(e.source)) indegree.set(e.target, indegree.get(e.target) + 1);
  const queue = nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const e of graph.edges || []) {
      if (e.source !== id || !indegree.has(e.target)) continue;
      indegree.set(e.target, indegree.get(e.target) - 1);
      if (indegree.get(e.target) === 0) queue.push(e.target);
    }
  }
  return order.length === nodes.length ? order : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------------------------------------------

/** Nodes that produce the reply to the prospect. Only one workflow per event may run them. */
const REPLY_NODE_TYPES = ["action.ai_agent", "action.send_reply", "action.offer_times", "action.book_meeting"];

/** The workflow that already produced the reply to this event, if it is a different one from the running workflow. */
function otherReplyOwner(ctx) {
  const owner = ctx.shared?.replyOwner;
  return owner && owner.workflowId !== ctx.workflow?.id ? owner : null;
}

/** Marks the running workflow as the owner of the reply once one of its reply nodes really produced something. */
function claimReply(ctx, node, result) {
  if (!ctx.shared || ctx.dryRun || ctx.shared.replyOwner || !ctx.workflow) return;
  const state = ctx.state;
  const produced =
    (node.type === "action.ai_agent" && state.draftCreated) ||
    (node.type === "action.send_reply" && state.sent) ||
    (node.type === "action.offer_times" && state.meeting?.mode === "offer" && result?.status !== "skipped") ||
    (node.type === "action.book_meeting" && state.meeting?.mode === "booked" && result?.status !== "skipped");
  if (produced) ctx.shared.replyOwner = { workflowId: ctx.workflow.id, name: ctx.workflow.name };
}

async function executeNode(node, ctx) {
  if (REPLY_NODE_TYPES.includes(node.type)) {
    const owner = otherReplyOwner(ctx);
    if (owner) {
      const skipped = { status: "skipped", output: { reason: "reply_already_handled", detail: `Workflow "${owner.name}" already handled the reply to this message.` } };
      // A skipped booking must not light up either of its outputs.
      if (node.type === "action.book_meeting") skipped.branch = "__skipped__";
      return skipped;
    }
    const result = await executeNodeInner(node, ctx);
    claimReply(ctx, node, result);
    return result;
  }
  return executeNodeInner(node, ctx);
}

async function executeNodeInner(node, ctx) {
  switch (node.type) {
    case "trigger.inbox_mail":
    case "trigger.plusvibe_reply":
    case "trigger.mail_sent":
      return { output: { matched: true, event: summariseEvent(ctx.event) } };
    case "action.save_to_db":
      return saveToDb(ctx);
    case "action.ai_agent":
      return aiAgent(node, ctx);
    case "action.send_reply":
      return sendReply(node, ctx);
    case "condition.keyword":
      return keywordCondition(node, ctx);
    case "action.offer_times":
      return offerTimes(node, ctx);
    case "condition.slot_selected":
      return slotSelectedCondition(node, ctx);
    case "action.book_meeting":
      return bookMeeting(node, ctx);
    case "action.notify_email":
      return notifyEmail(node, ctx);
    default:
      throw new Error(`Unknown step type "${node.type}".`);
  }
}

function summariseEvent(ev) {
  return { from: ev.leadEmail || null, subject: ev.subject || null, mailboxId: ev.mailboxId ?? null, campaignId: ev.campaignId ?? null };
}

async function saveToDb(ctx) {
  const { event, workspaceId, dryRun, triggerType } = ctx;
  if (triggerType === "trigger.plusvibe_reply") {
    // The webhook event row is already stored by plusVibeService.recordWebhook; the lead profile is what the
    // built-in path adds. Needs the PlusVibe workspace id, which only the payload carries.
    const pvWorkspaceId = event.payload?.workspace_id;
    if (!event.leadEmail || !pvWorkspaceId) return { status: "skipped", output: { reason: "Nothing extra to store: the webhook payload has no lead email or PlusVibe workspace." } };
    if (dryRun) return { output: { wouldUpsertLeadProfile: event.leadEmail } };
    await require("./leadProfile.service").upsert({
      workspaceId: pvWorkspaceId,
      appWorkspaceId: workspaceId,
      leadEmail: event.leadEmail,
      threadId: event.threadId,
      campaignId: event.campaignId,
    });
    return { output: { leadProfileUpdated: event.leadEmail } };
  }
  if (triggerType === "trigger.mail_sent") return { output: { alreadyPersisted: true, note: "The sent email is recorded by the campaign sender." } };
  if (dryRun) return { output: { wouldPersist: "inbound message (already stored by the inbox pipeline)" } };
  if (!event.inboundMessageId) return { status: "skipped", output: { reason: "No inbound message id on the event." } };
  const { rows } = await db.query(`SELECT id FROM messages WHERE id = $1 AND workspace_id = $2`, [event.inboundMessageId, workspaceId]);
  if (!rows[0]) throw new Error("The incoming message could not be found in this workspace.");
  return { output: { messageId: rows[0].id, alreadyPersisted: true } };
}

async function keywordCondition(node, ctx) {
  const data = node.data || {};
  const helpers = messageService.agentHelpers;
  const raw = data.matchOn === "subject" ? ctx.event.subject : ctx.event.body;
  const text = String((data.matchOn === "subject" ? raw : helpers.stripQuotedReply(String(raw || ""))) || "").toLowerCase();
  const keyword = (data.keywords || []).map((k) => String(k).trim().toLowerCase()).filter(Boolean).find((k) => text.includes(k));
  return { branch: keyword ? "yes" : "no", output: { matched: Boolean(keyword), keyword: keyword || null, matchOn: data.matchOn } };
}

const NO_CAMPAIGN_AGENT = "This campaign has no AI agent assigned.";

/** The agent assigned to the campaign the reply belongs to (workspace-scoped), or null. */
async function resolveCampaignAgentId(workspaceId, triggerType, event) {
  if (event.campaignId == null || event.campaignId === "") return null;
  if (triggerType === "trigger.plusvibe_reply") {
    const { rows } = await db.query(
      `SELECT assigned_ai_agent_id AS id FROM plusvibe_campaigns WHERE plusvibe_campaign_id = $1 AND workspace_id = $2 AND is_deleted = FALSE LIMIT 1`,
      [String(event.campaignId), workspaceId]
    );
    return rows[0]?.id || null;
  }
  if (triggerType === "trigger.inbox_mail") {
    const campaignId = Number(event.campaignId);
    if (!Number.isInteger(campaignId)) return null;
    const { rows } = await db.query(`SELECT ai_agent_id AS id FROM campaigns WHERE id = $1 AND workspace_id = $2 AND is_deleted = FALSE LIMIT 1`, [campaignId, workspaceId]);
    return rows[0]?.id || null;
  }
  return null;
}

async function aiAgent(node, ctx) {
  const { workspaceId, event, dryRun, state, triggerType } = ctx;
  const data = node.data || {};
  state.agentName = null;
  const mode = data.mode === "review" ? "review" : data.mode === "agent_default" ? "agent_default" : "auto_send";

  let agentId = data.agentId;
  if (agentId === "campaign") {
    if (triggerType !== "trigger.plusvibe_reply" && triggerType !== "trigger.inbox_mail") throw new Error("\"The campaign's agent\" only works with the PlusVibe reply or mailbox reply trigger.");
    if (dryRun && (event.campaignId == null || event.campaignId === "")) {
      // A test has no real campaign, so there is no agent to look up; show what a real reply would do.
      state.draft = { dry: true };
      return { output: { wouldGenerateDraft: true, agent: "the agent assigned to the reply's campaign", mode, note: "Dry run: the agent is chosen from the real reply's campaign. No AI provider was called and nothing was saved." } };
    }
    agentId = await resolveCampaignAgentId(workspaceId, triggerType, event);
    if (!agentId) {
      state.noAgent = true;
      return { status: "skipped", output: { reason: "no_agent", detail: NO_CAMPAIGN_AGENT, message: NO_CAMPAIGN_AGENT } };
    }
  }

  const { rows: agentRows } = await db.query(`SELECT * FROM ai_agents WHERE id = $1 AND workspace_id = $2 AND is_deleted = FALSE`, [agentId, workspaceId]);
  const agentRow = agentRows[0];
  if (!agentRow) {
    if (data.agentId === "campaign") {
      state.noAgent = true;
      return { status: "skipped", output: { reason: "no_agent", detail: NO_CAMPAIGN_AGENT, message: NO_CAMPAIGN_AGENT } };
    }
    throw new Error("The AI agent for this step no longer exists in this workspace.");
  }

  // Same gates as the built-in path: an opted-out / suppressed address never gets an AI answer.
  const leadEmail = event.leadEmail;
  if (leadEmail && ((await suppressionService.isSuppressed(leadEmail, workspaceId)) || suppressionService.isOptOutText(String(event.body || "")))) {
    state.suppressed = true;
    return { status: "skipped", output: { reason: "suppressed", detail: "This address has opted out or is suppressed." } };
  }
  state.agentName = agentRow.name;
  if (agentRow.status !== "Active") return { status: "skipped", output: { reason: "agent_inactive", detail: `Agent "${agentRow.name}" is not active.` } };

  if (dryRun) {
    state.draft = { dry: true };
    if (mode === "agent_default") state.reviewOnly = true; // never decided in a test: the real run decides from the real confidence
    return {
      output: {
        wouldGenerateDraft: true,
        agent: agentRow.name,
        tone: data.tone || agentRow.tone,
        instructions: data.instructions || null,
        mode,
        ...(state.meeting ? { meeting: state.meeting.mode } : {}),
        note: "Dry run: no AI provider was called and nothing was saved.",
      },
    };
  }

  if (triggerType === "trigger.plusvibe_reply") return aiAgentPlusVibe({ data, ctx, agentRow, mode });
  if (triggerType !== "trigger.inbox_mail") return { status: "skipped", output: { reason: "This trigger has no reply to answer." } };
  return aiAgentNative({ data, ctx, agentRow, mode });
}

async function aiAgentPlusVibe({ data, ctx, agentRow, mode }) {
  const { workspaceId, event, state } = ctx;
  // The node's agent (with its tone/instructions) answers, whichever agent the campaign has assigned.
  const result = await messageService.generateDraftFromWebhook(workspaceId, event.payload || {}, overrideWithMeeting(data, agentRow, ctx));
  if (!result || result.status !== "Generated") {
    return { status: "skipped", output: { reason: "no_draft", detail: result?.reason || "No draft was generated for this reply." } };
  }
  state.draft = { source: "plusvibe", id: result.draft.id, lead_email: event.leadEmail };
  state.draftCreated = true;
  state.draftBody = result.draft.body || null;
  // The built-in PlusVibe path only ever drafts (drafts wait in Human Review; approveDraft is a manual action), so
  // "agent_default" == "review" here.
  if (mode === "review" || mode === "agent_default") state.reviewOnly = true;
  return { output: { draftId: result.draft.id, mode, confidence: Number(result.draft.confidence), ...(mode === "agent_default" ? { note: "PlusVibe replies are never auto-sent by the agent's own settings; left as a draft for human review." } : {}) } };
}

function overrideOf(data, agentRow) {
  return { agentId: agentRow.id, tone: data.tone || undefined, instructions: data.instructions || undefined };
}

/** overrideOf + the workflow's meeting outcome. Only a graph WITH meeting nodes adds keys, so other workflows are untouched. */
function overrideWithMeeting(data, agentRow, ctx) {
  const override = overrideOf(data, agentRow);
  if (ctx.hasMeetingNodes) {
    override.skipBuiltInMeeting = true;
    override.meeting = ctx.state.meeting || null;
  }
  return override;
}

async function aiAgentNative({ data, ctx, agentRow, mode }) {
  const { workspaceId, event, state } = ctx;

  const result = await nativeAgentReplyService.handleInbound({
    mailboxId: event.mailboxId,
    campaignId: event.campaignId || null,
    leadId: event.leadId || null,
    inboundMessageId: event.inboundMessageId,
    workspaceId,
    override: overrideWithMeeting(data, agentRow, ctx),
  });

  if (result.status === "Skipped" && result.reason === "missing_context") {
    throw new Error("The incoming message or its mailbox could not be found in this workspace.");
  }
  if (result.status === "Skipped" && result.reason === "already_drafted") {
    state.draftCreated = true; // a draft for this message exists already: never let the built-in path add another
    return { status: "skipped", output: { reason: "already_drafted" } };
  }
  if (result.status !== "Drafted") {
    return { status: "skipped", output: { reason: result.reason || "no_draft" } };
  }

  state.draft = result.draft;
  state.draftCreated = true;
  state.draftBody = result.draft?.body || null;

  let note;
  if (mode === "agent_default") {
    // Exactly the built-in gating (nativeAgentReply's `autoSend`): every condition must hold, else it waits for review.
    const campaign = await campaignForGate(workspaceId, event.campaignId);
    const autoSend =
      Boolean(campaign) &&
      !campaign.human_review_required &&
      Boolean(agentRow.auto_reply_enabled) &&
      !agentRow.require_human_review &&
      Number(result.confidence) >= Number(agentRow.confidence_threshold);
    if (!autoSend) {
      state.reviewOnly = true;
      note = "Following the agent's settings: left as a draft for human review.";
    } else {
      note = "Following the agent's settings: sent automatically.";
    }
  } else if (mode === "review") {
    state.reviewOnly = true;
  } else if (Number(result.confidence) < Number(agentRow.confidence_threshold)) {
    state.reviewOnly = true;
    note = `Confidence ${result.confidence} is below the agent's threshold ${agentRow.confidence_threshold}; left as a draft for review.`;
  }
  return { output: { draftId: result.draftId, mode, confidence: Number(result.confidence), generatedBy: result.generatedBy, note } };
}

async function campaignForGate(workspaceId, campaignId) {
  const id = Number(campaignId);
  if (!campaignId || !Number.isInteger(id)) return null;
  const { rows } = await db.query(`SELECT * FROM campaigns WHERE id = $1 AND workspace_id = $2 AND is_deleted = FALSE`, [id, workspaceId]);
  return rows[0] || null;
}

// ---------------------------------------------------------------------------------------------------------------
// Meeting nodes: offer times -> slot selected? -> book meeting. Each is explicit and deterministic; the AI step only
// writes the reply for whatever happened (state.meeting).
// ---------------------------------------------------------------------------------------------------------------

const cleanText = (value) => (value === undefined || value === null ? "" : String(value).trim());

/** Agent a meeting node works with ("campaign" resolves like the AI step does). Returns { agentRow } or { reason } or { dryUnresolved }. */
async function resolveNodeAgent(data, ctx) {
  const { workspaceId, event, dryRun, triggerType } = ctx;
  let agentId = data.agentId;
  if (agentId === "campaign") {
    if (triggerType !== "trigger.plusvibe_reply" && triggerType !== "trigger.inbox_mail") throw new Error("\"The campaign's agent\" only works with the PlusVibe reply or mailbox reply trigger.");
    if (dryRun && (event.campaignId == null || event.campaignId === "")) return { dryUnresolved: true };
    agentId = await resolveCampaignAgentId(workspaceId, triggerType, event);
    if (!agentId) return { reason: NO_CAMPAIGN_AGENT };
  }
  const { rows } = await db.query(`SELECT * FROM ai_agents WHERE id = $1 AND workspace_id = $2 AND is_deleted = FALSE`, [agentId, workspaceId]);
  if (!rows[0]) return { reason: agentId && data.agentId === "campaign" ? NO_CAMPAIGN_AGENT : "The AI agent for this step no longer exists in this workspace." };
  return { agentRow: rows[0] };
}

/** The conversation thread the offer/booking lives on (same id the built-in meeting logic uses). null in a test with no thread. */
async function threadIdOf(ctx) {
  if (ctx.threadId !== undefined) return ctx.threadId;
  const { event, workspaceId, triggerType } = ctx;
  let threadId = cleanText(event.threadId) || null;
  if (triggerType === "trigger.inbox_mail" && event.inboundMessageId) {
    const { rows } = await db.query(`SELECT thread_id FROM messages WHERE id = $1 AND workspace_id = $2`, [event.inboundMessageId, workspaceId]);
    if (rows[0]?.thread_id) threadId = rows[0].thread_id;
  }
  ctx.threadId = threadId;
  return threadId;
}

async function leadNameOf(ctx) {
  if (ctx.leadName !== undefined) return ctx.leadName;
  const { event, workspaceId } = ctx;
  let name = null;
  if (event.leadId) {
    const { rows } = await db.query(`SELECT full_name, first_name, last_name FROM campaign_leads WHERE id = $1 AND workspace_id = $2`, [event.leadId, workspaceId]);
    const r = rows[0];
    name = r ? cleanText(r.full_name) || cleanText([r.first_name, r.last_name].filter(Boolean).join(" ")) || null : null;
  }
  if (!name) {
    const p = event.payload || {};
    name = cleanText(p.lead_name) || cleanText([p.first_name, p.last_name].filter(Boolean).join(" ")) || cleanText(p.from_name) || null;
  }
  ctx.leadName = name;
  return name;
}

function agentTimezone(agentRow) {
  try {
    return meetingBookingService.__testables.resolveAgentSettings(agentRow).timezone;
  } catch {
    return agentRow.timezone || "UTC";
  }
}

function slotLabel(startTime, tz) {
  return messageService.agentHelpers.describeSlot(startTime, tz);
}

async function offerTimes(node, ctx) {
  const { workspaceId, event, dryRun, state } = ctx;
  const data = node.data || {};
  const count = Math.min(Math.max(Number.isInteger(data.count) ? data.count : 3, 1), 5);
  const previousMode = state.meeting?.mode;
  state.meeting = null;

  const ref = await resolveNodeAgent(data, ctx);
  if (ref.dryUnresolved) {
    state.meeting = { mode: "offer", slots: [], dry: true };
    return { output: { wouldOfferTimes: count, agent: "the agent assigned to the reply's campaign", note: "Dry run: the agent and its calendar are chosen from the real reply's campaign. Nothing was offered or saved." } };
  }
  if (!ref.agentRow) {
    state.meeting = { mode: "fallback", url: null };
    return { status: "skipped", output: { reason: "no_agent", detail: ref.reason } };
  }
  const agentRow = ref.agentRow;
  const fallbackUrl = cleanText(agentRow.fallback_meeting_url) || null;
  const fallback = (reason, detail) => {
    state.meeting = { mode: "fallback", url: fallbackUrl };
    return { status: "skipped", output: { reason, detail, fallbackUrl, note: "The reply will point the prospect to the agent's meeting link." } };
  };

  try {
    const threadId = await threadIdOf(ctx);
    if (threadId && (await meetingBookingService.hasBooking(threadId, workspaceId))) {
      return { status: "skipped", output: { reason: "already_booked", detail: "A meeting is already booked on this conversation, so no new times are offered." } };
    }
    const connection = await googleCalendarService.getConnectedForAgent(agentRow.id, workspaceId);
    if (!connection) return fallback("no_calendar", "Google Calendar is not connected for this agent.");
    if (!dryRun && !threadId) return fallback("no_thread", "This message has no conversation thread to attach an offer to.");

    const excludeStarts = threadId ? await meetingBookingService.getOfferedStarts(threadId, workspaceId) : [];
    const slots = await meetingBookingService.findFreeSlots(agentRow, connection, { count, excludeStarts });
    if (!slots || slots.length === 0) return fallback("no_free_slot", "No free time was found on the calendar in the next business days.");

    if (!dryRun) {
      await meetingBookingService.createOffer({ agentId: agentRow.id, threadId, leadEmail: event.leadEmail || null, slots, workspaceId });
    }
    const timezone = agentTimezone(agentRow);
    const labelled = slots.map((slot) => ({ label: slotLabel(slot.startTime, timezone), startTime: slot.startTime }));
    state.meeting = { mode: "offer", slots: labelled, timezone, apologise: previousMode === "unavailable" };
    return { output: { slots: labelled, timezone, excludedEarlierOffers: excludeStarts.length, ...(dryRun ? { note: "Dry run: nothing was saved as an offer." } : {}) } };
  } catch (error) {
    return fallback("calendar_error", error.message || "The calendar could not be read.");
  }
}

async function slotSelectedCondition(node, ctx) {
  const { workspaceId, event, dryRun, state } = ctx;
  const helpers = messageService.agentHelpers;
  const no = (reason, extra = {}) => ({ branch: "no", output: { selected: false, reason, ...extra } });

  const threadId = await threadIdOf(ctx);
  if (!threadId) return no("There is no conversation thread to look for an offer on.");
  const offer = await meetingBookingService.getActiveOffer(threadId, workspaceId);
  if (!offer) return no("No times have been offered on this conversation yet.");
  const slots = Array.isArray(offer.slots) ? offer.slots : [];

  const { rows } = await db.query(`SELECT * FROM ai_agents WHERE id = $1 AND workspace_id = $2 AND is_deleted = FALSE`, [offer.ai_agent_id, workspaceId]);
  const agentRow = rows[0] || null;
  const timezone = agentRow ? agentTimezone(agentRow) : "UTC";
  const labels = slots.map((slot) => slotLabel(slot.startTime, timezone));
  const text = helpers.stripQuotedReply(String(event.body || "")) || "";

  const rule = slotSelection.detect(text, slots, timezone);
  let selected = rule.selected;
  let method = "rule";
  let reason = rule.reason;
  let confidence;

  if (!rule.decided) {
    if (dryRun) {
      reason += " A real run would ask the AI model to decide; nothing was sent to it in this test.";
    } else if (agentRow) {
      try {
        const prompt = slotSelection.buildModelPrompt(labels, text);
        const content = await helpers.askModel(
          { workspace_id: workspaceId, agent_provider: agentRow.ai_provider, agent_model: agentRow.ai_model },
          { system: prompt.system, user: prompt.user, action: "slot_selection" }
        );
        if (content) {
          const answer = slotSelection.parseModelAnswer(content, slots.length);
          confidence = answer.confidence;
          if (answer.selected && answer.confidence >= slotSelection.MODEL_MIN_CONFIDENCE) {
            selected = answer.selected;
            method = "model";
            reason = `The AI model identified option ${selected} (confidence ${answer.confidence}).`;
          } else {
            reason = `The reply is ambiguous and the AI model was not confident enough (${answer.confidence}). ${rule.reason}`;
          }
        } else {
          reason = `${rule.reason} No AI model answer was available.`;
        }
      } catch (error) {
        reason = `${rule.reason} The AI model could not be asked (${error.message}).`;
      }
    }
  }

  if (!selected) return no(reason, { method, offeredTimes: labels, ...(confidence !== undefined ? { confidence } : {}) });
  state.selectedSlot = selected;
  state.offer = offer;
  return { branch: "yes", output: { selected: true, slot: selected, time: labels[selected - 1], method, reason, ...(confidence !== undefined ? { confidence } : {}) } };
}

async function bookMeeting(node, ctx) {
  const { workspaceId, event, dryRun, state } = ctx;
  const data = node.data || {};
  const unavailable = (reason, detail, extra = {}) => {
    state.meeting = { mode: "unavailable" };
    return { branch: "unavailable", status: "skipped", output: { reason, detail, ...extra } };
  };

  const ref = await resolveNodeAgent(data, ctx);
  if (ref.dryUnresolved) {
    state.meeting = { mode: "booked", when: "the time the prospect picks", meetLink: null, dry: true };
    return { branch: "booked", output: { wouldBook: "the time the prospect picks", note: "Dry run: the agent and its calendar are chosen from the real reply's campaign. Nothing was booked." } };
  }
  if (!ref.agentRow) return unavailable("no_agent", ref.reason);
  const agentRow = ref.agentRow;
  const offer = state.offer;
  const index = state.selectedSlot;
  const chosen = offer && index ? (offer.slots || [])[index - 1] : null;

  if (!chosen) {
    if (dryRun) {
      state.meeting = { mode: "booked", when: "the time the prospect picks", meetLink: null, dry: true };
      return { branch: "booked", output: { wouldBook: "the time the prospect picks", note: "Dry run: a real reply must pick one of the offered times. Nothing was booked." } };
    }
    return unavailable("no_selection", "No offered time was selected, so nothing could be booked.");
  }

  const timezone = agentTimezone(agentRow);
  const when = slotLabel(chosen.startTime, timezone);
  const threadId = await threadIdOf(ctx);

  let connection;
  try {
    connection = await googleCalendarService.getConnectedForAgent(agentRow.id, workspaceId);
  } catch (error) {
    return unavailable("calendar_error", error.message, { time: when });
  }
  if (!connection) return unavailable("no_calendar", "Google Calendar is not connected for this agent.", { time: when });

  if (dryRun) {
    let free = false;
    try {
      free = await meetingBookingService.isSlotFree(agentRow, connection, chosen);
    } catch (error) {
      return unavailable("calendar_error", error.message, { time: when });
    }
    if (!free) return unavailable("slot_taken", "That time is no longer free.", { time: when });
    state.meeting = { mode: "booked", when, meetLink: null, dry: true };
    return { branch: "booked", output: { wouldBook: when, note: "Dry run: the time is free, nothing was booked." } };
  }

  // One meeting per thread, even when two replies are processed at once: serialise on the thread.
  const lock = await db.getClient();
  try {
    await lock.query(`SELECT pg_advisory_lock(7102, hashtext($1))`, [`${workspaceId}:${threadId}`]);
    if (threadId && (await meetingBookingService.hasBooking(threadId, workspaceId))) {
      state.meeting = null;
      return { branch: "booked", status: "skipped", output: { reason: "already_booked", detail: "A meeting is already booked on this conversation." } };
    }
    let free = false;
    try {
      free = await meetingBookingService.isSlotFree(agentRow, connection, chosen);
    } catch (error) {
      return unavailable("calendar_error", error.message, { time: when });
    }
    if (!free) return unavailable("slot_taken", "That time is no longer free.", { time: when });

    const booking = await meetingBookingService.bookSlot(agentRow, connection, { ...chosen, threadId }, event.leadEmail || null, await leadNameOf(ctx));
    if (!booking || !booking.success) return unavailable("booking_failed", "The calendar event could not be created.", { time: when });
    await meetingBookingService.markOfferAccepted(offer.id, workspaceId);
    const bookedWhen = slotLabel(booking.startTime || chosen.startTime, timezone);
    state.meeting = { mode: "booked", when: bookedWhen, startTime: booking.startTime || chosen.startTime, meetLink: booking.meetLink || null };
    return { branch: "booked", output: { booked: bookedWhen, meetLink: booking.meetLink || null, eventId: booking.eventId || null } };
  } finally {
    await lock.query(`SELECT pg_advisory_unlock(7102, hashtext($1))`, [`${workspaceId}:${threadId}`]).catch(() => {});
    lock.release();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Notify by email (best effort, internal notification: not counted toward the trial email limit)
// ---------------------------------------------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fillVariables(template, vars) {
  return String(template || "").replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, key) => (vars[key.toLowerCase()] !== undefined ? String(vars[key.toLowerCase()] ?? "") : ""));
}

async function notificationVariables(ctx) {
  const { workspaceId, event, state, triggerType } = ctx;
  const helpers = messageService.agentHelpers;
  let campaign = "";
  try {
    if (event.campaignId != null && event.campaignId !== "") {
      const { rows } =
        triggerType === "trigger.plusvibe_reply"
          ? await db.query(`SELECT name FROM plusvibe_campaigns WHERE plusvibe_campaign_id = $1 AND workspace_id = $2 AND is_deleted = FALSE LIMIT 1`, [String(event.campaignId), workspaceId])
          : Number.isInteger(Number(event.campaignId))
            ? await db.query(`SELECT name FROM campaigns WHERE id = $1 AND workspace_id = $2 AND is_deleted = FALSE LIMIT 1`, [Number(event.campaignId), workspaceId])
            : { rows: [] };
      campaign = rows[0]?.name || "";
    }
  } catch (_) { /* best effort */ }
  let workspace = "";
  try {
    const { rows } = await db.query(`SELECT name FROM workspaces WHERE id = $1`, [workspaceId]);
    workspace = rows[0]?.name || "";
  } catch (_) { /* best effort */ }
  return {
    lead_email: event.leadEmail || "",
    lead_name: (await leadNameOf(ctx).catch(() => null)) || "",
    subject: event.subject || "",
    reply: (helpers.stripQuotedReply(String(event.body || "")) || "").slice(0, 2000),
    agent: state.agentName || "",
    campaign,
    workspace,
    review_link: emailService.appUrl("review"),
  };
}

async function notifyEmail(node, ctx) {
  const { workspaceId, dryRun, state } = ctx;
  const data = node.data || {};
  try {
    const recipients = new Map();
    for (const address of Array.isArray(data.to) ? data.to : []) {
      const a = cleanText(address);
      if (EMAIL_RE.test(a)) recipients.set(a.toLowerCase(), a);
    }
    if (data.notifyOwners) {
      const { rows } = await db.query(
        `SELECT u.email FROM workspace_members m JOIN users u ON u.id = m.user_id
         WHERE m.workspace_id = $1 AND m.role IN ('owner', 'admin') AND COALESCE(u.is_deleted, FALSE) = FALSE ORDER BY m.role, u.id`,
        [workspaceId]
      );
      for (const r of rows) if (EMAIL_RE.test(cleanText(r.email))) recipients.set(r.email.toLowerCase(), r.email);
    }
    // At most one email per recipient per run, even with several notify steps.
    const fresh = [...recipients.keys()].filter((a) => !state.notified.has(a));
    const skippedDuplicates = recipients.size - fresh.length;
    if (fresh.length === 0) {
      return { status: "skipped", output: { reason: recipients.size ? "already_notified" : "no_recipients", detail: recipients.size ? "Every recipient was already emailed in this run." : "No valid recipients." } };
    }

    const vars = await notificationVariables(ctx);
    const subject = fillVariables(data.subject, vars).replace(/[\r\n]+/g, " ").trim().slice(0, 200) || "SendVybe notification";
    const message = fillVariables(data.message, vars);

    if (dryRun) {
      fresh.forEach((a) => state.notified.add(a));
      return { output: { wouldEmail: fresh.map((a) => recipients.get(a)), subject, note: "Dry run: no email was sent." } };
    }

    const paragraphs = message
      .split(/\n{2,}/)
      .map((p) => emailService.escapeHtml(p.trim()).replace(/\n/g, "<br>"))
      .filter(Boolean);
    const textParts = [message];
    if (data.includeReply) {
      if (vars.reply) {
        paragraphs.push(`<strong>Prospect's reply</strong><br>${emailService.escapeHtml(vars.reply).replace(/\n/g, "<br>")}`);
        textParts.push(`Prospect's reply:\n${vars.reply}`);
      }
      if (state.draftBody) {
        paragraphs.push(`<strong>AI reply</strong><br>${emailService.escapeHtml(String(state.draftBody).slice(0, 3000)).replace(/\n/g, "<br>")}`);
        textParts.push(`AI reply:\n${String(state.draftBody).slice(0, 3000)}`);
      }
    }
    const { html } = emailService.renderEmail({ title: subject, preheader: subject, paragraphs });
    const sent = await emailService.send({ to: fresh.map((a) => recipients.get(a)), subject, text: textParts.join("\n\n"), html, category: "workflow_notification" });
    fresh.forEach((a) => state.notified.add(a));
    if (!sent.ok) return { status: "skipped", output: { reason: "send_failed", detail: sent.error || "The email could not be sent.", recipients: fresh.length } };
    return { output: { emailed: fresh.map((a) => recipients.get(a)), subject, ...(skippedDuplicates ? { skippedDuplicates } : {}) } };
  } catch (error) {
    return { status: "skipped", output: { reason: "send_failed", detail: error.message || "The email could not be sent." } };
  }
}

async function sendReply(node, ctx) {
  const { workspaceId, event, dryRun, state } = ctx;
  const data = node.data || {};
  if (!state.draft) return { status: "skipped", output: { reason: "no_draft", detail: "There is no AI reply to send." } };
  if (state.reviewOnly) return { status: "skipped", output: { reason: "review", detail: "The reply was left as a draft for human review." } };

  const leadEmail = state.draft.lead_email || event.leadEmail;
  if (leadEmail && (await suppressionService.isSuppressed(leadEmail, workspaceId))) {
    state.suppressed = true;
    return { status: "skipped", output: { reason: "suppressed", detail: "This address has opted out or is suppressed." } };
  }
  if (dryRun) return { output: { wouldSend: true, via: data.via, to: leadEmail || null, note: "Dry run: nothing was sent." } };

  if (data.via === "plusvibe") {
    if (state.draft.source !== "plusvibe") throw new Error("This reply came from a mailbox, so it cannot be sent through PlusVibe.");
    await messageService.approveDraft(workspaceId, state.draft.id);
    state.sent = true;
    return { output: { via: "plusvibe", draftId: state.draft.id } };
  }

  const draft = state.draft;
  if (draft.source !== "native") throw new Error("This reply came from PlusVibe, so it cannot be sent from a mailbox.");
  // Reply from the mailbox that received the message (keeps the thread intact); fall back to the node's mailbox.
  const mailboxId = draft.mailbox_id || event.mailboxId || data.mailboxId;
  const sent = await nativeAgentReplyService.sendDraft({ ...draft, mailbox_id: mailboxId }, {});
  await db.query(`UPDATE ai_response_drafts SET status = 'Sent', sent_message_id = $3, updated_at = NOW() WHERE id = $1 AND workspace_id = $2`, [draft.id, workspaceId, sent.id]);
  state.sent = true;
  await eventLogService.record({
    eventType: "ai.draft.auto_sent",
    source: "native",
    appWorkspaceId: workspaceId,
    status: "Success",
    aiAgentId: draft.ai_agent_id,
    leadEmail,
    threadId: draft.thread_id,
    draftId: draft.id,
    metadata: { workflow: true },
  });
  return { output: { via: "mailbox", mailboxId, draftId: draft.id, messageId: sent.id } };
}

module.exports = { maybeRun, runWorkflow, findActiveWorkflows, describeTriggerTypes, NODE_TYPES, TRIGGER_TYPES, NODE_HANDLES, MEETING_NODE_TYPES };
