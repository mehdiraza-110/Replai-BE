const db = require("../config/db.config");

// Domains are served by one of two paths: our own Postal mail server (the main one) or Maildoso. Amazon SES is no longer used.

class DomainService {
  async listDomains({ page = 1, limit = 10, search = "", workspaceId } = {}) {
    const pageNum = Math.max(1, Number.parseInt(page, 10) || 1);
    const limitNum = Math.min(Math.max(Number.parseInt(limit, 10) || 10, 1), 100);
    const offset = (pageNum - 1) * limitNum;
    const searchTerm = search.trim();
    // $1 is always the workspace; the optional search term is $2.
    const searchParam = searchTerm ? [workspaceId, `%${searchTerm}%`] : [workspaceId];
    const whereClausePlain = searchTerm ? `WHERE is_deleted = FALSE AND workspace_id = $1 AND domain ILIKE $2` : `WHERE is_deleted = FALSE AND workspace_id = $1`;
    const whereClauseAliased = searchTerm ? `WHERE d.is_deleted = FALSE AND d.workspace_id = $1 AND d.domain ILIKE $2` : `WHERE d.is_deleted = FALSE AND d.workspace_id = $1`;

    const [itemsResult, totalResult, statusCountsResult] = await Promise.all([
      db.query(
        `SELECT d.*, COALESCE(mb.mailbox_count, 0)::int AS mailbox_count
         FROM domains d
         LEFT JOIN (
           SELECT domain_id, COUNT(*) AS mailbox_count FROM mailboxes WHERE is_deleted = FALSE AND workspace_id = $1 GROUP BY domain_id
         ) mb ON mb.domain_id = d.id
         ${whereClauseAliased}
         ORDER BY d.created_at DESC LIMIT $${searchParam.length + 1} OFFSET $${searchParam.length + 2}`,
        [...searchParam, limitNum, offset]
      ),
      db.query(`SELECT COUNT(*)::int AS count FROM domains ${whereClausePlain}`, searchParam),
      db.query(`SELECT status, COUNT(*)::int AS count FROM domains WHERE is_deleted = FALSE AND workspace_id = $1 GROUP BY status`, [workspaceId]),
    ]);

    const total = totalResult.rows[0]?.count || 0;
    const statusCounts = { total: 0, verified: 0, pending: 0, failed: 0 };
    for (const row of statusCountsResult.rows) {
      statusCounts.total += row.count;
      if (row.status === "Verified") statusCounts.verified += row.count;
      else if (row.status === "Failed") statusCounts.failed += row.count;
      else statusCounts.pending += row.count;
    }

    return {
      items: itemsResult.rows.map(mapDomainRow),
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.max(1, Math.ceil(total / limitNum)),
      statusCounts,
    };
  }

  /** Daily sends and bounce rate over the last N days, from our own sends (the own mail server reports no account-level metrics). */
  async getReputationTrend({ days = 7, workspaceId } = {}) {
    const daysNum = Math.min(Math.max(Number.parseInt(days, 10) || 7, 1), 30);
    const { rows } = await db.query(
      `SELECT to_char(g.day, 'YYYY-MM-DD') AS date,
              COUNT(cl.id) FILTER (WHERE cl.status IN ('Sent', 'Replied', 'Bounced'))::int AS sent,
              COUNT(cl.id) FILTER (WHERE cl.status = 'Bounced')::int AS bounced
       FROM generate_series(CURRENT_DATE - ($2::int - 1), CURRENT_DATE, INTERVAL '1 day') AS g(day)
       LEFT JOIN campaign_leads cl ON cl.workspace_id = $1 AND cl.sent_at >= g.day AND cl.sent_at < g.day + INTERVAL '1 day'
       GROUP BY g.day ORDER BY g.day`,
      [workspaceId, daysNum]
    );
    // No complaint feed exists yet, so complaintRate is reported as 0 rather than guessed.
    return rows.map((r) => ({ date: r.date, sentVolume: r.sent, bounceRate: r.sent > 0 ? Math.round((r.bounced / r.sent) * 1000) / 10 : 0, complaintRate: 0 }));
  }

