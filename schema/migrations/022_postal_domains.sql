-- 022 — Own-server (Postal) domains: the DKIM selector Postal generated for the domain, so its DNS can be checked for real.
-- Additive and idempotent.
ALTER TABLE domains ADD COLUMN IF NOT EXISTS dkim_selector VARCHAR(120);
