-- 007 — domain / mailbox ordering (request and approve). Additive and idempotent.
CREATE TABLE IF NOT EXISTS provisioning_requests (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type VARCHAR(20) NOT NULL CHECK (type IN ('domains', 'mailboxes')),
  quantity INT NOT NULL CHECK (quantity > 0 AND quantity <= 500),
  -- {preferredDomains?: string[], mailboxesPerDomain?: number, mailboxNames?: string[], notes?: string, domainIds?: number[]}
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'approved', 'in_progress', 'fulfilled', 'rejected', 'cancelled')),
  admin_notes TEXT,
  requested_by INT REFERENCES users(id) ON DELETE SET NULL,
  handled_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  fulfilled_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_provisioning_requests_workspace ON provisioning_requests(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_provisioning_requests_status ON provisioning_requests(status, created_at DESC);
