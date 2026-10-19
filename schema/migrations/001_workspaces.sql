-- 001_workspaces.sql — multi-tenancy: workspaces, members, workspace_id on every tenant table.
--
-- ADDITIVE AND SAFE FOR THE LIVE APP. Nothing is dropped or renamed. Existing code keeps working because
-- every tenant table gets `workspace_id ... DEFAULT <Koval Group id>`: old code that doesn't set it yet
-- inserts into Koval Group exactly as before. A later migration drops those defaults once all code paths
-- set workspace_id explicitly.
--
-- Review before running. Idempotent: re-running is a no-op.
--   psql "$DATABASE" -v ON_ERROR_STOP=1 -f schema/migrations/001_workspaces.sql

BEGIN;

-- ── Platform-level flag ────────────────────────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- ── Workspaces ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workspaces (
  id SERIAL PRIMARY KEY,
  name VARCHAR(220) NOT NULL,
  slug VARCHAR(120) NOT NULL UNIQUE,
  type VARCHAR(20) NOT NULL DEFAULT 'organization' CHECK (type IN ('organization', 'individual')),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  -- Product access, managed by super admin. Members can never exceed what the workspace has.
  auto_responder_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  cold_mailer_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE
);

-- ── Membership (a user may belong to several workspaces; one is "active" per session) ─────────
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  -- Per-member product access, e.g. {"auto_responder": true, "cold_mailer": false}. Owners/admins ignore it.
  permissions JSONB NOT NULL DEFAULT '{"auto_responder": true, "cold_mailer": true}'::jsonb,
  invited_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id);

-- ── Seed "Koval Group" and enrol the existing users ─────────────────────────────────────────
-- r7dragunov@gmail.com (id 1) owns it: it holds the current PlusVibe setup. mahdi.r@kovalai.ai (id 8) is
-- the first super admin. Everyone else keeps working as an admin member, so nothing changes for them.
INSERT INTO workspaces (name, slug, type, created_by)
SELECT 'Koval Group', 'koval-group', 'organization', (SELECT id FROM users WHERE email = 'r7dragunov@gmail.com')
WHERE NOT EXISTS (SELECT 1 FROM workspaces WHERE slug = 'koval-group');

INSERT INTO workspace_members (workspace_id, user_id, role)
SELECT w.id, u.id, CASE WHEN u.email = 'r7dragunov@gmail.com' THEN 'owner' ELSE 'admin' END
FROM users u CROSS JOIN workspaces w
WHERE w.slug = 'koval-group' AND COALESCE(u.is_deleted, FALSE) = FALSE
ON CONFLICT DO NOTHING;

UPDATE users SET is_super_admin = TRUE WHERE email = 'mahdi.r@kovalai.ai';

-- ── workspace_id on every tenant table, backfilled to Koval Group ───────────────────────────
DO $$
DECLARE
  koval_id INT;
  t TEXT;
  tenant_tables TEXT[] := ARRAY[
    'ai_agents', 'knowledge_sources', 'ai_agent_knowledge_sources',
    -- NOT plusvibe_integrations / plusvibe_webhook_events / plusvibe_lead_profiles / event_logs: those already have a
    -- workspace_id holding the PlusVibe workspace id. They get app_workspace_id in 002.
    'plusvibe_campaigns',
    'ai_response_drafts', 'ghl_integrations',
    'calendar_connections', 'meeting_bookings', 'meeting_slot_offers',
    'domains', 'ses_account_requests', 'mailboxes', 'warmup_strategies',
    'campaigns', 'campaign_leads', 'campaign_followups', 'suppressions',
    'inbound_messages', 'messages'
  ];
BEGIN
  SELECT id INTO koval_id FROM workspaces WHERE slug = 'koval-group';
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS workspace_id INT REFERENCES workspaces(id)', t);
    EXECUTE format('UPDATE %I SET workspace_id = %s WHERE workspace_id IS NULL', t, koval_id);
    -- Transitional default so un-migrated code paths keep landing in Koval Group. Dropped in a later migration.
    EXECUTE format('ALTER TABLE %I ALTER COLUMN workspace_id SET DEFAULT %s', t, koval_id);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(workspace_id)', 'idx_' || t || '_workspace', t);
  END LOOP;
END $$;

COMMIT;

-- Sanity checks to run afterwards (should all be 0):
--   SELECT 'domains', count(*) FROM domains WHERE workspace_id IS NULL
--   UNION ALL SELECT 'mailboxes', count(*) FROM mailboxes WHERE workspace_id IS NULL
--   UNION ALL SELECT 'messages', count(*) FROM messages WHERE workspace_id IS NULL;
