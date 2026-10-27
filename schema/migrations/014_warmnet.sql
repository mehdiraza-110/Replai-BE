-- 014 — Warm-up network (super admin "Deliverability" module). Our own mailboxes exchange real conversations with
-- seed inboxes (real Gmail/Outlook/Yahoo accounts we control) that open, rescue from spam, star and reply, so each
-- new domain builds an engagement history before any prospect is emailed. Additive and idempotent.

CREATE TABLE IF NOT EXISTS warmnet_settings (
  id INT PRIMARY KEY CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_tick_at TIMESTAMP,
  last_tick_summary JSONB,
  last_seed_poll_at TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
INSERT INTO warmnet_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Seed inboxes. Credentials are AES-256-GCM encrypted with MAILBOX_ENCRYPTION_KEY (same box as mailbox passwords).
CREATE TABLE IF NOT EXISTS warmnet_seeds (
  id SERIAL PRIMARY KEY,
  email VARCHAR(320) NOT NULL UNIQUE,
  display_name VARCHAR(200),
  provider VARCHAR(20) NOT NULL DEFAULT 'gmail' CHECK (provider IN ('gmail', 'outlook', 'yahoo', 'other')),
  imap_host VARCHAR(255) NOT NULL,
  imap_port INT NOT NULL DEFAULT 993,
  smtp_host VARCHAR(255) NOT NULL,
  smtp_port INT NOT NULL DEFAULT 465,
  username VARCHAR(320) NOT NULL,
  password_encrypted TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'error')),
  daily_receive_cap INT NOT NULL DEFAULT 60,
  last_polled_at TIMESTAMP,
  last_error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Per-mailbox warm-up state. One row per enrolled mailbox.
CREATE TABLE IF NOT EXISTS warmnet_mailboxes (
  mailbox_id INT PRIMARY KEY REFERENCES mailboxes(id) ON DELETE CASCADE,
  state VARCHAR(20) NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'warming', 'paused', 'ready', 'released')),
  enrolled_at TIMESTAMP NOT NULL DEFAULT NOW(),
  started_at TIMESTAMP,
  ready_at TIMESTAMP,
  released_at TIMESTAMP,
  ramp_day INT NOT NULL DEFAULT 1,
  held_days INT NOT NULL DEFAULT 0,
  today_date DATE,
  today_sent INT NOT NULL DEFAULT 0,
  total_sent INT NOT NULL DEFAULT 0,
  consecutive_failures INT NOT NULL DEFAULT 0,
  pause_reason TEXT,
  last_sent_at TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_warmnet_mailboxes_state ON warmnet_mailboxes(state);

-- Every warm-up email, both directions. rfc_message_id is how a seed copy / a seed reply is matched back.
CREATE TABLE IF NOT EXISTS warmnet_messages (
  id BIGSERIAL PRIMARY KEY,
  mailbox_id INT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  seed_id INT NOT NULL REFERENCES warmnet_seeds(id) ON DELETE CASCADE,
  direction VARCHAR(12) NOT NULL CHECK (direction IN ('to_seed', 'from_seed')),
  kind VARCHAR(12) NOT NULL DEFAULT 'initial' CHECK (kind IN ('initial', 'reply')),
  thread_key VARCHAR(80) NOT NULL,
  rfc_message_id VARCHAR(300) NOT NULL UNIQUE,
  in_reply_to VARCHAR(300),
  subject VARCHAR(500),
  status VARCHAR(12) NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed', 'received')),
  placement VARCHAR(12) NOT NULL DEFAULT 'unknown' CHECK (placement IN ('unknown', 'inbox', 'spam', 'other')),
  placement_checked_at TIMESTAMP,
  rescued BOOLEAN NOT NULL DEFAULT FALSE,
  seed_read_at TIMESTAMP,
  reply_due_at TIMESTAMP,
  replied_at TIMESTAMP,
  followup_due_at TIMESTAMP,
  followed_up_at TIMESTAMP,
  error TEXT,
  sent_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_warmnet_messages_mailbox ON warmnet_messages(mailbox_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_warmnet_messages_seed ON warmnet_messages(seed_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_warmnet_messages_sent ON warmnet_messages(sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_warmnet_messages_reply_due ON warmnet_messages(reply_due_at) WHERE reply_due_at IS NOT NULL AND replied_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_warmnet_messages_followup_due ON warmnet_messages(followup_due_at) WHERE followup_due_at IS NOT NULL AND followed_up_at IS NULL;

-- Sending IPs and their blocklist status. domain -> IP mapping lives on warmnet_domains.
CREATE TABLE IF NOT EXISTS warmnet_ips (
  id SERIAL PRIMARY KEY,
  ip VARCHAR(45) NOT NULL UNIQUE,
  hostname VARCHAR(255),
  pool_name VARCHAR(80),
  notes TEXT,
  clean BOOLEAN,
  listings JSONB NOT NULL DEFAULT '[]'::jsonb,
  unchecked JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_checked_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS warmnet_domains (
  domain_id INT PRIMARY KEY REFERENCES domains(id) ON DELETE CASCADE,
  ip_id INT REFERENCES warmnet_ips(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
