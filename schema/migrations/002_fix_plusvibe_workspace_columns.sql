-- 002_fix_plusvibe_workspace_columns.sql — repair for 001.
--
-- plusvibe_integrations, plusvibe_webhook_events, plusvibe_lead_profiles and event_logs already had a
-- `workspace_id VARCHAR(120)` holding the PlusVibe workspace id (e.g. '6a1703921bed093e5b6c79b6'). 001 skipped
-- adding its column there but still backfilled NULLs to '1' and set DEFAULT '1'. This undoes that and adds our
-- tenant column under a non-colliding name, `app_workspace_id`, on those four tables only.
-- (A later cleanup can rename the PlusVibe column to pv_workspace_id once the code is updated.)

BEGIN;

-- Undo the damage. '1' is never a valid PlusVibe workspace id, so every such row was touched by 001 (or inserted
-- from the bad default afterwards); those rows were NULL before.
UPDATE plusvibe_webhook_events  SET workspace_id = NULL WHERE workspace_id = '1';
UPDATE plusvibe_lead_profiles   SET workspace_id = NULL WHERE workspace_id = '1';
UPDATE event_logs               SET workspace_id = NULL WHERE workspace_id = '1';
UPDATE plusvibe_integrations    SET workspace_id = workspace_id WHERE FALSE; -- NOT NULL column: no row was changed

ALTER TABLE plusvibe_integrations   ALTER COLUMN workspace_id DROP DEFAULT;
ALTER TABLE plusvibe_webhook_events ALTER COLUMN workspace_id DROP DEFAULT;
ALTER TABLE plusvibe_lead_profiles  ALTER COLUMN workspace_id DROP DEFAULT;
ALTER TABLE event_logs              ALTER COLUMN workspace_id DROP DEFAULT;

-- Our tenant column on those four tables.
DO $$
DECLARE
  koval_id INT;
  t TEXT;
BEGIN
  SELECT id INTO koval_id FROM workspaces WHERE slug = 'koval-group';
  FOREACH t IN ARRAY ARRAY['plusvibe_integrations', 'plusvibe_webhook_events', 'plusvibe_lead_profiles', 'event_logs'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS app_workspace_id INT REFERENCES workspaces(id)', t);
    EXECUTE format('UPDATE %I SET app_workspace_id = %s WHERE app_workspace_id IS NULL', t, koval_id);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN app_workspace_id SET DEFAULT %s', t, koval_id);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(app_workspace_id)', 'idx_' || t || '_app_workspace', t);
  END LOOP;
END $$;

COMMIT;
