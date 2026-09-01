const db = require("../config/db.config");

class LeadProfileService {
  async upsert(profile = {}) {
    const leadEmail = cleanString(profile.leadEmail || profile.lead_email);
    if (!leadEmail) return null;

    const result = await db.query(
      `INSERT INTO plusvibe_lead_profiles (
        workspace_id,
        lead_email,
        lead_name,
        company_name,
        role_title,
        last_thread_id,
        last_campaign_id,
        last_seen_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamp, NOW()))
      ON CONFLICT (workspace_id, lead_email)
      DO UPDATE SET
        lead_name = COALESCE(EXCLUDED.lead_name, plusvibe_lead_profiles.lead_name),
        company_name = COALESCE(EXCLUDED.company_name, plusvibe_lead_profiles.company_name),
        role_title = COALESCE(EXCLUDED.role_title, plusvibe_lead_profiles.role_title),
        last_thread_id = COALESCE(EXCLUDED.last_thread_id, plusvibe_lead_profiles.last_thread_id),
        last_campaign_id = COALESCE(EXCLUDED.last_campaign_id, plusvibe_lead_profiles.last_campaign_id),
        last_seen_at = GREATEST(EXCLUDED.last_seen_at, plusvibe_lead_profiles.last_seen_at),
        updated_at = NOW()
      RETURNING *`,
      [
        cleanString(profile.workspaceId || profile.workspace_id),
        leadEmail,
        cleanString(profile.leadName || profile.lead_name),
        cleanString(profile.companyName || profile.company_name),
        cleanString(profile.roleTitle || profile.role_title),
        cleanString(profile.threadId || profile.thread_id),
        cleanString(profile.campaignId || profile.campaign_id),
        cleanString(profile.lastSeenAt || profile.last_seen_at),
      ]
    );

    return mapProfile(result.rows[0]);
  }

  async getByEmails(workspaceId, emails = []) {
    const values = [...new Set(emails.map(cleanString).filter(Boolean))];
    if (values.length === 0) return new Map();

    const result = await db.query(
      `SELECT *
       FROM plusvibe_lead_profiles
       WHERE workspace_id = $1
         AND lead_email = ANY($2::varchar[])`,
      [cleanString(workspaceId), values]
    );

    return new Map(result.rows.map((row) => [row.lead_email, mapProfile(row)]));
  }
}

function mapProfile(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    leadEmail: row.lead_email,
    leadName: row.lead_name,
    companyName: row.company_name,
    roleTitle: row.role_title,
    lastThreadId: row.last_thread_id,
    lastCampaignId: row.last_campaign_id,
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at,
  };
}

function cleanString(value) {
  if (value === undefined || value === null) return null;

  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

module.exports = new LeadProfileService();
