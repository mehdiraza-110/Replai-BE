const db = require("../config/db.config");
const { encryptSecret } = require("../utils/secretBox.util");

const MAILDOSO_API_BASE = process.env.MAILDOSO_API_BASE || "https://api.maildoso.com";
const PAGE_SIZE = 100;

class MaildosoService {
  async request(path, { method = "GET", body } = {}) {
    const token = process.env.MAILDOSO_API_TOKEN;
    if (!token) {
      throw Object.assign(new Error("MAILDOSO_API_TOKEN is not configured"), { statusCode: 500 });
    }

    const response = await fetch(`${MAILDOSO_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });

    const text = await response.text();
    if (!response.ok) {
      throw Object.assign(new Error(`Maildoso API ${method} ${path} failed (${response.status}): ${text.slice(0, 300)}`), {
        statusCode: 502,
      });
    }
    return text ? JSON.parse(text) : null;
  }

  listDomains() {
    return this.request("/v1/user/domains");
  }

  async listAccounts() {
    const items = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await this.request(`/v1/user/accounts-lookup?limit=${PAGE_SIZE}&offset=${offset}`);
      items.push(...(page?.items || []));
      if (!page?.items?.length || items.length >= (page.meta?.total ?? 0)) break;
    }
    return items;
  }

  /**
   * Imports Maildoso domains + mailboxes into Replai's own tables so they flow through the
   * existing warmup/campaign/inbox machinery. Idempotent: re-running updates in place.
   * Only ACTIVE domains and active mailboxes are made sendable; anything else is mirrored
   * as Paused/Error so it can never be picked by the send engine.
   */
  /**
   * Workspace that owns Maildoso domains Replai has never seen before. The Maildoso API token is a single
   * account-wide credential (MAILDOSO_API_TOKEN), so unknown domains belong to whichever workspace holds
   * that account: MAILDOSO_WORKSPACE_ID, else the "koval-group" workspace. Domains already in the DB keep
   * their existing workspace; this is only used for first-time inserts.
   */
  async resolveNewDomainWorkspaceId() {
    const fromEnv = Number.parseInt(process.env.MAILDOSO_WORKSPACE_ID, 10);
    if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
    const { rows } = await db.query(`SELECT id FROM workspaces WHERE slug = 'koval-group' AND is_deleted = FALSE`);
    return rows[0]?.id ?? null;
  }

  // Sync is account-wide and keeps running for every workspace. `workspaceId` (set by the HTTP endpoint)
  // only narrows the summary that is returned so one tenant never sees another tenant's mailboxes.
  async syncMailboxes({ workspaceId = null } = {}) {
    const [domains, accounts] = await Promise.all([this.listDomains(), this.listAccounts()]);
    const domainsById = new Map(domains.map((domain) => [domain.id, domain]));

    const summary = { domains: 0, mailboxesCreated: 0, mailboxesUpdated: 0, skipped: [] };
    const replaiDomainIds = new Map(); // maildoso domain id -> replai domains.id
    const replaiDomainWorkspaces = new Map(); // maildoso domain id -> owning workspace id
    const newDomainWorkspaceId = await this.resolveNewDomainWorkspaceId();
    if (!newDomainWorkspaceId) {
      throw Object.assign(new Error("Cannot sync Maildoso: set MAILDOSO_WORKSPACE_ID to the workspace that owns the Maildoso account"), { statusCode: 500 });
    }

    for (const domain of domains) {
      if (domain.domain_status !== "ACTIVE") continue;
      const { rows } = await db.query(
        `INSERT INTO domains (domain, registrar, dns_provider, provider, external_id, status,
                              spf_status, dkim_status, dmarc_status, mx_status, mail_from_status, workspace_id, updated_at)
         VALUES ($1, 'External', 'Maildoso', 'Maildoso', $2, 'Verified', 'Success', 'Success', 'Success', 'Success', 'Success', $3, NOW())
         ON CONFLICT (domain) DO UPDATE SET
           registrar = 'External', dns_provider = 'Maildoso', provider = 'Maildoso', external_id = EXCLUDED.external_id,
           status = 'Verified', spf_status = 'Success', dkim_status = 'Success', dmarc_status = 'Success',
           mx_status = 'Success', mail_from_status = 'Success', is_deleted = FALSE, updated_at = NOW()
         RETURNING id, workspace_id`,
        [domain.domain_name.toLowerCase(), String(domain.id), newDomainWorkspaceId]
      );
      replaiDomainIds.set(domain.id, rows[0].id);
      replaiDomainWorkspaces.set(domain.id, rows[0].workspace_id);
      if (!workspaceId || rows[0].workspace_id === workspaceId) summary.domains += 1;
    }

    for (const account of accounts) {
      const replaiDomainId = replaiDomainIds.get(account.domain_id);
      const email = String(account.email_account || "").toLowerCase();
      if (!replaiDomainId || !account.smtp || !account.imap || !account.password) {
        // Scoped callers only see skips for domains their own workspace owns.
        if (!workspaceId || replaiDomainWorkspaces.get(account.domain_id) === workspaceId) {
          summary.skipped.push({ email, reason: domainsById.get(account.domain_id)?.domain_status !== "ACTIVE" ? "domain_not_active" : "missing_connection_details" });
        }
        continue;
      }
      const mailboxWorkspaceId = replaiDomainWorkspaces.get(account.domain_id); // a mailbox always belongs to its domain's workspace

      const status = account.status === "active" && account.is_active ? "Active" : account.status === "failed" ? "Error" : "Paused";
      const displayName = [account.first_name, account.last_name].filter(Boolean).join(" ") || null;

      const { rows } = await db.query(
        `INSERT INTO mailboxes (domain_id, email, local_part, display_name, status, provider, external_id,
                                smtp_host, smtp_port, imap_host, imap_port, password_encrypted, workspace_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'maildoso', $6, $7, $8, $9, $10, $11, $12, NOW())
         ON CONFLICT (email) DO UPDATE SET
           domain_id = EXCLUDED.domain_id, display_name = EXCLUDED.display_name,
           -- Maildoso can downgrade a mailbox (failed/inactive) at any time, but must never undo a
           -- pause Replai applied itself (warmup safety tiers write warmup_last_action) — only a
           -- mailbox still waiting on Maildoso's own setup is promoted to Active.
           status = CASE
             WHEN EXCLUDED.status <> 'Active' THEN EXCLUDED.status
             WHEN mailboxes.status = 'Paused' AND mailboxes.warmup_last_action IS NOT NULL THEN mailboxes.status
             WHEN mailboxes.status = 'Paused' AND mailboxes.imap_last_polled_at IS NOT NULL THEN mailboxes.status
             ELSE EXCLUDED.status
           END,
           provider = 'maildoso', external_id = EXCLUDED.external_id,
           smtp_host = EXCLUDED.smtp_host, smtp_port = EXCLUDED.smtp_port,
           imap_host = EXCLUDED.imap_host, imap_port = EXCLUDED.imap_port,
           password_encrypted = EXCLUDED.password_encrypted, is_deleted = FALSE, updated_at = NOW()
         WHERE mailboxes.workspace_id = EXCLUDED.workspace_id
         RETURNING (xmax = 0) AS inserted`,
        [
          replaiDomainId,
          email,
          email.split("@")[0],
          displayName,
          status,
          String(account.id),
          account.smtp.smtp_host,
          account.smtp.port,
          account.imap.imap_host,
          account.imap.port,
          encryptSecret(account.password),
          mailboxWorkspaceId,
        ]
      );
      if (!rows[0]) {
        // mailboxes.email is globally unique and this address already belongs to a different workspace: leave it alone.
        if (!workspaceId || mailboxWorkspaceId === workspaceId) summary.skipped.push({ email, reason: "email_in_use_by_another_workspace" });
        continue;
      }
      if (workspaceId && mailboxWorkspaceId !== workspaceId) continue;
      if (rows[0].inserted) summary.mailboxesCreated += 1;
      else summary.mailboxesUpdated += 1;
    }

    // New mailboxes start warming up straight away on their own workspace's default (oldest) ramp.
    const { rowCount } = await db.query(
      `UPDATE mailboxes m SET warmup_strategy_id = s.id, daily_limit = s.start_daily_limit, warmup_stage = 'New', warmup_started_at = NOW(), updated_at = NOW()
       FROM (
         SELECT DISTINCT ON (workspace_id) workspace_id, id, start_daily_limit
         FROM warmup_strategies WHERE is_deleted = FALSE
         ORDER BY workspace_id, id ASC
       ) s
       WHERE s.workspace_id = m.workspace_id
         AND m.provider = 'maildoso' AND m.is_deleted = FALSE AND m.warmup_strategy_id IS NULL`
    );
    summary.warmupAssigned = rowCount;

    return summary;
  }

  // ---- Pricing / cost quotes -------------------------------------------------------------

  async getPricing() {
    if (this.pricingCache && Date.now() - this.pricingCache.at < 5 * 60 * 1000) return this.pricingCache.data;
    const data = await this.request("/v1/billing/pricing");
    this.pricingCache = { at: Date.now(), data };
    return data;
  }

  /** Volume pricing: the tier containing the TOTAL quantity sets the unit price for all units. */
  unitPriceCents(pricing, product, quantity) {
    const ranges = pricing?.[product]?.ranges || [];
    const match = ranges.find((range) => (range.from == null || quantity >= range.from) && (range.to == null || quantity <= range.to));
    return (match || ranges[ranges.length - 1])?.price ?? 0;
  }

  async getPlanState() {
    const [subscriptions, accounts] = await Promise.all([
      this.request("/v1/billing/subscriptions"),
      this.request("/v1/user/accounts-lookup?limit=1"),
    ]);
    const active = (subscriptions || []).filter((sub) => sub.status === "active");
    const slotsPaid = active.reduce(
      (sum, sub) => sum + (sub.resources || []).filter((r) => r.name === "email accounts").reduce((n, r) => n + r.count, 0),
      0
    );
    return {
      slotsPaid,
      accountsUsed: accounts?.meta?.total ?? 0,
      monthlyCents: active.reduce((sum, sub) => sum + (sub.type === "monthly" ? sub.price : 0), 0),
      renewalDate: active.map((sub) => sub.renewal_date).sort()[0] || null,
    };
  }

  /**
   * What creating `count` more mailboxes will cost. Mailboxes that fit inside slots you already
   * pay for are free; beyond that the whole account base re-prices at the new volume tier. This
   * is an estimate of the recurring monthly change — Maildoso's invoice is the source of truth.
   */
  async quoteMailboxes(count) {
    const quantity = Math.max(0, Math.floor(Number(count) || 0));
    const [pricing, plan] = await Promise.all([this.getPricing(), this.getPlanState()]);

    const freeSlots = Math.max(0, plan.slotsPaid - plan.accountsUsed);
    const coveredByPlan = quantity <= freeSlots;
    const newTotalAccounts = plan.accountsUsed + quantity;
    const unitCents = this.unitPriceCents(pricing, "maildoso_accounts", Math.max(newTotalAccounts, plan.slotsPaid));
    const newMonthlyCents = coveredByPlan ? plan.monthlyCents : Math.max(newTotalAccounts, plan.slotsPaid) * unitCents;
    const monthlyIncreaseCents = Math.max(0, newMonthlyCents - plan.monthlyCents);

    return {
      provider: "Maildoso",
      mailboxCount: quantity,
      slotsPaid: plan.slotsPaid,
      slotsUsed: plan.accountsUsed,
      freeSlots,
      coveredByPlan,
      unitCents,
      currentMonthlyCents: plan.monthlyCents,
      newMonthlyCents,
      monthlyIncreaseCents,
      dueTodayCents: 0, // Maildoso bills on its own cycle; nothing is charged by Replai itself
      renewalDate: plan.renewalDate,
      currency: "usd",
      summary: coveredByPlan
        ? `Covered by your plan — ${freeSlots - quantity} of ${plan.slotsPaid} prepaid mailbox slots will remain free.`
        : `Goes beyond your ${plan.slotsPaid} prepaid slots: monthly bill rises by about $${(monthlyIncreaseCents / 100).toFixed(2)} (to $${(newMonthlyCents / 100).toFixed(2)}/mo).`,
    };
  }

  async quoteDomains(count) {
    const quantity = Math.max(0, Math.floor(Number(count) || 0));
    const pricing = await this.getPricing();
    const unitCents = this.unitPriceCents(pricing, "domains", quantity);
    return { provider: "Maildoso", domainCount: quantity, unitCents, totalCents: unitCents * quantity, currency: "usd" };
  }

  /**
   * Creates real Maildoso mailboxes (this is what incurs cost). Refuses to run unless the cost
   * the user accepted matches a fresh quote, so a price or plan change between "show cost" and
   * "confirm" can never silently spend more than what was shown.
   */
  async provisionMailboxes({ domain, mailboxes, acceptedMonthlyIncreaseCents, workspaceId }) {
    const domainName = String(domain || "").trim().toLowerCase();
    const { rows: domainRows } = await db.query(
      `SELECT * FROM domains WHERE domain = $1 AND is_deleted = FALSE AND provider = 'Maildoso' AND workspace_id = $2`,
      [domainName, workspaceId]
    );
    const domainRow = domainRows[0];
    if (!domainRow || domainRow.status !== "Verified") {
      throw Object.assign(new Error(`${domainName || "That domain"} isn't an active Maildoso domain`), { statusCode: 400 });
    }
    if (!Array.isArray(mailboxes) || mailboxes.length === 0) {
      throw Object.assign(new Error("Provide at least one mailbox"), { statusCode: 400 });
    }

    const quote = await this.quoteMailboxes(mailboxes.length);
    if (!Number.isInteger(acceptedMonthlyIncreaseCents) || acceptedMonthlyIncreaseCents !== quote.monthlyIncreaseCents) {
      throw Object.assign(new Error("The cost changed or wasn't confirmed — review the updated cost and confirm again"), {
        statusCode: 409,
        code: "COST_NOT_CONFIRMED",
        quote,
      });
    }

    const payload = mailboxes.map((mailbox) => ({
      email_account: `${mailbox.localPart}@${domainName}`,
      first_name: mailbox.firstName,
      last_name: mailbox.lastName,
      password: require("crypto").randomBytes(18).toString("base64url"),
      provider: "maildoso",
      is_active: true,
    }));
    await this.request("/v1/user/accounts", { method: "POST", body: payload });

    // Pull the new mailboxes (and their credentials) straight into Replai.
    const sync = await this.syncMailboxes({ workspaceId });
    const { rows } = await db.query(`SELECT email, status FROM mailboxes WHERE email = ANY($1::text[]) AND is_deleted = FALSE AND workspace_id = $2`, [
      payload.map((item) => item.email_account),
      workspaceId,
    ]);
    const byEmail = new Map(rows.map((row) => [row.email, row.status]));
    return {
      quote,
      sync,
      results: payload.map((item) => ({
        email: item.email_account,
        status: byEmail.has(item.email_account) ? "Created" : "Failed",
        mailboxStatus: byEmail.get(item.email_account) || null,
        error: byEmail.has(item.email_account) ? undefined : "Maildoso did not return this mailbox — check your Maildoso account",
      })),
    };
  }
}

