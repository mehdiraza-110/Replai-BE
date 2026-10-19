-- 013 — audit trail of admin domain assignments (a super admin moves a domain, with its mailboxes, from one
-- workspace to another). One row per domain per assignment. Additive and idempotent.
CREATE TABLE IF NOT EXISTS domain_assignments (
  id SERIAL PRIMARY KEY,
  domain_id INT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  from_workspace_id INT REFERENCES workspaces(id) ON DELETE SET NULL,
  to_workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assigned_by INT REFERENCES users(id) ON DELETE SET NULL,
  order_id INT REFERENCES provisioning_requests(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_domain_assignments_domain ON domain_assignments(domain_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_domain_assignments_to ON domain_assignments(to_workspace_id);
