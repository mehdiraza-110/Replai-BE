-- 015 — Lead library (AI Cold Mailer "Leads" module). Leads a workspace uploads to send cold email to, kept in named
-- lists ("blocks") so they can be reused across campaigns. Separate from the Auto Responder's PlusVibe leads page.
-- campaign_leads stays the per-campaign send queue; creating a campaign copies library leads into it. Additive and idempotent.
CREATE TABLE IF NOT EXISTS lead_lists (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name VARCHAR(160) NOT NULL,
  description TEXT,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_lists_ws_name ON lead_lists(workspace_id, lower(name));

CREATE TABLE IF NOT EXISTS lead_contacts (
  id BIGSERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  list_id INT NOT NULL REFERENCES lead_lists(id) ON DELETE CASCADE,
  email VARCHAR(350) NOT NULL,
  full_name VARCHAR(220),
  first_name VARCHAR(120),
  last_name VARCHAR(120),
  company VARCHAR(220),
  role VARCHAR(180),
  phone VARCHAR(60),
  location VARCHAR(220),
  website VARCHAR(300),
  linkedin_url VARCHAR(400),
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (list_id, email)
);
CREATE INDEX IF NOT EXISTS idx_lead_contacts_ws_created ON lead_contacts(workspace_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_lead_contacts_ws_email ON lead_contacts(workspace_id, email);
CREATE INDEX IF NOT EXISTS idx_lead_contacts_list ON lead_contacts(list_id, id);
-- Used by the per-lead "campaigns" lookup and the suppression check on the library.
CREATE INDEX IF NOT EXISTS idx_campaign_leads_ws_email ON campaign_leads(workspace_id, email);
