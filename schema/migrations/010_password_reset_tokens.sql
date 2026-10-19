-- 010 — password reset / invite tokens (only the sha256 of the token is stored) and a request log used for
-- DB-backed rate limiting of "forgot password" (counts per submitted email and per IP, whether or not the account exists). Idempotent.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id            SERIAL PRIMARY KEY,
  user_id       INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    CHAR(64) NOT NULL UNIQUE,
  purpose       VARCHAR(10) NOT NULL DEFAULT 'reset' CHECK (purpose IN ('reset', 'invite')),
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  requested_ip  VARCHAR(64),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);

CREATE TABLE IF NOT EXISTS password_reset_requests (
  id          BIGSERIAL PRIMARY KEY,
  email_hash  CHAR(64) NOT NULL,
  ip          VARCHAR(64),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_password_reset_requests_email ON password_reset_requests(email_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_password_reset_requests_ip ON password_reset_requests(ip, created_at);
