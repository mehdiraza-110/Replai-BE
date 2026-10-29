-- 019 — CRM (tasks, deals, companies, notes) and Dashboard saved views. Additive and idempotent.
-- People are the lead library (lead_contacts), appointments are sdr_bookings, scheduled messages are
-- sdr_thread_state.follow_up_at and lead submissions are sdr_forwards, so none of those get a table here.

-- Due times are absolute instants (same reason as follow_up_at in 017): a plain TIMESTAMP reads back shifted on a non-UTC server.
DO $$ BEGIN
  IF (SELECT data_type FROM information_schema.columns WHERE table_name = 'crm_tasks' AND column_name = 'due_at') = 'timestamp without time zone' THEN
    ALTER TABLE crm_tasks ALTER COLUMN due_at TYPE TIMESTAMPTZ USING due_at AT TIME ZONE 'UTC';
  END IF;
END $$;
ALTER TABLE crm_tasks ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE crm_tasks ADD COLUMN IF NOT EXISTS record_label VARCHAR(300);
ALTER TABLE crm_tasks ADD COLUMN IF NOT EXISTS created_by INT REFERENCES users(id) ON DELETE SET NULL;
-- idx_crm_tasks_open_record (016) is left as is: manual tasks have a NULL source, and NULLs never collide in a unique index.

CREATE TABLE IF NOT EXISTS crm_companies (
  id BIGSERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name VARCHAR(220) NOT NULL,
  website VARCHAR(300),
  industry VARCHAR(160),
  size VARCHAR(60),
  location VARCHAR(220),
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_companies_ws_name ON crm_companies(workspace_id, lower(name));

CREATE TABLE IF NOT EXISTS crm_deals (
  id BIGSERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title VARCHAR(300) NOT NULL,
  value NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (value >= 0),
  stage VARCHAR(20) NOT NULL DEFAULT 'lead',
  company_id BIGINT REFERENCES crm_companies(id) ON DELETE SET NULL,
  person_email VARCHAR(350),
  person_name VARCHAR(220),
  owner_user_id INT REFERENCES users(id) ON DELETE SET NULL,
  expected_close DATE,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMP,
  CONSTRAINT crm_deals_stage_chk CHECK (stage IN ('lead','qualified','meeting','proposal','won','lost'))
);
CREATE INDEX IF NOT EXISTS idx_crm_deals_ws_stage ON crm_deals(workspace_id, stage);

CREATE TABLE IF NOT EXISTS crm_notes (
  id BIGSERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  record_type VARCHAR(40),
  record_id VARCHAR(400),
  record_label VARCHAR(300),
  author_user_id INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_crm_notes_ws_time ON crm_notes(workspace_id, id DESC);

-- Dashboard views: an ordered widget list, shared by the workspace. Exactly one is the default.
CREATE TABLE IF NOT EXISTS dashboard_views (
  id BIGSERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  widgets JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboard_views_ws_name ON dashboard_views(workspace_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboard_views_default ON dashboard_views(workspace_id) WHERE is_default;
