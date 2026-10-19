-- 012 — run order for workflows. Several workflows may now be active for the same campaign/mailbox/trigger; they run
-- in ascending priority (lower number first). Additive and idempotent.
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 100;
