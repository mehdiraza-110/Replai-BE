-- 023 — Sites: AI-built websites. A site keeps its working copy, the last published snapshot, and a short version history.
-- Additive and idempotent. Absolute instants are TIMESTAMPTZ.
CREATE TABLE IF NOT EXISTS sites (
  id BIGSERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  name VARCHAR(120) NOT NULL,
  slug VARCHAR(80) NOT NULL UNIQUE,
  prompt TEXT NOT NULL DEFAULT '',
  template VARCHAR(30),
  status VARCHAR(12) NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'failed')),
  error TEXT,
  html TEXT,
  published_html TEXT,
  is_published BOOLEAN NOT NULL DEFAULT FALSE,
  published_at TIMESTAMPTZ,
  custom_domain VARCHAR(253) UNIQUE,
  domain_status VARCHAR(12) NOT NULL DEFAULT 'none' CHECK (domain_status IN ('none', 'pending', 'verified')),
  model VARCHAR(80),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sites_ws ON sites(workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS site_versions (
  id BIGSERIAL PRIMARY KEY,
  site_id BIGINT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  html TEXT NOT NULL,
  note VARCHAR(300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_site_versions_site ON site_versions(site_id, id DESC);
