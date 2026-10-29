-- 021 — AI modules: AI Consultant chat, Sales Call Analyzer, and the report generators (Market Researcher,
-- Offer Creator, Growth Plan Creator). Additive and idempotent. Absolute instants are TIMESTAMPTZ.

CREATE TABLE IF NOT EXISTS ai_chat_threads (
  id BIGSERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(160) NOT NULL DEFAULT 'New chat',
  persona VARCHAR(30) NOT NULL DEFAULT 'advisor',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_chat_threads_user ON ai_chat_threads(workspace_id, user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_chat_messages (
  id BIGSERIAL PRIMARY KEY,
  thread_id BIGINT NOT NULL REFERENCES ai_chat_threads(id) ON DELETE CASCADE,
  role VARCHAR(12) NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_thread ON ai_chat_messages(thread_id, id);

CREATE TABLE IF NOT EXISTS call_analyses (
  id BIGSERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  call_type VARCHAR(20) NOT NULL,
  prospect_name VARCHAR(160),
  prospect_email VARCHAR(320),
  prospect_company VARCHAR(200),
  prospect_role VARCHAR(160),
  call_date DATE,
  transcript TEXT NOT NULL,
  language VARCHAR(10) NOT NULL DEFAULT 'en-US',
  status VARCHAR(12) NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed')),
  error TEXT,
  result JSONB,
  model VARCHAR(80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_call_analyses_ws ON call_analyses(workspace_id, id DESC);

CREATE TABLE IF NOT EXISTS ai_reports (
  id BIGSERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('market_research', 'offer', 'growth_plan')),
  title VARCHAR(200),
  status VARCHAR(12) NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed')),
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  output JSONB,
  error TEXT,
  model VARCHAR(80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ai_reports_ws ON ai_reports(workspace_id, kind, id DESC);
