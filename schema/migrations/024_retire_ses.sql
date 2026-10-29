-- 024 — Amazon SES is retired. New domains and inboxes default to the own mail server (Postal). Existing rows are left exactly as
-- they are (an old SES inbox simply stops being picked for sending); only the column defaults change. Additive and idempotent.
ALTER TABLE mailboxes ALTER COLUMN provider SET DEFAULT 'postal';
ALTER TABLE domains ALTER COLUMN provider SET DEFAULT 'Postal';
ALTER TABLE domains ALTER COLUMN dns_provider SET DEFAULT 'Porkbun';