/**
 * Maildoso gives us no CloudWatch-style metrics, so a domain's 14-day bounce rate is derived
 * from our own lead outcomes (hard bounces are detected from DSNs by imapInbox.service.js).
 * Complaint rate stays null — there is no feedback-loop data for these mailboxes — which the
 * warmup safety tiers treat as "no signal" rather than "zero".
 */
MaildosoService.prototype.refreshDomainReputation = async function refreshDomainReputation(domain, workspaceId = null) {
  const { rows } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE cl.status IN ('Sent', 'Replied', 'Bounced'))::int AS sent,
            COUNT(*) FILTER (WHERE cl.status = 'Bounced')::int AS bounced
     FROM campaign_leads cl
     JOIN mailboxes m ON m.id = cl.mailbox_id
     JOIN domains d ON d.id = m.domain_id AND d.workspace_id = m.workspace_id
     WHERE d.domain = $1 AND cl.workspace_id = m.workspace_id AND ($2::int IS NULL OR d.workspace_id = $2)
       AND cl.sent_at > NOW() - INTERVAL '14 days'`,
    [domain, workspaceId]
  );
  const { sent, bounced } = rows[0];
  const bounceRate = sent > 0 ? Math.round((bounced / sent) * 1000) / 1000 : null;
  const reputation = !sent ? "Unknown" : bounceRate > 0.1 ? "At Risk" : bounceRate > 0.05 ? "Watch" : "Healthy";

  const { rows: updated } = await db.query(
    `UPDATE domains SET emails_sent_14d = $2, emails_delivered_14d = $3, emails_bounced_14d = $4,
            emails_complained_14d = NULL, bounce_rate = $5, complaint_rate = NULL,
            delivery_rate = $6, reputation = $7, reputation_checked_at = NOW(), last_checked_at = NOW(), updated_at = NOW()
     WHERE domain = $1 AND ($8::int IS NULL OR workspace_id = $8) RETURNING *`,
    [domain, sent, sent - bounced, bounced, bounceRate, sent > 0 ? Math.round(((sent - bounced) / sent) * 1000) / 1000 : null, reputation, workspaceId]
  );
  return updated[0];
};

module.exports = new MaildosoService();
