-- 016 — AI SDR: per-thread state (outcome, interest, flags), workspace SDR settings, rules, Brain (business facts),
-- meeting types, follow-up resources, SDR drafts, minimal CRM tasks, and an author tag on messages.
-- Additive and idempotent. Nothing here changes how existing campaigns, agents or workflows behave.

-- One row per inbox thread (a thread is a mailbox + prospect pair, see messages.thread_id).
CREATE TABLE IF NOT EXISTS sdr_thread_state (
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mailbox_id INT NOT NULL,
  thread_id VARCHAR(400) NOT NULL,
  outcome VARCHAR(24) NOT NULL DEFAULT 'none',      -- none | escalated | meeting_booked | do_not_contact | out_of_office | auto_reply | declined
  interest VARCHAR(16) NOT NULL DEFAULT 'none',     -- none | low | medium | high | very_high
  is_favorite BOOLEAN NOT NULL DEFAULT FALSE,
  ai_disabled BOOLEAN NOT NULL DEFAULT FALSE,
  needs_attention BOOLEAN NOT NULL DEFAULT FALSE,
  attention_reason TEXT,
  classified_by VARCHAR(16),                        -- rules | ai | manual
  classified_message_id INT,
  follow_up_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, mailbox_id, thread_id),
  CONSTRAINT sdr_thread_state_outcome_chk CHECK (outcome IN ('none','escalated','meeting_booked','do_not_contact','out_of_office','auto_reply','declined')),
  CONSTRAINT sdr_thread_state_interest_chk CHECK (interest IN ('none','low','medium','high','very_high'))
);
CREATE INDEX IF NOT EXISTS idx_sdr_thread_state_attention ON sdr_thread_state(workspace_id) WHERE needs_attention;
CREATE INDEX IF NOT EXISTS idx_sdr_thread_state_favorite ON sdr_thread_state(workspace_id) WHERE is_favorite;
CREATE INDEX IF NOT EXISTS idx_sdr_thread_state_disabled ON sdr_thread_state(workspace_id) WHERE ai_disabled;

-- Workspace-level AI SDR configuration.
CREATE TABLE IF NOT EXISTS sdr_settings (
  workspace_id INT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,            -- "Process incoming replies"
  require_approval BOOLEAN NOT NULL DEFAULT FALSE,  -- true: replies wait as drafts instead of sending
  knowledge_base TEXT NOT NULL DEFAULT '',
  call_handler_user_id INT REFERENCES users(id) ON DELETE SET NULL,
  booking_link TEXT,
  webhook_url TEXT,
  webhook_secret VARCHAR(80),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Hard rules the SDR must follow; they override the knowledge base.
CREATE TABLE IF NOT EXISTS sdr_rules (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  rule TEXT NOT NULL,
  position INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sdr_rules_ws ON sdr_rules(workspace_id, position);

-- "Brain": structured facts about the business and the sender, injected into every reply.
CREATE TABLE IF NOT EXISTS workspace_brain (
  workspace_id INT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  company_name VARCHAR(220) NOT NULL DEFAULT '',
  website VARCHAR(400) NOT NULL DEFAULT '',
  who_you_sell_to TEXT NOT NULL DEFAULT '',
  what_you_sell TEXT NOT NULL DEFAULT '',
  podcast_name VARCHAR(220) NOT NULL DEFAULT '',
  sender_first_name VARCHAR(120) NOT NULL DEFAULT '',
  sender_last_name VARCHAR(120) NOT NULL DEFAULT '',
  sender_title VARCHAR(180) NOT NULL DEFAULT '',
  sender_email VARCHAR(350) NOT NULL DEFAULT '',
  sender_contact VARCHAR(400) NOT NULL DEFAULT '',
  sender_address VARCHAR(400) NOT NULL DEFAULT '',
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Kinds of calls the SDR can book: name, campaign type, length and calendar title.
CREATE TABLE IF NOT EXISTS meeting_types (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  campaign_type VARCHAR(80) NOT NULL DEFAULT 'Direct',
  duration_minutes INT NOT NULL DEFAULT 30 CHECK (duration_minutes BETWEEN 5 AND 480),
  calendar_title VARCHAR(220) NOT NULL DEFAULT '',
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_types_ws_name ON meeting_types(workspace_id, lower(name));

-- Links the SDR may include in follow-ups (videos, PDFs, case studies). campaign_id NULL = all campaigns.
CREATE TABLE IF NOT EXISTS sdr_resources (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title VARCHAR(220) NOT NULL,
  url TEXT NOT NULL,
  campaign_id INT REFERENCES campaigns(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sdr_resources_ws ON sdr_resources(workspace_id);

-- Replies the SDR wrote but did not send (approval mode, or when it was not confident enough to send).
CREATE TABLE IF NOT EXISTS sdr_drafts (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mailbox_id INT NOT NULL,
  thread_id VARCHAR(400) NOT NULL,
  reply_to_message_id INT,
  subject TEXT,
  body TEXT NOT NULL,
  intent VARCHAR(40),
  interest VARCHAR(16),
  generated_by VARCHAR(40),
  status VARCHAR(12) NOT NULL DEFAULT 'pending',    -- pending | sent | discarded
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sdr_drafts_reply ON sdr_drafts(workspace_id, mailbox_id, thread_id, reply_to_message_id);
CREATE INDEX IF NOT EXISTS idx_sdr_drafts_pending ON sdr_drafts(workspace_id, mailbox_id, thread_id) WHERE status = 'pending';

-- Minimal CRM tasks (the CRM module extends this). The SDR opens one when it escalates a reply.
CREATE TABLE IF NOT EXISTS crm_tasks (
  id BIGSERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title VARCHAR(400) NOT NULL,
  due_at TIMESTAMP,
  record_type VARCHAR(40),                          -- e.g. thread
  record_id VARCHAR(400),
  assignee_user_id INT REFERENCES users(id) ON DELETE SET NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'open',       -- open | done
  source VARCHAR(40),                               -- e.g. ai_sdr
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_ws_status ON crm_tasks(workspace_id, status, due_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_tasks_open_record ON crm_tasks(workspace_id, record_type, record_id, source) WHERE status = 'open' AND record_id IS NOT NULL;

-- Who wrote an outbound message: campaign (sequence send), human (typed in the inbox) or ai (the SDR).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS author VARCHAR(10);
