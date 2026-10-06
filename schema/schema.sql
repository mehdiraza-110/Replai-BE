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

ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS fallback_meeting_url TEXT;
ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS meeting_duration_minutes INT DEFAULT 30;
ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS working_hours_start TIME DEFAULT '09:00';
ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS working_hours_end TIME DEFAULT '17:00';
ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) DEFAULT 'UTC';

CREATE TABLE IF NOT EXISTS calendar_connections (
  id SERIAL PRIMARY KEY,
  ai_agent_id INT NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  provider VARCHAR(32) NOT NULL DEFAULT 'google',
  google_email VARCHAR(255),
  access_token_encrypted TEXT,
  access_token_iv VARCHAR(64),
  access_token_tag VARCHAR(64),
  refresh_token_encrypted TEXT,
  refresh_token_iv VARCHAR(64),
  refresh_token_tag VARCHAR(64),
  token_expiry TIMESTAMPTZ,
  calendar_id VARCHAR(255) DEFAULT 'primary',
  status VARCHAR(32) NOT NULL DEFAULT 'connected',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT calendar_connections_agent_provider_key UNIQUE (ai_agent_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_calendar_connections_agent ON calendar_connections(ai_agent_id, status);

CREATE TABLE IF NOT EXISTS meeting_bookings (
  id SERIAL PRIMARY KEY,
  ai_agent_id INT NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  thread_id VARCHAR(255),
  lead_email VARCHAR(255),
  google_event_id VARCHAR(255),
  meet_link TEXT,
  scheduled_start TIMESTAMPTZ,
  scheduled_end TIMESTAMPTZ,
  status VARCHAR(32) NOT NULL DEFAULT 'booked',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meeting_bookings_thread ON meeting_bookings(thread_id);
CREATE INDEX IF NOT EXISTS idx_meeting_bookings_agent ON meeting_bookings(ai_agent_id, created_at DESC);

-- Slots the agent has proposed to a lead on a thread. The lead's next reply is
-- matched against `slots`; the chosen one is booked and the offer is accepted.
CREATE TABLE IF NOT EXISTS meeting_slot_offers (
  id SERIAL PRIMARY KEY,
  ai_agent_id INT NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  thread_id VARCHAR(255) NOT NULL,
  lead_email VARCHAR(255),
  slots JSONB NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'offered' CHECK (status IN ('offered', 'accepted', 'superseded')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meeting_slot_offers_thread ON meeting_slot_offers(thread_id, status);

CREATE TABLE IF NOT EXISTS domains (
  id SERIAL PRIMARY KEY,
  domain VARCHAR(255) UNIQUE NOT NULL,
  registrar VARCHAR(120) NOT NULL DEFAULT 'Route53',
  dns_provider VARCHAR(120) NOT NULL DEFAULT 'Route53',
  hosted_zone_id VARCHAR(120),
  aws_region VARCHAR(60) NOT NULL DEFAULT 'us-east-1',
  ses_identity_arn VARCHAR(500),
  mail_from_subdomain VARCHAR(255),
  spf_status VARCHAR(40) NOT NULL DEFAULT 'Not started' CHECK (spf_status IN ('Not started', 'Pending', 'Success', 'Failed')),
  dkim_status VARCHAR(40) NOT NULL DEFAULT 'Not started' CHECK (dkim_status IN ('Not started', 'Pending', 'Success', 'Failed')),
  dmarc_status VARCHAR(40) NOT NULL DEFAULT 'Not started' CHECK (dmarc_status IN ('Not started', 'Pending', 'Success', 'Failed')),
  mx_status VARCHAR(40) NOT NULL DEFAULT 'Not started' CHECK (mx_status IN ('Not started', 'Pending', 'Success', 'Failed')),
  mail_from_status VARCHAR(40) NOT NULL DEFAULT 'Not started' CHECK (mail_from_status IN ('Not started', 'Pending', 'Success', 'Failed')),
  provider VARCHAR(80) NOT NULL DEFAULT 'Amazon SES',
  status VARCHAR(40) NOT NULL DEFAULT 'Provisioning' CHECK (status IN ('Provisioning', 'Pending Verification', 'Verified', 'Failed')),
  reputation VARCHAR(40) NOT NULL DEFAULT 'Unknown',
  last_checked_at TIMESTAMP,
  last_error TEXT,
  raw_dkim_tokens JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_domains_status ON domains(status) WHERE is_deleted = FALSE;

ALTER TABLE domains ADD COLUMN IF NOT EXISTS configuration_set_name VARCHAR(160);
ALTER TABLE domains ADD COLUMN IF NOT EXISTS emails_sent_14d INT;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS emails_delivered_14d INT;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS emails_bounced_14d INT;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS emails_complained_14d INT;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS bounce_rate NUMERIC(6,3);
ALTER TABLE domains ADD COLUMN IF NOT EXISTS complaint_rate NUMERIC(6,3);
ALTER TABLE domains ADD COLUMN IF NOT EXISTS delivery_rate NUMERIC(6,3);
ALTER TABLE domains ADD COLUMN IF NOT EXISTS reputation_checked_at TIMESTAMP;

CREATE TABLE IF NOT EXISTS ses_account_requests (
  id SERIAL PRIMARY KEY,
  aws_region VARCHAR(60) NOT NULL,
  mail_type VARCHAR(40) NOT NULL,
  website_url VARCHAR(1000) NOT NULL,
  use_case_description TEXT,
  additional_contact_emails JSONB NOT NULL DEFAULT '[]'::jsonb,
  status VARCHAR(40) NOT NULL DEFAULT 'Submitted',
  error_message TEXT,
  requested_by INT REFERENCES users(id) ON DELETE SET NULL,
  requested_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ses_account_requests_requested_at ON ses_account_requests(requested_at DESC);

CREATE TABLE IF NOT EXISTS mailboxes (
  id SERIAL PRIMARY KEY,
  domain_id INT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  email VARCHAR(350) UNIQUE NOT NULL,
  local_part VARCHAR(120) NOT NULL,
  display_name VARCHAR(220),
  status VARCHAR(40) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Paused', 'Error')),
  daily_limit INT NOT NULL DEFAULT 20,
  sent_today INT NOT NULL DEFAULT 0,
  warmup_stage VARCHAR(40) NOT NULL DEFAULT 'New' CHECK (warmup_stage IN ('New', 'Ramping', 'Steady State', 'Paused')),
  reputation_status VARCHAR(40) NOT NULL DEFAULT 'Healthy' CHECK (reputation_status IN ('Healthy', 'Watch', 'At Risk')),
  last_sent_at TIMESTAMP,
  last_checked_at TIMESTAMP,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_mailboxes_domain ON mailboxes(domain_id) WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_mailboxes_status ON mailboxes(status) WHERE is_deleted = FALSE;

CREATE TABLE IF NOT EXISTS warmup_strategies (
  id SERIAL PRIMARY KEY,
  name VARCHAR(220) NOT NULL,
  description TEXT,
  start_daily_limit INT NOT NULL DEFAULT 5,
  steady_state_daily_limit INT NOT NULL DEFAULT 40,
  increment_per_stage INT NOT NULL DEFAULT 5,
  stage_duration_days INT NOT NULL DEFAULT 7,
  safety_tiers JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_ai_generated BOOLEAN NOT NULL DEFAULT FALSE,
  ai_rationale TEXT,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_warmup_strategies_active ON warmup_strategies(id) WHERE is_deleted = FALSE;

ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS warmup_strategy_id INT REFERENCES warmup_strategies(id) ON DELETE SET NULL;
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS warmup_started_at TIMESTAMP;
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS warmup_last_tick_at TIMESTAMP;
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS warmup_last_action TEXT;

CREATE INDEX IF NOT EXISTS idx_mailboxes_warmup_strategy ON mailboxes(warmup_strategy_id) WHERE is_deleted = FALSE;

CREATE TABLE IF NOT EXISTS campaigns (
  id SERIAL PRIMARY KEY,
  name VARCHAR(220) NOT NULL,
  objective TEXT,
  subject VARCHAR(500) NOT NULL,
  body TEXT NOT NULL,
  mailbox_mode VARCHAR(20) NOT NULL DEFAULT 'all' CHECK (mailbox_mode IN ('all', 'specific')),
  mailbox_ids INT[] NOT NULL DEFAULT '{}',
  daily_limit_override INT,
  sending_days JSONB NOT NULL DEFAULT '[]'::jsonb,
  window_start VARCHAR(5) NOT NULL DEFAULT '09:00',
  window_end VARCHAR(5) NOT NULL DEFAULT '17:00',
  timezone VARCHAR(80) NOT NULL DEFAULT 'UTC',
  ai_agent_id INT REFERENCES ai_agents(id) ON DELETE SET NULL,
  human_review_required BOOLEAN NOT NULL DEFAULT TRUE,
  status VARCHAR(40) NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Paused', 'Draft', 'Completed')),
  sent_today INT NOT NULL DEFAULT 0,
  sent_total INT NOT NULL DEFAULT 0,
  reply_count INT NOT NULL DEFAULT 0,
  bounce_count INT NOT NULL DEFAULT 0,
  started_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status) WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_campaigns_created_at ON campaigns(created_at DESC) WHERE is_deleted = FALSE;

CREATE TABLE IF NOT EXISTS campaign_leads (
  id SERIAL PRIMARY KEY,
  campaign_id INT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  email VARCHAR(350) NOT NULL,
  status VARCHAR(40) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Sent', 'Replied', 'Bounced')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaign_leads_campaign ON campaign_leads(campaign_id);

ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS full_name VARCHAR(220);
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS first_name VARCHAR(120);
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS last_name VARCHAR(120);
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS company VARCHAR(220);
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS role VARCHAR(180);
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS phone VARCHAR(60);
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS raw_data JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS campaign_followups (
  id SERIAL PRIMARY KEY,
  campaign_id INT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  step_order INT NOT NULL DEFAULT 1,
  delay_days INT NOT NULL DEFAULT 3,
  body TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaign_followups_campaign ON campaign_followups(campaign_id);

-- Suppression list: emails that must never be sent to again (unsubscribe, complaint, hard bounce, manual).
-- See PlusVibe-Plan.md section 12A for the full spec this implements.
CREATE TABLE IF NOT EXISTS suppressions (
  id SERIAL PRIMARY KEY,
  email VARCHAR(350) NOT NULL UNIQUE,
  reason VARCHAR(40) NOT NULL CHECK (reason IN ('unsubscribed', 'complained', 'hard_bounce', 'manual')),
  source VARCHAR(40) NOT NULL CHECK (source IN ('link_click', 'list_unsubscribe_header', 'reply_keyword', 'ses_complaint', 'ses_bounce', 'manual')),
  campaign_id INT REFERENCES campaigns(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_suppressions_email ON suppressions(email);

-- Raw inbound replies to Cold Mailer sends, received via SES -> S3 -> SNS (see
-- services/sesInboundEmail.service.js). Logged for audit even when no action is taken.
CREATE TABLE IF NOT EXISTS inbound_messages (
  id SERIAL PRIMARY KEY,
  message_id VARCHAR(500),
  from_address VARCHAR(350) NOT NULL,
  to_address VARCHAR(350),
  subject TEXT,
  body_text TEXT,
  s3_bucket VARCHAR(255),
  s3_key VARCHAR(1000),
  is_opt_out BOOLEAN NOT NULL DEFAULT FALSE,
  received_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inbound_messages_from ON inbound_messages(from_address);

-- Outbound send pipeline support (services/campaignSend.service.js): track per-lead send
-- state beyond the original Pending/Sent/Replied/Bounced set, and per-lead retry bookkeeping.
ALTER TABLE campaign_leads DROP CONSTRAINT IF EXISTS campaign_leads_status_check;
ALTER TABLE campaign_leads ADD CONSTRAINT campaign_leads_status_check
  CHECK (status IN ('Pending', 'Sent', 'Replied', 'Bounced', 'Suppressed', 'Failed'));
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS sent_at TIMESTAMP;
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS send_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS mailbox_id INT REFERENCES mailboxes(id) ON DELETE SET NULL;
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS ses_message_id VARCHAR(500);
-- The actual RFC822 Message-ID header used on the outbound send (not SES's internal
-- ses_message_id above) — kept for reference/debugging even though thread grouping
-- below uses mailbox+lead-email instead of In-Reply-To/References header matching.
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS rfc_message_id VARCHAR(500);

-- Per-mailbox inbox (app-native, not a real IMAP/SMTP mailbox): every outbound send and
-- every inbound reply for a mailbox, so the "open inbox" UI on the Mailboxes page has
-- something to show. Threading is deliberately simple: (mailbox, lead email) rather than
-- In-Reply-To/References header matching, since we control both send and receive and
-- already tie campaign_leads to the mailbox that sent to it.
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  mailbox_id INT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  direction VARCHAR(20) NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  campaign_id INT REFERENCES campaigns(id) ON DELETE SET NULL,
  campaign_lead_id INT REFERENCES campaign_leads(id) ON DELETE SET NULL,
  thread_id VARCHAR(400) NOT NULL,
  message_id VARCHAR(500),
  in_reply_to VARCHAR(500),
  from_address VARCHAR(350) NOT NULL,
  to_address VARCHAR(350) NOT NULL,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_mailbox ON messages(mailbox_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(mailbox_id, thread_id, created_at);

-- Always-on warmup lane (services/warmupPool.service.js, campaignSend.service.js): every
-- mailbox keeps sending a fixed daily quota of real, single-use warmup emails forever,
-- separate from and in addition to real market campaign sends, once it finishes ramping.
ALTER TABLE warmup_strategies ADD COLUMN IF NOT EXISTS steady_state_market_daily_limit INT NOT NULL DEFAULT 20;

-- `daily_limit`/`sent_today` (existing columns) remain the warmup-lane counters, ramped
-- 5 -> steady_state_daily_limit by warmup.service.js exactly as before. These new columns
-- are the separate market-lane counters, unlocked (set > 0) only once ramp completes.
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS market_daily_limit INT NOT NULL DEFAULT 0;
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS market_sent_today INT NOT NULL DEFAULT 0;

-- Marks the one singleton "always active" campaign that holds the shared warmup lead
-- pool in its own campaign_leads rows (single-use — a lead is never re-sent once its
-- status flips to Sent) rather than a customer-uploaded list, and whose sends draw
-- mailbox capacity from the warmup lane (daily_limit/sent_today) instead of the market
-- lane. See services/warmupPool.service.js.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS is_warmup BOOLEAN NOT NULL DEFAULT FALSE;

-- Maildoso (SMTP/IMAP) mailboxes. `provider` selects the send/receive path: 'ses' (default,
-- existing behaviour) or 'maildoso' (nodemailer SMTP out, IMAP polling in — see
-- services/mailTransport.service.js and services/imapInbox.service.js). Credentials are
-- AES-256-GCM encrypted (utils/secretBox.util.js); `external_id` is Maildoso's own id.
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS provider VARCHAR(32) NOT NULL DEFAULT 'ses';
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS external_id VARCHAR(80);
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS smtp_host VARCHAR(255);
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS smtp_port INT;
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS imap_host VARCHAR(255);
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS imap_port INT;
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS password_encrypted TEXT;
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS imap_last_uid BIGINT NOT NULL DEFAULT 0;
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS imap_uid_validity BIGINT;
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS imap_last_polled_at TIMESTAMP;
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS imap_last_error TEXT;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS external_id VARCHAR(80);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mailboxes_provider_external ON mailboxes(provider, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mailboxes_provider ON mailboxes(provider) WHERE is_deleted = FALSE;

-- IMAP-detected hard bounces (services/imapInbox.service.js) suppress with source 'imap_bounce'.
ALTER TABLE suppressions DROP CONSTRAINT IF EXISTS suppressions_source_check;
ALTER TABLE suppressions ADD CONSTRAINT suppressions_source_check
  CHECK (source IN ('link_click', 'list_unsubscribe_header', 'reply_keyword', 'ses_complaint', 'ses_bounce', 'imap_bounce', 'manual'));

-- Follow-up sequencing (services/campaignSend.service.js sendDueFollowUps): which follow-up
-- step a lead has received, when it was last emailed, and a retry backoff after a failed send.
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS followup_step INT NOT NULL DEFAULT 0;
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS last_contacted_at TIMESTAMP;
ALTER TABLE campaign_leads ADD COLUMN IF NOT EXISTS followup_retry_after TIMESTAMP;
UPDATE campaign_leads SET last_contacted_at = sent_at WHERE last_contacted_at IS NULL AND sent_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_campaign_leads_followup_due ON campaign_leads(campaign_id, mailbox_id, last_contacted_at) WHERE status = 'Sent';

-- Postal (self-hosted, services/postalEvents.service.js) hard bounces suppress with source 'postal_bounce'.
-- mailboxes.provider / domains.provider are free text, so 'postal' / 'Postal' need no DDL.
ALTER TABLE suppressions DROP CONSTRAINT IF EXISTS suppressions_source_check;
ALTER TABLE suppressions ADD CONSTRAINT suppressions_source_check
  CHECK (source IN ('link_click', 'list_unsubscribe_header', 'reply_keyword', 'ses_complaint', 'ses_bounce', 'imap_bounce', 'postal_bounce', 'manual'));

-- AI auto-reply drafts for the native (Maildoso) inbox, alongside the existing PlusVibe ones.
-- services/nativeAgentReply.service.js: source = 'native', mailbox_id = the mailbox that got the reply.
ALTER TABLE ai_response_drafts ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'plusvibe';
ALTER TABLE ai_response_drafts ADD COLUMN IF NOT EXISTS mailbox_id INT REFERENCES mailboxes(id) ON DELETE CASCADE;

-- Postal webhook bounces (services/postalEvents.service.js) suppress with source 'postal_bounce'.
ALTER TABLE suppressions DROP CONSTRAINT IF EXISTS suppressions_source_check;
ALTER TABLE suppressions ADD CONSTRAINT suppressions_source_check
  CHECK (source IN ('link_click', 'list_unsubscribe_header', 'reply_keyword', 'ses_complaint', 'ses_bounce', 'imap_bounce', 'postal_bounce', 'manual'));
