-- 004_drop_global_suppression_email_unique.sql — step 2 of 2. Run only AFTER the code using
-- ON CONFLICT (workspace_id, email) is live. Lets two workspaces each hold their own opt-out for one address.
ALTER TABLE suppressions DROP CONSTRAINT IF EXISTS suppressions_email_key;
