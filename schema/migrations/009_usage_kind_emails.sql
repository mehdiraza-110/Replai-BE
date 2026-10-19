-- 009 — adds the 'emails' usage kind (emails sent through our own mailboxes, for rolling-window limits). Idempotent.
ALTER TABLE workspace_usage_events DROP CONSTRAINT IF EXISTS workspace_usage_events_kind_check;
ALTER TABLE workspace_usage_events ADD CONSTRAINT workspace_usage_events_kind_check
  CHECK (kind IN ('ai_requests', 'domains', 'mailboxes', 'emails'));
