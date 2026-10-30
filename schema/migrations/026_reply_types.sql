-- 026 — Replier: per reply-type behaviour for the agents that answer prospect replies.
-- One row per (workspace, agent, intent). agent_id NULL = the built-in AI SDR; a number = a legacy ai_agents row.
-- mode: default (current behaviour) | auto (send without approval) | draft (always wait for review) |
--       escalate (no reply, flag a person and open a task) | no_reply (do nothing).
-- instruction is extra guidance the model follows when the reply is of that type. Idempotent.
CREATE TABLE IF NOT EXISTS sdr_reply_types (
  id           SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id     INT REFERENCES ai_agents(id) ON DELETE CASCADE,
  intent       VARCHAR(40) NOT NULL,
  mode         VARCHAR(20) NOT NULL DEFAULT 'default' CHECK (mode IN ('default', 'auto', 'draft', 'escalate', 'no_reply')),
  instruction  TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sdr_reply_types ON sdr_reply_types (workspace_id, COALESCE(agent_id, 0), intent);