  async deleteDomain(id, workspaceId) {
    const client = await db.getClient();
    try {
      await client.query("BEGIN");

      const { rows: domainRows } = await client.query(
        `UPDATE domains SET is_deleted = TRUE, updated_at = NOW()
         WHERE id = $1 AND is_deleted = FALSE AND workspace_id = $2
         RETURNING id, domain`,
        [id, workspaceId]
      );
      if (!domainRows[0]) {
        throw Object.assign(new Error("Domain not found"), { statusCode: 404 });
      }

      const { rows: mailboxRows } = await client.query(
        `UPDATE mailboxes SET is_deleted = TRUE, updated_at = NOW()
         WHERE domain_id = $1 AND is_deleted = FALSE AND workspace_id = $2
         RETURNING id`,
        [id, workspaceId]
      );

      await client.query("COMMIT");

      return { id: domainRows[0].id, domain: domainRows[0].domain, mailboxesDeleted: mailboxRows.length };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async refreshDomainStatus(domain, workspaceId = null) {
    const { rows: providerRows } = await db.query(`SELECT provider FROM domains WHERE domain = $1 AND is_deleted = FALSE AND ($2::int IS NULL OR workspace_id = $2)`, [domain, workspaceId]);
    if (!providerRows[0]) throw Object.assign(new Error(`Domain ${domain} is not onboarded yet`), { statusCode: 404 });
    // Maildoso-managed domains: DNS and verification live at Maildoso, so only the reputation numbers (from our own sends and bounces) are refreshed.
    if (providerRows[0].provider === "Maildoso") return mapDomainRow(await require("./maildoso.service").refreshDomainReputation(domain, workspaceId));
    // Own mail server (Postal): the DNS is read live. A lookup that could not be answered at all never changes the status, so a DNS blip can't stop sending.
    if (providerRows[0].provider === "Postal") return this.refreshPostalDomain(domain, workspaceId);
    throw Object.assign(new Error(`${domain} was set up with a sending service that is no longer supported. Move it to the own mail server.`), { statusCode: 409 });
  }

  async refreshPostalDomain(domain, workspaceId = null) {
    const postalDns = require("./postalDns.service");
    const { rows: found } = await db.query(`SELECT id, dkim_selector FROM domains WHERE domain = $1 AND is_deleted = FALSE AND ($2::int IS NULL OR workspace_id = $2)`, [domain, workspaceId]);
    if (!found[0]) throw Object.assign(new Error(`Domain ${domain} is not onboarded yet`), { statusCode: 404 });
    // The mail server has to verify the domain itself before it will send for it, and it knows the exact DKIM key. Ask it first (best effort).
    const postalAdmin = require("./postalAdmin.service");
    let fromPostal = null;
    if (postalAdmin.configured()) {
      fromPostal = await postalAdmin.checkDns(domain).catch(() => null);
      const sel = fromPostal?.records?.dkim_name ? fromPostal.records.dkim_name.replace(/\._domainkey$/, "") : null;
      if (sel && sel !== found[0].dkim_selector) { await db.query(`UPDATE domains SET dkim_selector = $2 WHERE id = $1`, [found[0].id, sel]); found[0].dkim_selector = sel; }
    }
    const result = await postalDns.check(domain, { dkimSelector: found[0].dkim_selector });
    // Postal compares the DKIM key exactly; our own lookup only sees that a key exists. Prefer its verdict when we have it.
    if (fromPostal?.status && result.statuses && !result.unreliable) {
      const map = { OK: "Success", Missing: "Failed", Invalid: "Failed" };
      if (found[0].dkim_selector && map[fromPostal.status.dkim]) result.statuses.dkim = map[fromPostal.status.dkim];
    }
    const toDb = (value) => (value === "Unknown" ? "Pending" : value);
    if (result.unreliable) {
      // Keep what we knew; just record that the check couldn't be completed.
      await db.query(`UPDATE domains SET last_error = $2, last_checked_at = NOW(), updated_at = NOW() WHERE id = $1`, [found[0].id, `DNS lookup failed (${[...new Set(result.errors)].join(", ")}). Try again shortly.`]);
    } else {
      const s = result.statuses;
      const status = postalDns.overall(s);
      const problems = [s.mx === "Failed" && "MX doesn't point at the mail server", s.spf === "Failed" && "SPF doesn't include the mail server"].filter(Boolean);
      await db.query(
        `UPDATE domains SET mx_status = $2, spf_status = $3, dmarc_status = $4, dkim_status = $5, status = $6, last_error = $7, last_checked_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [found[0].id, toDb(s.mx), toDb(s.spf), toDb(s.dmarc), toDb(s.dkim), status, problems.length ? problems.join("; ") : null]
      );
    }
    return mapDomainRow(await require("./maildoso.service").refreshDomainReputation(domain, workspaceId));
  }

  /**
   * Background re-check of domains on the own mail server. A domain that isn't verified yet is looked at every pass (so warm-up
   * starts by itself once its DNS has spread); a verified one only once a day (so a record that gets removed is noticed).
   */
  async refreshDuePostalDomains({ limit = 40, workspaceId = null } = {}) {
    const { rows } = await db.query(
      `SELECT domain FROM domains
       WHERE provider = 'Postal' AND is_deleted = FALSE AND ($2::int IS NULL OR workspace_id = $2) AND COALESCE(last_checked_at, TIMESTAMP 'epoch') < NOW() - INTERVAL '10 minutes'
         AND (status <> 'Verified' OR COALESCE(last_checked_at, TIMESTAMP 'epoch') < NOW() - INTERVAL '24 hours')
       ORDER BY (status = 'Verified'), last_checked_at NULLS FIRST LIMIT $1`,
      [Math.min(Math.max(Number.parseInt(limit, 10) || 40, 1), 200), workspaceId]
    );
    const out = { checked: 0, nowVerified: 0, failed: 0, errors: 0 };
    for (const row of rows) {
      try {
        const before = (await db.query(`SELECT status FROM domains WHERE domain = $1`, [row.domain])).rows[0]?.status;
        const after = await this.refreshPostalDomain(row.domain, null);
        out.checked += 1;
        if (before !== "Verified" && after.status === "Verified") out.nowVerified += 1;
        if (after.status === "Failed") out.failed += 1;
      } catch (error) {
        out.errors += 1;
        console.error(`Re-check of ${row.domain} failed:`, error.message);
      }
    }
    return out;
  }

  async refreshAllDomains(workspaceId = null) {
    // Every domain is refreshed, not just unverified ones — reputation metrics (bounce/complaint/
    // delivery) need periodic refreshing for verified, actively-sending domains too.
    const { rows } = await db.query(
      `SELECT domain FROM domains WHERE is_deleted = FALSE AND ($1::int IS NULL OR workspace_id = $1)`,
      [workspaceId]
    );
    const results = [];
    for (const row of rows) {
      try {
        results.push(await this.refreshDomainStatus(row.domain, workspaceId));
      } catch (error) {
        results.push({ domain: row.domain, status: "Failed", error: error.message });
      }
    }
    return results;
  }
}

function mapDomainRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    domain: row.domain,
    registrar: row.registrar,
    dnsProvider: row.dns_provider,
    spfStatus: row.spf_status,
    dkimStatus: row.dkim_status,
    dmarcStatus: row.dmarc_status,
    mxStatus: row.mx_status,
    provider: row.provider,
    status: row.status,
    reputation: row.reputation,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error,
    mailboxCount: row.mailbox_count ?? null,
    emailsSent14d: row.emails_sent_14d,
    emailsDelivered14d: row.emails_delivered_14d,
    emailsBounced14d: row.emails_bounced_14d,
    emailsComplained14d: row.emails_complained_14d,
    bounceRate: row.bounce_rate === null || row.bounce_rate === undefined ? null : Number(row.bounce_rate),
    complaintRate: row.complaint_rate === null || row.complaint_rate === undefined ? null : Number(row.complaint_rate),
    deliveryRate: row.delivery_rate === null || row.delivery_rate === undefined ? null : Number(row.delivery_rate),
    reputationCheckedAt: row.reputation_checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

module.exports = new DomainService();
