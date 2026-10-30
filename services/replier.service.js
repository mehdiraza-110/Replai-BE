const db = require("../config/db.config");

const bad = (message) => Object.assign(new Error(message), { statusCode: 400 });

/** The reply types an agent can be configured for. `defaultMode` is what happens when nothing is saved (today's behaviour). */
const REPLY_TYPES = [
  { intent: "interested", label: "Interested", hint: "Shows interest or asks for more information.", defaultMode: "default" },
  { intent: "meeting_request", label: "Meeting request", hint: "Asks for or agrees to a call.", defaultMode: "default" },
  { intent: "question", label: "Question", hint: "Asks something about the offer, price or process.", defaultMode: "default" },
  { intent: "objection", label: "Objection", hint: "Hesitates: has a provider, bad timing, doubts.", defaultMode: "default" },
  { intent: "not_interested", label: "Not interested", hint: "Declines without asking to be removed.", defaultMode: "default" },
  { intent: "referral", label: "Referral", hint: "Points to someone else who should be contacted.", defaultMode: "default" },
  { intent: "wrong_person", label: "Wrong person", hint: "Is not the right contact.", defaultMode: "default" },
  { intent: "out_of_office", label: "Out of office", hint: "Automatic away message.", defaultMode: "no_reply", locked: true },
  { intent: "auto_reply", label: "Other automatic reply", hint: "Bounces and system messages.", defaultMode: "no_reply", locked: true },
  { intent: "unsubscribe", label: "Unsubscribe", hint: "Asks to stop. The address is always suppressed and never answered.", defaultMode: "no_reply", locked: true },
  { intent: "complaint", label: "Complaint or legal", hint: "Hostile, legal or compliance wording.", defaultMode: "escalate" },
  { intent: "other", label: "Anything else", hint: "Replies that fit no other type.", defaultMode: "default" },
];
const INTENTS = REPLY_TYPES.map((type) => type.intent);
const LOCKED = new Set(REPLY_TYPES.filter((type) => type.locked).map((type) => type.intent));
const MODES = ["default", "auto", "draft", "escalate", "no_reply"];
const MAX_INSTRUCTION = 2000;

/** Throws a 404 unless the agent exists in this workspace. agentId null means the built-in AI SDR. */
async function assertAgent(workspaceId, agentId) {
  if (agentId === null || agentId === undefined) return null;
  const id = Number(agentId);
  if (!Number.isInteger(id)) throw bad("Invalid agent.");
  const { rows } = await db.query(`SELECT id FROM ai_agents WHERE id = $1 AND workspace_id = $2 AND is_deleted = FALSE`, [id, workspaceId]);
  if (rows.length === 0) throw Object.assign(new Error("Agent not found."), { statusCode: 404 });
  return id;
}

class ReplierService {
  catalog() {
    return REPLY_TYPES;
  }

  /** Every reply type for an agent, saved values merged over the defaults. */
  async list(workspaceId, agentId = null) {
    const id = await assertAgent(workspaceId, agentId);
    const { rows } = await db.query(
      `SELECT intent, mode, instruction FROM sdr_reply_types WHERE workspace_id = $1 AND COALESCE(agent_id, 0) = $2`,
      [workspaceId, id || 0]
    );
    const saved = new Map(rows.map((row) => [row.intent, row]));
    return REPLY_TYPES.map((type) => ({
      ...type,
      mode: saved.get(type.intent)?.mode ?? type.defaultMode,
      instruction: saved.get(type.intent)?.instruction ?? "",
      customised: saved.has(type.intent),
    }));
  }

  /** Replaces the whole set. Locked types (unsubscribe, automatic replies) can take an instruction-free "no_reply" only. */
  async save(workspaceId, agentId, items) {
    const id = await assertAgent(workspaceId, agentId);
    if (!Array.isArray(items)) throw bad("replyTypes must be a list.");
    const cleaned = [];
    for (const item of items) {
      if (!INTENTS.includes(item?.intent)) throw bad(`Unknown reply type "${item?.intent}".`);
      const mode = String(item.mode || "default");
      if (!MODES.includes(mode)) throw bad(`Unknown mode "${mode}".`);
      if (LOCKED.has(item.intent) && !["default", "no_reply"].includes(mode)) throw bad("This reply type can never be answered.");
      const instruction = String(item.instruction ?? "").trim().slice(0, MAX_INSTRUCTION);
      cleaned.push({ intent: item.intent, mode: LOCKED.has(item.intent) ? "no_reply" : mode, instruction: LOCKED.has(item.intent) ? "" : instruction });
    }
    const client = await db.getClient();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM sdr_reply_types WHERE workspace_id = $1 AND COALESCE(agent_id, 0) = $2`, [workspaceId, id || 0]);
      for (const item of cleaned) {
        const type = REPLY_TYPES.find((entry) => entry.intent === item.intent);
        // A row that equals the default carries no information, so it is not stored.
        if (item.mode === type.defaultMode && !item.instruction) continue;
        await client.query(
          `INSERT INTO sdr_reply_types (workspace_id, agent_id, intent, mode, instruction) VALUES ($1, $2, $3, $4, $5)`,
          [workspaceId, id, item.intent, item.mode, item.instruction]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return this.list(workspaceId, id);
  }

  /** What the reply pipeline needs: the rule for one intent (null when nothing is saved) and the playbook text for the prompt. */
  async rulesFor(workspaceId, agentId = null) {
    const { rows } = await db.query(
      `SELECT intent, mode, instruction FROM sdr_reply_types WHERE workspace_id = $1 AND COALESCE(agent_id, 0) = $2`,
      [workspaceId, Number(agentId) || 0]
    );
    const byIntent = new Map(rows.map((row) => [row.intent, row]));
    return {
      get: (intent) => byIntent.get(intent) || null,
      playbook: () =>
        rows
          .filter((row) => row.instruction.trim() && !LOCKED.has(row.intent))
          .map((row) => `- When the prospect's reply is "${row.intent}": ${row.instruction.trim()}`)
          .join("\n"),
    };
  }

  /** Campaigns with the agent that answers them: a legacy agent when assigned, otherwise the built-in AI SDR. */
  async coverage(workspaceId) {
    const { rows } = await db.query(
      `SELECT c.id, c.name, c.status, c.ai_agent_id, a.name AS agent_name
       FROM campaigns c LEFT JOIN ai_agents a ON a.id = c.ai_agent_id AND a.workspace_id = c.workspace_id AND a.is_deleted = FALSE
       WHERE c.workspace_id = $1 AND COALESCE(c.is_warmup, FALSE) = FALSE
       ORDER BY c.id DESC LIMIT 200`,
      [workspaceId]
    );
    return rows.map((row) => ({ id: row.id, name: row.name, status: row.status, agentId: row.ai_agent_id || null, agentName: row.agent_name || null }));
  }

  async assignCampaign(workspaceId, campaignId, agentId) {
    const id = await assertAgent(workspaceId, agentId);
    const { rowCount } = await db.query(`UPDATE campaigns SET ai_agent_id = $3 WHERE id = $1 AND workspace_id = $2`, [Number(campaignId), workspaceId, id]);
    if (rowCount === 0) throw Object.assign(new Error("Campaign not found."), { statusCode: 404 });
    return this.coverage(workspaceId);
  }
}

module.exports = new ReplierService();
module.exports.REPLY_TYPES = REPLY_TYPES;
