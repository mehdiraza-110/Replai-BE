-- 029 — Who is alerted about a positive lead, per brand. A brand is a campaign name: campaign_pattern is a SQL
-- ILIKE pattern matched against the campaign the lead replied to. NULL = a copy of every brand.
CREATE TABLE IF NOT EXISTS lead_alert_routes (
  id SERIAL PRIMARY KEY,
  campaign_pattern VARCHAR(160),
  email VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_alert_routes_pat_email ON lead_alert_routes (COALESCE(campaign_pattern, ''), LOWER(email));
