-- 028 — Support tickets (feedback widget) + the Asana connection their tasks are created through.
-- Additive and idempotent. users.id is an INT here, so every user reference is INT; tickets themselves use a UUID
-- so a ticket id reveals nothing about how many exist.

CREATE TABLE IF NOT EXISTS feedback (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id      INT,                                  -- workspace the reporter was in (context for the team)
  issue_name        TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  page_url          TEXT,
  recording_key     TEXT,                                 -- S3 key
  recording_store   TEXT CHECK (recording_store IS NULL OR recording_store IN ('s3', 'local')),
  recording_mime    TEXT,
  recording_bytes   BIGINT,
  duration_seconds  INTEGER,
  transcript        TEXT,
  transcript_error  TEXT,
  asana_task_gid    TEXT,
  asana_task_url    TEXT,
  asana_task_error  TEXT,                                 -- why the automatic task failed; staff only
  status            TEXT NOT NULL DEFAULT 'pending',
  status_updated_at TIMESTAMPTZ,
  status_updated_by INT REFERENCES users(id) ON DELETE SET NULL,
  user_read_at      TIMESTAMPTZ,                          -- when the sender last opened it (drives "unread")
  ticket_number     BIGSERIAL,                            -- human number: #1, #2, ...
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_feedback_user_created   ON feedback (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_status_created ON feedback (status, created_at DESC);

CREATE TABLE IF NOT EXISTS feedback_replies (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feedback_id UUID NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  author_id   INT REFERENCES users(id) ON DELETE SET NULL,  -- NULL for the automatic acknowledgement
  is_staff    BOOLEAN NOT NULL DEFAULT FALSE,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_feedback_replies_feedback ON feedback_replies (feedback_id, created_at);

-- Platform-wide key/value config (the ticket settings live under 'feedback.config').
CREATE TABLE IF NOT EXISTS platform_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by INT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A platform admin's own Asana personal access token (AES-256-GCM, never returned to the browser).
CREATE TABLE IF NOT EXISTS asana_connections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_enc       TEXT NOT NULL,
  account_gid     TEXT,
  account_name    TEXT,
  account_email   TEXT,
  status          TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'needs_reconnect')),
  last_error      TEXT,
  last_checked_at TIMESTAMPTZ,
  created_by      INT REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_asana_connections_user_account
  ON asana_connections (created_by, account_gid) WHERE account_gid IS NOT NULL;
