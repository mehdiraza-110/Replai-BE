-- 008 — plans, trials, quota limits and usage tracking. Additive and idempotent.
--
-- plan: 'standard' (no expiry) or 'trial' (ends at trial_ends_at). limits is enforced whenever a key is present,
-- regardless of plan: {"ai_requests":{"limit":1000,"period":"day"},"domains":{"limit":10,"period":"day"},
-- "mailboxes":{"limit":20,"period":"day"},"workflows":{"limit":5,"period":"total"}}. A missing key or a null limit = unlimited.
-- period "day" = rolling 24 hours; "total" = a plain cap on what exists.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS plan VARCHAR(20) NOT NULL DEFAULT 'standard';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_plan_check') THEN
    ALTER TABLE workspaces ADD CONSTRAINT workspaces_plan_check CHECK (plan IN ('trial', 'standard'));
  END IF;
END $$;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMP;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMP;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS limits JSONB NOT NULL DEFAULT '{}'::jsonb;

-- One row per counted action (AI request, domain created, mailbox created) for rolling-window limits.
CREATE TABLE IF NOT EXISTS workspace_usage_events (
  id BIGSERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind VARCHAR(30) NOT NULL CHECK (kind IN ('ai_requests', 'domains', 'mailboxes')),
  quantity INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  meta JSONB
);
CREATE INDEX IF NOT EXISTS idx_usage_events_window ON workspace_usage_events(workspace_id, kind, created_at DESC);
