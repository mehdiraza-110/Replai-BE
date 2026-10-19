const db = require("../config/db.config");
const suppressionService = require("./suppression.service");
const messageService = require("./message.service");
const nativeAgentReplyService = require("./nativeAgentReply.service");
const eventLogService = require("./eventLog.service");

/**
 * Workflow executor (opt-in automation, see API-Contract-Workspaces.md "Workflows").
 *
 * maybeRun() is called by the existing pipelines at their trigger points. A workspace with no active workflow for
 * that trigger type (or whose trigger filter does not match the event) gets `{ handled: false }` and the caller
 * keeps doing exactly what it does today. When a workflow runs, every node reuses an existing service:
 *   save_to_db   -> the persistence the built-in path already performed (verified, plus the PlusVibe lead profile)
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

const TRIGGER_TYPES = {
  "trigger.inbox_mail": {
    label: "Reply lands in a mailbox",
    description: "A prospect replies to one of your own (Maildoso/SES/IMAP) mailboxes.",
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
];

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
    const workflow = await findActiveWorkflow(workspaceId, triggerType, normalizeEvent(triggerType, event));
    if (!workflow) return { handled: false };
    return await runWorkflow(workflow, { event, dryRun });
  } catch (error) {
    console.error("Workflow lookup failed, falling back to built-in handling:", error.message);
    return { handled: false, status: "failed", error: error.message };
  }
}

/** Runs one specific workflow (used by maybeRun and by POST /workflows/:id/test). Never throws. */
async function runWorkflow(workflow, { event = {}, dryRun = false } = {}) {
  const graph = workflow.graph || { nodes: [], edges: [] };
  const trigger = (graph.nodes || []).find((n) => String(n.type).startsWith("trigger."));
  const triggerType = trigger?.type || "unknown";
  const ev = normalizeEvent(triggerType, event);
  const steps = [];
  const state = { draft: null, draftCreated: false, reviewOnly: false, sent: false, suppressed: false };
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
    const ctx = { workspaceId: workflow.workspace_id, event: ev, dryRun, state, triggerType };

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

      for (const edge of graph.edges) {
        if (edge.source !== nodeId) continue;
        if (node.type.startsWith("condition.") && edge.sourceHandle !== result.branch) continue;
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
 * Among the active workflows of this trigger type whose scope matches the event, the MOST SPECIFIC wins: a list that
 * contains the event's campaign/mailbox beats "all"; ties go to the lowest workflow id.
 */
async function findActiveWorkflow(workspaceId, triggerType, event) {
  const { rows } = await db.query(
    `SELECT * FROM workflows WHERE workspace_id = $1 AND is_active = TRUE AND is_deleted = FALSE ORDER BY id`,
    [workspaceId]
  );
  let best = null;
  let bestRank = 0;
  for (const workflow of rows) {
    const trigger = (workflow.graph?.nodes || []).find((n) => n.type === triggerType);
    if (!trigger) continue;
    const rank = triggerMatchRank(trigger, event);
    if (rank > bestRank) { best = workflow; bestRank = rank; } // rows are id-ordered, so ties keep the lowest id
  }
  return best;
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

async function executeNode(node, ctx) {
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
  const result = await messageService.generateDraftFromWebhook(workspaceId, event.payload || {}, overrideOf(data, agentRow));
  if (!result || result.status !== "Generated") {
    return { status: "skipped", output: { reason: "no_draft", detail: result?.reason || "No draft was generated for this reply." } };
  }
  state.draft = { source: "plusvibe", id: result.draft.id, lead_email: event.leadEmail };
  state.draftCreated = true;
  // The built-in PlusVibe path only ever drafts (drafts wait in Human Review; approveDraft is a manual action), so
  // "agent_default" == "review" here.
  if (mode === "review" || mode === "agent_default") state.reviewOnly = true;
  return { output: { draftId: result.draft.id, mode, confidence: Number(result.draft.confidence), ...(mode === "agent_default" ? { note: "PlusVibe replies are never auto-sent by the agent's own settings; left as a draft for human review." } : {}) } };
}

function overrideOf(data, agentRow) {
  return { agentId: agentRow.id, tone: data.tone || undefined, instructions: data.instructions || undefined };
}

async function aiAgentNative({ data, ctx, agentRow, mode }) {
  const { workspaceId, event, state } = ctx;

  const result = await nativeAgentReplyService.handleInbound({
    mailboxId: event.mailboxId,
    campaignId: event.campaignId || null,
    leadId: event.leadId || null,
    inboundMessageId: event.inboundMessageId,
    workspaceId,
    override: overrideOf(data, agentRow),
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

module.exports = { maybeRun, runWorkflow, describeTriggerTypes, NODE_TYPES, TRIGGER_TYPES };
