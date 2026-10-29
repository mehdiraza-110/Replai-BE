-- 016 — email OTP for sign-in. One row per login challenge: the password was correct, a 6-digit code was emailed,
-- and a session is only issued once that code is verified. Nothing here touches the users table (FK only).
-- Neither the OTP nor the challenge token is stored in clear: otp_hash is an HMAC-SHA256 of the code (keyed with a server
-- secret), challenge_hash is the sha256 of the opaque token the client sends back. Idempotent.
CREATE TABLE IF NOT EXISTS email_login_otps (
  id              BIGSERIAL PRIMARY KEY,
  user_id         INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge_hash  CHAR(64) NOT NULL UNIQUE,
  otp_hash        CHAR(64) NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,                       -- set on successful verification, or when the challenge is revoked
  attempts        INT NOT NULL DEFAULT 0,            -- wrong codes entered against the current code
  resend_count    INT NOT NULL DEFAULT 0,
  last_sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  requested_ip    VARCHAR(64),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_login_otps_user_created ON email_login_otps(user_id, created_at);
