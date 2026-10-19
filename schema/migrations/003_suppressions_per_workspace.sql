-- 003_suppressions_per_workspace.sql — step 1 of 2. Additive: a suppression is unique per (workspace, email).
-- Run BEFORE deploying code that uses ON CONFLICT (workspace_id, email). The old global UNIQUE(email) stays in
-- place until 004 so the previously deployed code keeps working during the rollout.
ALTER TABLE suppressions ALTER COLUMN workspace_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS suppressions_workspace_email_key ON suppressions (workspace_id, email);
