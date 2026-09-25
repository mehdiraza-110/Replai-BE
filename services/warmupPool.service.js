const db = require("../config/db.config");
const { parseLeadsFile } = require("./leadFileParser");
const suppressionService = require("./suppression.service");
const campaignService = require("./campaign.service");

const WARMUP_CAMPAIGN_NAME = "__warmup_pool__";
const DEFAULT_SUBJECT = "Quick hello";
const DEFAULT_BODY = "Hi {{firstName}},\n\nJust reaching out to say hello and see how things are going on your end.\n\nBest";

/**
 * The always-on warmup lane: a single persistent campaign (is_warmup = true, mailbox_mode
 * 'all' so every eligible mailbox across every domain rotates through it) whose leads come
 * from a shared, continuously-topped-up pool rather than a customer upload. Each lead is
 * single-use — once its campaign_leads row flips to 'Sent' it is never selected again,
 * there is no recycling. Reuses the exact same send/suppression/compliance pipeline as a
 * real campaign (campaignSend.service.js just draws mailbox capacity from the separate
 * warmup-lane counters — see warmup.service.js tickMailbox).
 */
class WarmupPoolService {
  async getOrCreateWarmupCampaign() {
    const { rows } = await db.query(
      `SELECT * FROM campaigns WHERE is_warmup = TRUE AND is_deleted = FALSE ORDER BY id ASC LIMIT 1`
    );
    if (rows[0]) return rows[0];

    const body = campaignService.withOptOutFooter(DEFAULT_BODY);
    const { rows: created } = await db.query(
      `INSERT INTO campaigns (
         name, objective, subject, body, mailbox_mode, mailbox_ids, sending_days,
         window_start, window_end, timezone, status, is_warmup, started_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'all', '{}', '[]'::jsonb, '00:00', '23:59', 'UTC', 'Active', TRUE, NOW(), NOW())
       RETURNING *`,
      [WARMUP_CAMPAIGN_NAME, "Permanent warmup-lane sending, not a customer campaign", DEFAULT_SUBJECT, body]
    );
    return created[0];
  }

  /**
   * Adds leads to the shared pool. Skips anything already in the pool (any status — a lead
   * that's already been used stays retired, never re-added) and anything suppressed.
   */
  async addLeads(leads) {
    const campaign = await this.getOrCreateWarmupCampaign();

    const normalized = [];
    const seen = new Set();
    for (const lead of Array.isArray(leads) ? leads : []) {
      const isPlainString = typeof lead === "string";
      const email = String(isPlainString ? lead : lead?.email || "").trim().toLowerCase();
      if (!email || seen.has(email)) continue;
      seen.add(email);
      normalized.push({
        email,
        fullName: isPlainString ? null : lead.fullName || null,
        firstName: isPlainString ? null : lead.firstName || null,
        lastName: isPlainString ? null : lead.lastName || null,
        company: isPlainString ? null : lead.company || null,
        role: isPlainString ? null : lead.role || null,
      });
    }
    if (normalized.length === 0) {
      return { added: 0, skippedSuppressed: 0, skippedAlreadyInPool: 0 };
    }

    const [suppressed, existingRows] = await Promise.all([
      suppressionService.filterSuppressed(normalized.map((lead) => lead.email)),
      db.query(`SELECT email FROM campaign_leads WHERE campaign_id = $1 AND email = ANY($2::text[])`, [
        campaign.id,
        normalized.map((lead) => lead.email),
      ]),
    ]);
    const alreadyInPool = new Set(existingRows.rows.map((row) => row.email));

    const toInsert = normalized.filter((lead) => !suppressed.has(lead.email) && !alreadyInPool.has(lead.email));
    if (toInsert.length > 0) {
      await db.query(
        `INSERT INTO campaign_leads (campaign_id, email, full_name, first_name, last_name, company, role, raw_data)
         SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::jsonb[])`,
        [
          campaign.id,
          toInsert.map((lead) => lead.email),
          toInsert.map((lead) => lead.fullName),
          toInsert.map((lead) => lead.firstName),
          toInsert.map((lead) => lead.lastName),
          toInsert.map((lead) => lead.company),
          toInsert.map((lead) => lead.role),
          toInsert.map(() => JSON.stringify({})),
        ]
      );
    }

    return {
      added: toInsert.length,
      skippedSuppressed: normalized.filter((lead) => suppressed.has(lead.email)).length,
      skippedAlreadyInPool: normalized.filter((lead) => alreadyInPool.has(lead.email)).length,
    };
  }

  async addLeadsFromFile(buffer, originalName) {
    const parsed = parseLeadsFile(buffer, originalName);
    const result = await this.addLeads(parsed.leads);
    return { ...result, totalRows: parsed.totalRows, invalidCount: parsed.invalidCount };
  }

  async getStats() {
    const campaign = await this.getOrCreateWarmupCampaign();
    const { rows } = await db.query(
      `SELECT status, COUNT(*)::int AS count FROM campaign_leads WHERE campaign_id = $1 GROUP BY status`,
      [campaign.id]
    );
    const counts = Object.fromEntries(rows.map((row) => [row.status, row.count]));
    return {
      campaignId: campaign.id,
      available: counts.Pending || 0,
      used: counts.Sent || 0,
      suppressed: counts.Suppressed || 0,
      failed: counts.Failed || 0,
      total: rows.reduce((sum, row) => sum + row.count, 0),
    };
  }
}

module.exports = new WarmupPoolService();
