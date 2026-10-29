-- 017 — AI SDR: calendar booking, scheduled follow-ups and per-campaign overrides. Additive and idempotent.

-- A calendar connection can belong to a workspace member (the person who takes the calls), not only to a legacy AI agent.
ALTER TABLE calendar_connections ALTER COLUMN ai_agent_id DROP NOT NULL;
ALTER TABLE calendar_connections ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_connections_user ON calendar_connections(workspace_id, user_id, provider) WHERE user_id IS NOT NULL;

-- When a member can take calls. weekly = {"mon": [["09:00","17:00"]], ...}; an empty list means unavailable that day.
CREATE TABLE IF NOT EXISTS user_availability (
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  timezone VARCHAR(80) NOT NULL DEFAULT 'UTC',
  weekly JSONB NOT NULL DEFAULT '{"mon":[["09:00","17:00"]],"tue":[["09:00","17:00"]],"wed":[["09:00","17:00"]],"thu":[["09:00","17:00"]],"fri":[["09:00","17:00"]],"sat":[],"sun":[]}',
  buffer_before_min INT NOT NULL DEFAULT 15 CHECK (buffer_before_min BETWEEN 0 AND 120),
  buffer_after_min INT NOT NULL DEFAULT 15 CHECK (buffer_after_min BETWEEN 0 AND 120),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, user_id)
);

-- Times offered to a prospect on a thread, and what they picked.
CREATE TABLE IF NOT EXISTS sdr_slot_offers (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mailbox_id INT NOT NULL,
  thread_id VARCHAR(400) NOT NULL,
  handler_user_id INT REFERENCES users(id) ON DELETE SET NULL,
  meeting_type_id INT REFERENCES meeting_types(id) ON DELETE SET NULL,
  timezone VARCHAR(80) NOT NULL DEFAULT 'UTC',
  slots JSONB NOT NULL,                              -- [{startTime, endTime}] ISO strings
  status VARCHAR(12) NOT NULL DEFAULT 'offered',     -- offered | accepted | superseded
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sdr_slot_offers_thread ON sdr_slot_offers(workspace_id, mailbox_id, thread_id, status);

CREATE TABLE IF NOT EXISTS sdr_bookings (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mailbox_id INT NOT NULL,
  thread_id VARCHAR(400) NOT NULL,
  handler_user_id INT REFERENCES users(id) ON DELETE SET NULL,
  meeting_type_id INT REFERENCES meeting_types(id) ON DELETE SET NULL,
  lead_email VARCHAR(350),
  lead_name VARCHAR(220),
  google_event_id VARCHAR(200),
  meet_link TEXT,
  scheduled_start TIMESTAMPTZ NOT NULL,
  scheduled_end TIMESTAMPTZ NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'booked',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sdr_bookings_thread ON sdr_bookings(workspace_id, mailbox_id, thread_id);

-- A draft can carry a booking that is only made when a person approves the draft.
ALTER TABLE sdr_drafts ADD COLUMN IF NOT EXISTS booking JSONB;

-- Follow-ups: when the next one is due, how many went out, and whether a person or the SDR scheduled it.
ALTER TABLE sdr_thread_state ADD COLUMN IF NOT EXISTS followup_count INT NOT NULL DEFAULT 0;
ALTER TABLE sdr_thread_state ADD COLUMN IF NOT EXISTS followup_by VARCHAR(10);
CREATE INDEX IF NOT EXISTS idx_sdr_thread_state_followup ON sdr_thread_state(follow_up_at) WHERE follow_up_at IS NOT NULL;

ALTER TABLE sdr_settings ADD COLUMN IF NOT EXISTS followup_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE sdr_settings ADD COLUMN IF NOT EXISTS followup_delay_days INT NOT NULL DEFAULT 2 CHECK (followup_delay_days BETWEEN 1 AND 30);
ALTER TABLE sdr_settings ADD COLUMN IF NOT EXISTS followup_max INT NOT NULL DEFAULT 2 CHECK (followup_max BETWEEN 0 AND 5);

-- Per-campaign overrides of the workspace SDR settings. NULL means "inherit".
CREATE TABLE IF NOT EXISTS sdr_campaign_overrides (
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id INT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  enabled BOOLEAN,
  require_approval BOOLEAN,
  meeting_type_id INT REFERENCES meeting_types(id) ON DELETE SET NULL,
  booking_link TEXT,
  notes TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, campaign_id)
);

-- Audit trail for forwarded messages.
CREATE TABLE IF NOT EXISTS sdr_forwards (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  message_id INT NOT NULL,
  to_address VARCHAR(350) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sdr_forwards_ws_time ON sdr_forwards(workspace_id, created_at);

-- Follow-up times are absolute instants written as UTC, so the column must carry a time zone; as a plain TIMESTAMP,
-- a server not running in UTC reads them back shifted by its offset and follow-ups fire hours early or late.
ALTER TABLE sdr_thread_state ALTER COLUMN follow_up_at TYPE TIMESTAMPTZ USING follow_up_at AT TIME ZONE 'UTC';
