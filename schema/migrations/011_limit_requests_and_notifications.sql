-- 011 — "more limits" requests and de-duplication of system emails. Additive and idempotent.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'provisioning_requests_type_check'
             AND conrelid = 'provisioning_requests'::regclass AND pg_get_constraintdef(oid) NOT LIKE '%limits%') THEN
    ALTER TABLE provisioning_requests DROP CONSTRAINT provisioning_requests_type_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'provisioning_requests_type_check' AND conrelid = 'provisioning_requests'::regclass) THEN
    ALTER TABLE provisioning_requests ADD CONSTRAINT provisioning_requests_type_check CHECK (type IN ('domains', 'mailboxes', 'limits'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS workspace_email_notifications (
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key VARCHAR(120) NOT NULL,
  sent_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (workspace_id, key)
);
