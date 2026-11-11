-- 027 — Warm-up network priority. A domain assigned to a client that has never been through the warm-up network is
-- enrolled with priority_at set: the engine serves those mailboxes first (seed slots are the scarce resource) and, once
-- one earns "ready", releases it to the client automatically. NULL = a normal, manually released mailbox. Additive and idempotent.
ALTER TABLE warmnet_mailboxes ADD COLUMN IF NOT EXISTS priority_at TIMESTAMP;
