-- 005 — per-workspace AI keys, PlusVibe webhook secret, platform-AI flag. Additive and idempotent.

-- Whether a workspace may fall back to the platform's own AI keys (env). Koval Group keeps working as-is;
-- every new workspace starts with no AI connected and must add its own key (super admin can flip this).
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS platform_ai_enabled BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE workspaces SET platform_ai_enabled = TRUE WHERE slug = 'koval-group';

-- One encrypted key per workspace + provider (same AES-256-GCM scheme as plusvibe_integrations.api_key_*).
CREATE TABLE IF NOT EXISTS workspace_ai_keys (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider VARCHAR(40) NOT NULL CHECK (provider IN ('openai', 'anthropic', 'gemini')),
  api_key_encrypted TEXT NOT NULL,
  api_key_iv VARCHAR(64) NOT NULL,
  api_key_tag VARCHAR(64) NOT NULL,
  key_preview VARCHAR(40),
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, provider)
);

-- PlusVibe webhook protection. Existing integrations keep working without a token (enforced = FALSE) until the
-- owner updates the webhook URL in PlusVibe and turns enforcement on; new integrations are enforced from the start.
ALTER TABLE plusvibe_integrations ADD COLUMN IF NOT EXISTS webhook_secret VARCHAR(80);
ALTER TABLE plusvibe_integrations ADD COLUMN IF NOT EXISTS webhook_secret_enforced BOOLEAN NOT NULL DEFAULT FALSE;
