const db = require("../config/db.config");
const quota = require("./quota.service");

const LOCAL_PART_PATTERN = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/i;

class MailboxService {
  async listMailboxes({ page = 1, limit = 10, search = "", domainId, workspaceId } = {}) {
    const pageNum = Math.max(1, Number.parseInt(page, 10) || 1);
    const limitNum = Math.min(Math.max(Number.parseInt(limit, 10) || 10, 1), 100);
    const offset = (pageNum - 1) * limitNum;

    const conditions = ["m.is_deleted = FALSE", "m.workspace_id = $1"];
    const params = [workspaceId];

    const searchTerm = String(search || "").trim();
    if (searchTerm) {
      params.push(`%${searchTerm}%`);
      conditions.push(`m.email ILIKE $${params.length}`);
    }
    if (domainId) {
      params.push(domainId);
      conditions.push(`m.domain_id = $${params.length}`);
    }
    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const [itemsResult, totalResult, statusCountsResult] = await Promise.all([
      db.query(
        `SELECT m.*, d.domain AS domain_name, d.status AS domain_status,
                d.bounce_rate AS domain_bounce_rate, d.complaint_rate AS domain_complaint_rate,
                ws.name AS warmup_strategy_name,
                COALESCE((
                  SELECT array_agg(c.name ORDER BY c.created_at DESC)
                  FROM campaigns c
                  WHERE c.is_deleted = FALSE AND c.status = 'Active' AND c.workspace_id = m.workspace_id
                    AND (c.mailbox_mode = 'all' OR m.id = ANY(c.mailbox_ids))
                ), '{}') AS active_campaign_names
         FROM mailboxes m
         JOIN domains d ON d.id = m.domain_id AND d.workspace_id = m.workspace_id
         LEFT JOIN warmup_strategies ws ON ws.id = m.warmup_strategy_id AND ws.workspace_id = m.workspace_id
         ${whereClause}
         ORDER BY m.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limitNum, offset]
      ),
      db.query(
        `SELECT COUNT(*)::int AS count FROM mailboxes m JOIN domains d ON d.id = m.domain_id AND d.workspace_id = m.workspace_id ${whereClause}`,
        params
      ),
      db.query(
        `SELECT status, COUNT(*)::int AS count FROM mailboxes WHERE is_deleted = FALSE AND workspace_id = $1 GROUP BY status`,
        [workspaceId]
      ),
    ]);

    const total = totalResult.rows[0]?.count || 0;
    const statusCounts = { total: 0, active: 0, paused: 0, error: 0 };
    for (const row of statusCountsResult.rows) {
      statusCounts.total += row.count;
      if (row.status === "Active") statusCounts.active += row.count;
      else if (row.status === "Error") statusCounts.error += row.count;
      else statusCounts.paused += row.count;
    }

    return {
      items: itemsResult.rows.map(mapMailboxRow),
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.max(1, Math.ceil(total / limitNum)),
      statusCounts,
    };
  }

  /** Inboxes on a domain served by our own Postal server. Same shape as a bulk-registered inbox: Paused, queued for warm-up. */
  async createPostalMailboxes({ domainRow, localParts, displayName, createdBy, workspaceId }) {
    const wanted = Array.from(new Set((localParts || []).map((p) => String(p || "").trim().toLowerCase()).filter(Boolean)));
    const results = [];
    const valid = wanted.filter((p) => LOCAL_PART_PATTERN.test(p));
    for (const bad of wanted.filter((p) => !LOCAL_PART_PATTERN.test(p))) results.push({ email: `${bad}@${domainRow.domain}`, status: "Failed", error: "Invalid mailbox local part" });
    const { rows: taken } = valid.length ? await db.query(`SELECT email FROM mailboxes WHERE email = ANY($1::text[]) AND is_deleted = FALSE`, [valid.map((p) => `${p}@${domainRow.domain}`)]) : { rows: [] };
    const takenSet = new Set(taken.map((r) => r.email));
    const fresh = valid.filter((p) => !takenSet.has(`${p}@${domainRow.domain}`));
    for (const p of valid.filter((x) => takenSet.has(`${x}@${domainRow.domain}`))) results.push({ email: `${p}@${domainRow.domain}`, status: "Failed", error: "A mailbox with this email already exists" });
    const usageId = fresh.length > 0 ? await quota.consume(workspaceId, "mailboxes", fresh.length, { domain: domainRow.domain }) : null;
    let created = 0;
    for (const localPart of fresh) {
      const email = `${localPart}@${domainRow.domain}`;
      const client = await db.getClient();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query(
          `INSERT INTO mailboxes (domain_id, email, local_part, display_name, status, daily_limit, warmup_stage, provider, created_by, workspace_id, market_daily_limit, updated_at)
           VALUES ($1,$2,$3,$4,'Paused',0,'Paused','postal',$5,$6,0,NOW()) ON CONFLICT (email) DO NOTHING RETURNING *`,
          [domainRow.id, email, localPart, displayName || null, createdBy || null, domainRow.workspace_id]
        );
        if (!rows[0]) { await client.query("ROLLBACK"); results.push({ email, status: "Failed", error: "A mailbox with this email already exists" }); continue; }
        await client.query(`INSERT INTO warmnet_mailboxes (mailbox_id, state) VALUES ($1,'queued') ON CONFLICT DO NOTHING`, [rows[0].id]);
        await client.query("COMMIT");
        created += 1;
        results.push({ email, status: "Created", record: mapMailboxRow({ ...rows[0], domain_name: domainRow.domain, domain_status: domainRow.status, domain_bounce_rate: domainRow.bounce_rate, domain_complaint_rate: domainRow.complaint_rate }) });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        console.error("createPostalMailboxes:", error);
        results.push({ email, status: "Failed", error: "Could not create this mailbox" });
      } finally {
        client.release();
      }
    }
    // Give back quota for any inbox that wasn't created.
    if (usageId) await quota.refund(workspaceId, usageId, created);
    return results;
  }

  async createMailboxes({ domain, localParts, displayName, dailyLimit, createdBy, acceptedMonthlyIncreaseCents, workspaceId }) {
    const domainName = String(domain || "").trim().toLowerCase();
    if (!domainName) {
      throw Object.assign(new Error("domain is required"), { statusCode: 400 });
    }
    if (!Array.isArray(localParts) || localParts.length === 0) {
      throw Object.assign(new Error("Provide a non-empty 'localParts' array"), { statusCode: 400 });
    }

    const { rows: domainRows } = await db.query(
      `SELECT * FROM domains WHERE domain = $1 AND is_deleted = FALSE AND workspace_id = $2`,
      [domainName, workspaceId]
    );
    const domainRow = domainRows[0];
    if (!domainRow) {
      throw Object.assign(new Error(`Domain ${domainName} hasn't been onboarded yet`), { statusCode: 404 });
    }

    // Maildoso-managed domains create real, billable mailboxes at Maildoso (cost-confirmed).
    if (domainRow.provider === "Maildoso") {
      return this.createMaildosoMailboxes({ domainRow, localParts, displayName, acceptedMonthlyIncreaseCents, workspaceId });
    }

    // Own-server (Postal) domains: mailboxes are only rows here, sent through Postal, and join the warm-up network paused.
    if (domainRow.provider === "Postal") {
      return this.createPostalMailboxes({ domainRow, localParts, displayName, createdBy, workspaceId });
    }

    const limit = Number.isFinite(Number(dailyLimit)) && Number(dailyLimit) > 0 ? Math.floor(Number(dailyLimit)) : 20;
    const results = [];

    // The whole batch is checked against the workspace's mailbox limit before anything is created.
    const wanted = Array.from(new Set(localParts.map((p) => String(p || "").trim().toLowerCase()).filter((p) => p && LOCAL_PART_PATTERN.test(p))));
    const { rows: taken } = wanted.length
      ? await db.query(`SELECT email FROM mailboxes WHERE email = ANY($1::text[]) AND is_deleted = FALSE`, [wanted.map((p) => `${p}@${domainName}`)])
      : { rows: [] };
    const newCount = wanted.length - taken.length;
    const usageId = newCount > 0 ? await quota.consume(workspaceId, "mailboxes", newCount, { domain: domainName }) : null;

    for (const rawLocalPart of localParts) {
      const localPart = String(rawLocalPart || "").trim().toLowerCase();
      if (!localPart) continue;

      if (!LOCAL_PART_PATTERN.test(localPart)) {
        results.push({ email: `${localPart}@${domainName}`, status: "Failed", error: "Invalid mailbox local part" });
        continue;
      }

      const email = `${localPart}@${domainName}`;
      try {
        const status = domainRow.status === "Verified" ? "Active" : "Paused";
        const { rows } = await db.query(
          `INSERT INTO mailboxes (domain_id, email, local_part, display_name, status, daily_limit, created_by, workspace_id, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
           ON CONFLICT (email) DO NOTHING
           RETURNING *`,
          [domainRow.id, email, localPart, displayName || null, status, limit, createdBy || null, domainRow.workspace_id]
        );
        if (!rows[0]) {
          results.push({ email, status: "Failed", error: "A mailbox with this email already exists" });
          continue;
        }
        results.push({
          email,
          status: "Created",
          record: mapMailboxRow({
            ...rows[0],
            domain_name: domainRow.domain,
            domain_status: domainRow.status,
            domain_bounce_rate: domainRow.bounce_rate,
            domain_complaint_rate: domainRow.complaint_rate,
          }),
        });
      } catch (error) {
        results.push({ email, status: "Failed", error: error.message });
      }
    }

    if (usageId) await quota.refund(workspaceId, usageId, results.filter((r) => r.status === "Created").length);
    return results;
  }

  async createMaildosoMailboxes({ domainRow, localParts, displayName, acceptedMonthlyIncreaseCents, workspaceId }) {
    const maildosoService = require("./maildoso.service");
    const cleaned = Array.from(new Set(localParts.map((part) => String(part || "").trim().toLowerCase()).filter(Boolean)));
    const invalid = cleaned.filter((part) => !LOCAL_PART_PATTERN.test(part));
    if (invalid.length > 0) {
      throw Object.assign(new Error(`Invalid mailbox name(s): ${invalid.join(", ")}`), { statusCode: 400 });
    }

    const { rows: existing } = await db.query(`SELECT email FROM mailboxes WHERE email = ANY($1::text[]) AND is_deleted = FALSE`, [
      cleaned.map((part) => `${part}@${domainRow.domain}`),
    ]);
    // (deliberately NOT workspace-filtered: mailboxes.email is globally unique, so an address held by any workspace is taken)
    const existingEmails = new Set(existing.map((row) => row.email));
    const toCreate = cleaned.filter((part) => !existingEmails.has(`${part}@${domainRow.domain}`));

    const failed = [...existingEmails].map((email) => ({ email, status: "Failed", error: "A mailbox with this email already exists" }));
    if (toCreate.length === 0) return failed;

    // Whole batch checked before anything is bought at Maildoso.
    const usageId = await quota.consume(domainRow.workspace_id, "mailboxes", toCreate.length, { domain: domainRow.domain });
    let results;
    try {
      ({ results } = await maildosoService.provisionMailboxes({
        domain: domainRow.domain,
        mailboxes: toCreate.map((localPart) => ({ localPart, ...nameForMailbox(localPart, displayName) })),
        acceptedMonthlyIncreaseCents,
        workspaceId: domainRow.workspace_id,
      }));
    } catch (error) {
      await quota.refund(domainRow.workspace_id, usageId);
      throw error;
    }
    await quota.refund(domainRow.workspace_id, usageId, results.filter((r) => r.status === "Created").length);

    const { rows } = await db.query(
      `SELECT m.*, d.domain AS domain_name, d.status AS domain_status, d.bounce_rate AS domain_bounce_rate, d.complaint_rate AS domain_complaint_rate
       FROM mailboxes m JOIN domains d ON d.id = m.domain_id AND d.workspace_id = m.workspace_id
       WHERE m.email = ANY($1::text[]) AND m.is_deleted = FALSE AND m.workspace_id = $2`,
      [results.map((result) => result.email), domainRow.workspace_id]
    );
    const rowsByEmail = new Map(rows.map((row) => [row.email, row]));
    return [
      ...results.map((result) => ({ ...result, record: rowsByEmail.has(result.email) ? mapMailboxRow(rowsByEmail.get(result.email)) : undefined })),
      ...failed,
    ];
  }

  async refreshMailbox(id, workspaceId) {
    const { rows } = await db.query(
      `SELECT m.*, d.domain AS domain_name, d.status AS domain_status,
              d.bounce_rate AS domain_bounce_rate, d.complaint_rate AS domain_complaint_rate
       FROM mailboxes m
       JOIN domains d ON d.id = m.domain_id AND d.workspace_id = m.workspace_id
       WHERE m.id = $1 AND m.is_deleted = FALSE AND m.workspace_id = $2`,
      [id, workspaceId]
    );
    const mailbox = rows[0];
    if (!mailbox) {
      throw Object.assign(new Error("Mailbox not found"), { statusCode: 404 });
    }

    // Mailboxes have no DNS/identity of their own to verify — they inherit sending eligibility
    // straight from their parent domain's SES verification, so that's what "refresh" checks here.
    const nextStatus = mailbox.domain_status === "Verified" ? (mailbox.status === "Error" ? "Error" : "Active") : "Paused";

    const { rows: updatedRows } = await db.query(
      `UPDATE mailboxes SET status = $2, last_checked_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND workspace_id = $3
       RETURNING *`,
      [id, nextStatus, workspaceId]
    );

    return mapMailboxRow({
      ...updatedRows[0],
      domain_name: mailbox.domain_name,
      domain_status: mailbox.domain_status,
      domain_bounce_rate: mailbox.domain_bounce_rate,
      domain_complaint_rate: mailbox.domain_complaint_rate,
    });
  }

  async refreshAllMailboxes(workspaceId) {
    const { rows } = await db.query(
      `SELECT id FROM mailboxes WHERE is_deleted = FALSE AND workspace_id = $1`,
      [workspaceId]
    );
    const results = [];
    for (const row of rows) {
      try {
        results.push(await this.refreshMailbox(row.id, workspaceId));
      } catch (error) {
        results.push({ id: row.id, status: "Failed", error: error.message });
      }
    }
    return results;
  }

  async deleteMailbox(id, workspaceId) {
    const { rows } = await db.query(
      `UPDATE mailboxes SET is_deleted = TRUE, updated_at = NOW()
       WHERE id = $1 AND is_deleted = FALSE AND workspace_id = $2
       RETURNING id, email`,
      [id, workspaceId]
    );
    if (!rows[0]) {
      throw Object.assign(new Error("Mailbox not found"), { statusCode: 404 });
    }
    return { id: rows[0].id, email: rows[0].email };
  }

  /**
   * The app-native inbox for a mailbox (see `messages` table / inboundEmail.service.js,
   * campaignSend.service.js) — every outbound send and inbound reply, newest first.
   */
  async listMailboxMessages(mailboxId, { page = 1, limit = 30, workspaceId } = {}) {
    const { rows: mailboxRows } = await db.query(`SELECT id, email FROM mailboxes WHERE id = $1 AND is_deleted = FALSE AND workspace_id = $2`, [mailboxId, workspaceId]);
    if (!mailboxRows[0]) {
      throw Object.assign(new Error("Mailbox not found"), { statusCode: 404 });
    }

    const pageNum = Math.max(1, Number.parseInt(page, 10) || 1);
    const limitNum = Math.min(Math.max(Number.parseInt(limit, 10) || 30, 1), 100);
    const offset = (pageNum - 1) * limitNum;

    const [itemsResult, totalResult] = await Promise.all([
      db.query(
        `SELECT * FROM messages WHERE mailbox_id = $1 AND workspace_id = $4 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [mailboxId, limitNum, offset, workspaceId]
      ),
      db.query(`SELECT COUNT(*)::int AS count FROM messages WHERE mailbox_id = $1 AND workspace_id = $2`, [mailboxId, workspaceId]),
    ]);

    const total = totalResult.rows[0]?.count || 0;
    return {
      items: itemsResult.rows.map(mapMessageRow),
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.max(1, Math.ceil(total / limitNum)),
    };
  }
}

function mapMessageRow(row) {
  return {
    id: row.id,
    mailboxId: row.mailbox_id,
    direction: row.direction,
    campaignId: row.campaign_id,
    campaignLeadId: row.campaign_lead_id,
    threadId: row.thread_id,
    messageId: row.message_id,
    inReplyTo: row.in_reply_to,
    fromAddress: row.from_address,
    toAddress: row.to_address,
    subject: row.subject,
    bodyText: row.body_text,
    bodyHtml: row.body_html,
    isRead: row.is_read,
    createdAt: row.created_at,
  };
}

/** Maildoso needs a first and last name per mailbox: use the shared display name, else derive from the address. */
function nameForMailbox(localPart, displayName) {
  const titleCase = (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  const fromDisplay = String(displayName || "").trim().split(/\s+/).filter(Boolean);
  const tokens = fromDisplay.length > 0 ? fromDisplay : localPart.split(/[._+-]+/).filter((token) => /^[a-z]+$/i.test(token));
  const firstName = titleCase(tokens[0] || localPart.replace(/[^a-z]/gi, "") || "Team");
  const lastName = titleCase(tokens.slice(1).join(" ") || "Team");
  return { firstName, lastName };
}

function mapMailboxRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    domainId: row.domain_id,
    domain: row.domain_name,
    domainStatus: row.domain_status,
    domainBounceRate: row.domain_bounce_rate === null || row.domain_bounce_rate === undefined ? null : Number(row.domain_bounce_rate),
    domainComplaintRate: row.domain_complaint_rate === null || row.domain_complaint_rate === undefined ? null : Number(row.domain_complaint_rate),
    email: row.email,
    localPart: row.local_part,
    displayName: row.display_name,
    status: row.status,
    dailyLimit: row.daily_limit,
    sentToday: row.sent_today,
    marketDailyLimit: row.market_daily_limit ?? 0,
    marketSentToday: row.market_sent_today ?? 0,
    warmupStage: row.warmup_stage,
    reputationStatus: row.reputation_status,
    lastSentAt: row.last_sent_at,
    lastCheckedAt: row.last_checked_at,
    warmupStrategyId: row.warmup_strategy_id ?? null,
    warmupStrategyName: row.warmup_strategy_name ?? null,
    warmupStartedAt: row.warmup_started_at ?? null,
    warmupLastTickAt: row.warmup_last_tick_at ?? null,
    warmupLastAction: row.warmup_last_action ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // The metrics below need real send/reply activity that no engine produces yet
    // (no campaign-sending or warmup-sending worker exists) — they're left honestly
    // empty/zero rather than fabricated, and will populate once that pipeline exists.
    campaignSentToday: 0,
    warmupDeliverability7d: null,
    replyRate7d: null,
    bounceRate3d: null,
    activeCampaigns: row.active_campaign_names ?? [],
    totalEmailSent: 0,
    totalContactedLeads: 0,
    newLeadsContacted: 0,
    totalCompletedLeads: 0,
    replyRateExclOoo7d: null,
    positiveReplyRate7d: null,
  };
}

module.exports = new MailboxService();
module.exports.mapMailboxRow = mapMailboxRow;
