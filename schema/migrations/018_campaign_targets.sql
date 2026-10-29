-- 018 — Campaign analytics targets (the "target" shown beside Positive Replies and Booked Calls). Additive and idempotent.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS target_positive_rate NUMERIC(5,2) NOT NULL DEFAULT 1.00 CHECK (target_positive_rate BETWEEN 0 AND 100);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS target_booked_rate NUMERIC(5,2) NOT NULL DEFAULT 25.00 CHECK (target_booked_rate BETWEEN 0 AND 100);
