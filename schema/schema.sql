CREATE TABLE users (
	id SERIAL PRIMARY KEY,
	first_name VARCHAR(300),
	last_name VARCHAR(300),
	email VARCHAR(350) NOT NULL,
	phone VARCHAR(350),
	password_hash VARCHAR(500) NOT NULL,
	profile_image VARCHAR(500),
	is_verified boolean,
	is_admin_user BOOLEAN DEFAULT FALSE,
	created_at TIMESTAMP,
	updated_at TIMESTAMP,
	is_deleted boolean
);


-- Roles table
CREATE TABLE roles (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) UNIQUE NOT NULL
);

-- Role assignments
CREATE TABLE user_roles (
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  role_id INT REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

-- Routes (permissions)
CREATE TABLE routes (
  id SERIAL PRIMARY KEY,
  route VARCHAR(255) UNIQUE NOT NULL
);

-- Role permissions (which roles can access which routes)
CREATE TABLE role_permissions (
  role_id INT REFERENCES roles(id) ON DELETE CASCADE,
  route_id INT REFERENCES routes(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, route_id)
);

INSERT INTO roles (name) VALUES ('admin');
INSERT INTO roles (name) VALUES ('agent');

CREATE TABLE IF NOT EXISTS ai_agents (
  id SERIAL PRIMARY KEY,
  name VARCHAR(180) NOT NULL,
  description TEXT,
  role VARCHAR(180) NOT NULL,
  persona TEXT NOT NULL,
  tone VARCHAR(80) NOT NULL DEFAULT 'Consultative',
  response_style VARCHAR(80) NOT NULL DEFAULT 'Concise',
  company_name VARCHAR(220) NOT NULL,
  website VARCHAR(500),
  industry VARCHAR(180),
  value_proposition TEXT,
  objective VARCHAR(180) NOT NULL,
  success_criteria TEXT,
  language VARCHAR(80) NOT NULL DEFAULT 'English',
  auto_detect_language BOOLEAN NOT NULL DEFAULT TRUE,
  response_rules TEXT,
  sales_rules TEXT,
  safety_rules TEXT,
  knowledge_sources TEXT,
  training_examples TEXT,
  ai_provider VARCHAR(80) NOT NULL,
  ai_model VARCHAR(180) NOT NULL,
  automation_mode VARCHAR(80) NOT NULL DEFAULT 'AI + Approval',
  confidence_threshold NUMERIC(5,2) NOT NULL DEFAULT 95 CHECK (confidence_threshold >= 0 AND confidence_threshold <= 100),
  require_human_review BOOLEAN NOT NULL DEFAULT TRUE,
  auto_reply_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  assigned_inbox_name VARCHAR(220),
  assigned_workspace_name VARCHAR(220),
  status VARCHAR(40) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Paused', 'Draft', 'Archived')),
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_ai_agents_status ON ai_agents(status) WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_ai_agents_provider_model ON ai_agents(ai_provider, ai_model) WHERE is_deleted = FALSE;

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id SERIAL PRIMARY KEY,
  title VARCHAR(240) NOT NULL,
  category VARCHAR(160),
  source_type VARCHAR(40) NOT NULL DEFAULT 'Text' CHECK (source_type IN ('Text', 'Document', 'URL', 'FAQ')),
  owner VARCHAR(180),
  status VARCHAR(40) NOT NULL DEFAULT 'Review' CHECK (status IN ('Published', 'Review', 'Draft')),
  content_text TEXT,
  usage_guidance TEXT,
  source_url VARCHAR(700),
  file_name VARCHAR(350),
  file_mime_type VARCHAR(180),
  file_size BIGINT,
  file_storage_path VARCHAR(700),
  chunks_count INT NOT NULL DEFAULT 0,
  last_indexed_at TIMESTAMP,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_knowledge_sources_status ON knowledge_sources(status, updated_at DESC) WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_knowledge_sources_category ON knowledge_sources(category) WHERE is_deleted = FALSE;

CREATE TABLE IF NOT EXISTS ai_agent_knowledge_sources (
  ai_agent_id INT REFERENCES ai_agents(id) ON DELETE CASCADE,
  knowledge_source_id INT REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ai_agent_id, knowledge_source_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_knowledge_sources_source ON ai_agent_knowledge_sources(knowledge_source_id);

CREATE TABLE IF NOT EXISTS plusvibe_integrations (
  id SERIAL PRIMARY KEY,
  workspace_id VARCHAR(120) NOT NULL,
  workspace_name VARCHAR(220),
  api_key_scope VARCHAR(40) NOT NULL DEFAULT 'workspace',
  webhook_event_type VARCHAR(120) NOT NULL DEFAULT 'ALL_EMAIL_REPLIES',
  api_key_encrypted TEXT NOT NULL,
  api_key_iv VARCHAR(64) NOT NULL,
  api_key_tag VARCHAR(64) NOT NULL,
  webhook_url VARCHAR(700),
  connection_status VARCHAR(40) NOT NULL DEFAULT 'Disconnected',
  api_status VARCHAR(40) NOT NULL DEFAULT 'Unknown',
  webhook_status VARCHAR(40) NOT NULL DEFAULT 'Not configured',
  connected_inboxes INT NOT NULL DEFAULT 0,
  synced_campaigns INT NOT NULL DEFAULT 0,
  last_api_request TIMESTAMP,
  last_webhook_at TIMESTAMP,
  last_sync_at TIMESTAMP,
  last_error TEXT,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_plusvibe_integrations_workspace ON plusvibe_integrations(workspace_id) WHERE is_deleted = FALSE;

CREATE TABLE IF NOT EXISTS plusvibe_webhook_events (
  id SERIAL PRIMARY KEY,
  integration_id INT REFERENCES plusvibe_integrations(id) ON DELETE SET NULL,
  webhook_id VARCHAR(160),
  webhook_event VARCHAR(120),
  workspace_id VARCHAR(120),
  email_account_id VARCHAR(120),
  campaign_id VARCHAR(120),
  lead_email VARCHAR(350),
  thread_id VARCHAR(180),
  source_message_id VARCHAR(180),
  payload JSONB NOT NULL,
  received_at TIMESTAMP NOT NULL DEFAULT NOW(),
  processing_status VARCHAR(40) NOT NULL DEFAULT 'Received',
  processing_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_plusvibe_webhook_events_workspace ON plusvibe_webhook_events(workspace_id, received_at DESC);

CREATE TABLE IF NOT EXISTS plusvibe_campaigns (
  id SERIAL PRIMARY KEY,
  integration_id INT REFERENCES plusvibe_integrations(id) ON DELETE CASCADE,
  plusvibe_campaign_id VARCHAR(160) NOT NULL,
  name VARCHAR(350) NOT NULL,
  status VARCHAR(80),
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_lead_sent TIMESTAMP,
  last_lead_replied TIMESTAMP,
  assigned_ai_agent_id INT REFERENCES ai_agents(id) ON DELETE SET NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (integration_id, plusvibe_campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_plusvibe_campaigns_agent ON plusvibe_campaigns(assigned_ai_agent_id) WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_plusvibe_campaigns_status ON plusvibe_campaigns(status) WHERE is_deleted = FALSE;

CREATE TABLE IF NOT EXISTS plusvibe_lead_profiles (
  id SERIAL PRIMARY KEY,
  workspace_id VARCHAR(120),
  lead_email VARCHAR(350) NOT NULL,
  lead_name VARCHAR(220),
  company_name VARCHAR(220),
  role_title VARCHAR(220),
  last_thread_id VARCHAR(180),
  last_campaign_id VARCHAR(160),
  first_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, lead_email)
);

CREATE INDEX IF NOT EXISTS idx_plusvibe_lead_profiles_email ON plusvibe_lead_profiles(lead_email);
CREATE INDEX IF NOT EXISTS idx_plusvibe_lead_profiles_thread ON plusvibe_lead_profiles(last_thread_id);

CREATE TABLE IF NOT EXISTS ai_response_drafts (
  id SERIAL PRIMARY KEY,
  integration_id INT REFERENCES plusvibe_integrations(id) ON DELETE SET NULL,
  ai_agent_id INT REFERENCES ai_agents(id) ON DELETE SET NULL,
  plusvibe_campaign_id VARCHAR(160),
  thread_id VARCHAR(180) NOT NULL,
  reply_to_message_id VARCHAR(180) NOT NULL,
  lead_email VARCHAR(350),
  subject VARCHAR(700),
  from_email VARCHAR(350),
  to_email VARCHAR(350),
  body TEXT NOT NULL,
  confidence NUMERIC(5,2) NOT NULL DEFAULT 72 CHECK (confidence >= 0 AND confidence <= 100),
  status VARCHAR(40) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Sent')),
  generated_by VARCHAR(60) NOT NULL DEFAULT 'local-agent',
  generation_error TEXT,
  raw_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  sent_message_id VARCHAR(180),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (thread_id, reply_to_message_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_response_drafts_thread ON ai_response_drafts(thread_id, status) WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_ai_response_drafts_agent ON ai_response_drafts(ai_agent_id) WHERE is_deleted = FALSE;

CREATE TABLE IF NOT EXISTS ghl_integrations (
  id SERIAL PRIMARY KEY,
  location_id VARCHAR(120) NOT NULL,
  location_name VARCHAR(220),
  api_key_encrypted TEXT NOT NULL,
  api_key_iv VARCHAR(64) NOT NULL,
  api_key_tag VARCHAR(64) NOT NULL,
  connection_status VARCHAR(40) NOT NULL DEFAULT 'Disconnected',
  api_status VARCHAR(40) NOT NULL DEFAULT 'Unknown',
  synced_leads INT NOT NULL DEFAULT 0,
  last_api_request TIMESTAMP,
  last_sync_at TIMESTAMP,
  last_error TEXT,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_ghl_integrations_location ON ghl_integrations(location_id) WHERE is_deleted = FALSE;

CREATE TABLE IF NOT EXISTS event_logs (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(120) NOT NULL,
  source VARCHAR(80) NOT NULL DEFAULT 'system',
  status VARCHAR(40) NOT NULL DEFAULT 'Success' CHECK (status IN ('Success', 'Processing', 'Failed', 'Skipped')),
  workspace_id VARCHAR(120),
  workspace_name VARCHAR(220),
  campaign_id VARCHAR(160),
  campaign_name VARCHAR(350),
  ai_agent_id INT REFERENCES ai_agents(id) ON DELETE SET NULL,
  ai_agent_name VARCHAR(180),
  lead_email VARCHAR(350),
  thread_id VARCHAR(180),
  message_id VARCHAR(180),
  draft_id INT REFERENCES ai_response_drafts(id) ON DELETE SET NULL,
  duration_ms INT,
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_logs_created ON event_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_logs_type ON event_logs(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_logs_thread ON event_logs(thread_id, created_at DESC);
