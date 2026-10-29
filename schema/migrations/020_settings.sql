-- 020 — Settings: per-user preferences, per-workspace settings, a settings change log, API tokens, email templates,
-- CRM custom fields and call/meeting outcomes, workspace snapshots. Additive and idempotent.

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  notifications JSONB NOT NULL DEFAULT '{}'::jsonb,
  appearance JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspace_settings (
  workspace_id INT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  color VARCHAR(9),
  conferencing JSONB NOT NULL DEFAULT '{}'::jsonb,
  sharing JSONB NOT NULL DEFAULT '{}'::jsonb,
  cold_email JSONB NOT NULL DEFAULT '{}'::jsonb,
  call_analyzer JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- A short history of who changed which setting (shown on the Sharing page).
CREATE TABLE IF NOT EXISTS settings_audit (
  id BIGSERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  area VARCHAR(40) NOT NULL,
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_settings_audit_ws ON settings_audit(workspace_id, area, id DESC);

-- Only a hash of each token is stored; the plain token is shown once when it is created.
CREATE TABLE IF NOT EXISTS api_tokens (
  id BIGSERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind VARCHAR(10) NOT NULL CHECK (kind IN ('personal', 'workspace')),
  name VARCHAR(120) NOT NULL,
  prefix VARCHAR(16) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_ws ON api_tokens(workspace_id, kind) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS email_templates (
  id BIGSERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id INT REFERENCES users(id) ON DELETE SET NULL,
  name VARCHAR(160) NOT NULL,
  subject VARCHAR(400) NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  shared BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_templates_ws_name ON email_templates(workspace_id, lower(name));

CREATE TABLE IF NOT EXISTS crm_custom_fields (
  id BIGSERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity VARCHAR(20) NOT NULL CHECK (entity IN ('deal', 'company')),
  key VARCHAR(60) NOT NULL,
  label VARCHAR(120) NOT NULL,
  field_type VARCHAR(10) NOT NULL CHECK (field_type IN ('text', 'number', 'date', 'select', 'checkbox')),
  options JSONB NOT NULL DEFAULT '[]'::jsonb,
  position INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, entity, key)
);
ALTER TABLE crm_deals ADD COLUMN IF NOT EXISTS custom JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE crm_companies ADD COLUMN IF NOT EXISTS custom JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS crm_outcomes (
  id BIGSERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name VARCHAR(80) NOT NULL,
  group_name VARCHAR(10) NOT NULL DEFAULT 'call' CHECK (group_name IN ('call', 'meeting')),
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  position INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_outcomes_ws_name ON crm_outcomes(workspace_id, group_name, lower(name));

-- Reusable configuration bundles. workspace_id NULL would mean built-in, but built-ins live in code; only custom ones are rows.
CREATE TABLE IF NOT EXISTS workspace_snapshots (
  id BIGSERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name VARCHAR(160) NOT NULL,
  description TEXT,
  version INT NOT NULL DEFAULT 1,
  items JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_snapshots_ws_name ON workspace_snapshots(workspace_id, lower(name));

-- The result of a call or meeting, chosen from crm_outcomes, recorded on the booking.
ALTER TABLE sdr_bookings ADD COLUMN IF NOT EXISTS outcome VARCHAR(80);
