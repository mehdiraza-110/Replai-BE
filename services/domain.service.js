const {
  SESv2Client,
  CreateEmailIdentityCommand,
  GetEmailIdentityCommand,
  PutEmailIdentityMailFromAttributesCommand,
  PutEmailIdentityDkimSigningAttributesCommand,
  PutEmailIdentityConfigurationSetAttributesCommand,
  GetAccountCommand,
  PutAccountDetailsCommand,
  PutAccountVdmAttributesCommand,
  CreateConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
  GetConfigurationSetEventDestinationsCommand,
} = require("@aws-sdk/client-sesv2");
const {
  Route53Client,
  ListHostedZonesByNameCommand,
  ChangeResourceRecordSetsCommand,
  ListResourceRecordSetsCommand,
} = require("@aws-sdk/client-route-53");
const { CloudWatchClient, GetMetricDataCommand } = require("@aws-sdk/client-cloudwatch");
const dns = require("node:dns").promises;
const db = require("../config/db.config");

const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const MAIL_FROM_SUBDOMAIN = process.env.SES_MAIL_FROM_SUBDOMAIN || "mail";
const DMARC_POLICY = process.env.SES_DMARC_POLICY || "v=DMARC1; p=none;";
const REPUTATION_EVENT_TYPES = ["SEND", "REJECT", "BOUNCE", "COMPLAINT", "DELIVERY", "OPEN", "CLICK", "RENDERING_FAILURE", "DELIVERY_DELAY"];
const REPUTATION_WINDOW_DAYS = 14;

const sesClient = new SESv2Client({ region: AWS_REGION });
const route53Client = new Route53Client({ region: AWS_REGION });
const cloudWatchClient = new CloudWatchClient({ region: AWS_REGION });

let vdmEnsured = false;

class DomainService {
  async listHostedZoneDomains() {
    const zones = [];
    let marker;

    do {
      const page = await route53Client.send(
        new ListHostedZonesByNameCommand({ Marker: marker })
      );
      zones.push(...(page.HostedZones || []));
      marker = page.IsTruncated ? page.NextMarker : undefined;
    } while (marker);

    return zones
      .filter((zone) => !zone.Config?.PrivateZone)
      .map((zone) => ({
        domain: zone.Name.replace(/\.$/, ""),
        hostedZoneId: zone.Id.replace("/hostedzone/", ""),
      }));
  }

  async listDomains({ page = 1, limit = 10, search = "" } = {}) {
    const pageNum = Math.max(1, Number.parseInt(page, 10) || 1);
    const limitNum = Math.min(Math.max(Number.parseInt(limit, 10) || 10, 1), 100);
    const offset = (pageNum - 1) * limitNum;
    const searchTerm = search.trim();
    const searchParam = searchTerm ? [`%${searchTerm}%`] : [];
    const whereClausePlain = searchTerm ? `WHERE is_deleted = FALSE AND domain ILIKE $1` : `WHERE is_deleted = FALSE`;
    const whereClauseAliased = searchTerm ? `WHERE d.is_deleted = FALSE AND d.domain ILIKE $1` : `WHERE d.is_deleted = FALSE`;

    const [itemsResult, totalResult, statusCountsResult] = await Promise.all([
      db.query(
        `SELECT d.*, COALESCE(mb.mailbox_count, 0)::int AS mailbox_count
         FROM domains d
         LEFT JOIN (
           SELECT domain_id, COUNT(*) AS mailbox_count FROM mailboxes WHERE is_deleted = FALSE GROUP BY domain_id
         ) mb ON mb.domain_id = d.id
         ${whereClauseAliased}
         ORDER BY d.created_at DESC LIMIT $${searchParam.length + 1} OFFSET $${searchParam.length + 2}`,
        [...searchParam, limitNum, offset]
      ),
      db.query(`SELECT COUNT(*)::int AS count FROM domains ${whereClausePlain}`, searchParam),
      db.query(`SELECT status, COUNT(*)::int AS count FROM domains WHERE is_deleted = FALSE GROUP BY status`),
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

  async onboardDomains(domainNames, createdBy) {
    const hostedZones = await this.listHostedZoneDomains();
    const hostedZoneByName = new Map(hostedZones.map((z) => [z.domain, z.hostedZoneId]));

    const results = [];
    for (const domainName of domainNames) {
      try {
        const hostedZoneId = hostedZoneByName.get(domainName);
        if (!hostedZoneId) {
          throw new Error(`No Route53 hosted zone found for ${domainName}`);
        }
        const result = await this.onboardDomain(domainName, hostedZoneId, createdBy);
        results.push(result);
      } catch (error) {
        results.push({ domain: domainName, status: "Failed", error: error.message });
      }
    }
    return results;
  }

  async onboardDomain(domainName, hostedZoneId, createdBy) {
    const { dkimTokens, mailFromDomain } = await this.createSesIdentity(domainName);

    // Write the DNS records SES needs into Route53: DKIM CNAMEs, MAIL FROM MX + SPF, root SPF, DMARC.
    // Existing TXT record sets are merged rather than replaced, since UPSERT replaces the whole
    // set and would otherwise silently delete unrelated TXT entries (site verification, etc).
    const existingTxt = await this.getExistingTxtRecords(hostedZoneId, [
      domainName,
      `_dmarc.${domainName}`,
      mailFromDomain,
    ]);
    const changes = buildDnsChanges({ domainName, mailFromDomain, dkimTokens, existingTxt });
    await route53Client.send(
      new ChangeResourceRecordSetsCommand({
        HostedZoneId: hostedZoneId,
        ChangeBatch: { Comment: "SES domain onboarding", Changes: changes },
      })
    );

    const record = await this.upsertDomainRecord({
      domain: domainName,
      hostedZoneId,
      mailFromSubdomain: mailFromDomain,
      dkimTokens,
      createdBy,
      registrar: "Route53",
      dnsProvider: "Route53",
    });

    return {
      domain: domainName,
      status: "Pending Verification",
      record,
      dnsRecords: buildDnsRecordList({ domainName, mailFromDomain, dkimTokens }),
    };
  }

  // For a domain that isn't hosted in this AWS account's Route53 — we still create the SES
  // identity, but hand back the DNS records for the caller to add at their own DNS provider
  // instead of writing them ourselves.
  async onboardExternalDomain(domainName, createdBy) {
    const { dkimTokens, mailFromDomain } = await this.createSesIdentity(domainName);

    const record = await this.upsertDomainRecord({
      domain: domainName,
      hostedZoneId: null,
      mailFromSubdomain: mailFromDomain,
      dkimTokens,
      createdBy,
      registrar: "External",
      dnsProvider: "External",
    });

    return {
      domain: domainName,
      status: "Pending Verification",
      record,
      dnsRecords: buildDnsRecordList({ domainName, mailFromDomain, dkimTokens }),
    };
  }

  async createSesIdentity(domainName) {
    const mailFromDomain = `${MAIL_FROM_SUBDOMAIN}.${domainName}`;

    // Create (or reuse) the SES email identity with Easy DKIM (RSA 2048, managed by SES).
    let identity;
    try {
      identity = await sesClient.send(
        new CreateEmailIdentityCommand({
          EmailIdentity: domainName,
          DkimSigningAttributes: { NextSigningKeyLength: "RSA_2048_BIT" },
        })
      );
    } catch (error) {
      if (error.name === "AlreadyExistsException") {
        identity = await sesClient.send(
          new GetEmailIdentityCommand({ EmailIdentity: domainName })
        );
      } else {
        throw error;
      }
    }

    const dkimTokens = identity.DkimAttributes?.Tokens || [];

    // Configure a custom MAIL FROM domain so bounces/SPF align to our own subdomain.
    await sesClient.send(
      new PutEmailIdentityMailFromAttributesCommand({
        EmailIdentity: domainName,
        MailFromDomain: mailFromDomain,
        BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
      })
    );

    // Reputation tracking: a dedicated configuration set per domain, published to CloudWatch,
    // set as this identity's default so every send from it is measured automatically.
    const configurationSetName = await this.ensureDomainConfigurationSet(domainName);
    await sesClient.send(
      new PutEmailIdentityConfigurationSetAttributesCommand({
        EmailIdentity: domainName,
        ConfigurationSetName: configurationSetName,
      })
    );

    return { dkimTokens, mailFromDomain, configurationSetName };
  }

  async ensureAccountVdmEnabled() {
    if (vdmEnsured) return;
    try {
      await sesClient.send(
        new PutAccountVdmAttributesCommand({
          VdmAttributes: {
            VdmEnabled: "ENABLED",
            DashboardAttributes: { EngagementMetrics: "ENABLED" },
            GuardianAttributes: { OptimizedSharedDelivery: "ENABLED" },
          },
        })
      );
    } catch (error) {
      // Non-fatal — reputation tracking still works per configuration set without account-level VDM.
      console.error("Unable to enable account VDM attributes:", error.message);
    }
    vdmEnsured = true;
  }

  configurationSetNameFor(domainName) {
    const slug = domainName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return `domain-${slug}`.slice(0, 64);
  }

  async ensureDomainConfigurationSet(domainName) {
    await this.ensureAccountVdmEnabled();
    const configurationSetName = this.configurationSetNameFor(domainName);

    try {
      await sesClient.send(
        new CreateConfigurationSetCommand({
          ConfigurationSetName: configurationSetName,
          ReputationOptions: { ReputationMetricsEnabled: true },
          SendingOptions: { SendingEnabled: true },
          VdmOptions: {
            DashboardOptions: { EngagementMetrics: "ENABLED" },
            GuardianOptions: { OptimizedSharedDelivery: "ENABLED" },
          },
        })
      );
    } catch (error) {
      if (error.name !== "AlreadyExistsException") throw error;
    }

    const existingDestinations = await sesClient
      .send(new GetConfigurationSetEventDestinationsCommand({ ConfigurationSetName: configurationSetName }))
      .then((res) => res.EventDestinations || [])
      .catch(() => []);

    if (!existingDestinations.some((destination) => destination.Name === "cloudwatch")) {
      await sesClient.send(
        new CreateConfigurationSetEventDestinationCommand({
          ConfigurationSetName: configurationSetName,
          EventDestinationName: "cloudwatch",
          EventDestination: {
            Enabled: true,
            MatchingEventTypes: REPUTATION_EVENT_TYPES,
            CloudWatchDestination: {
              DimensionConfigurations: [
                {
                  DimensionName: "ses:configuration-set",
                  DimensionValueSource: "MESSAGE_TAG",
                  DefaultDimensionValue: configurationSetName,
                },
              ],
            },
          },
        })
      );
    }

    return configurationSetName;
  }

  async getDomainReputationMetrics(configurationSetName, windowDays = REPUTATION_WINDOW_DAYS) {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - windowDays * 24 * 60 * 60 * 1000);
    const periodSeconds = windowDays * 24 * 60 * 60;
    const dimensions = [{ Name: "ses:configuration-set", Value: configurationSetName }];

    const metricNames = ["Send", "Delivery", "Bounce", "Complaint", "Reject"];
    const response = await cloudWatchClient.send(
      new GetMetricDataCommand({
        StartTime: startTime,
        EndTime: endTime,
        MetricDataQueries: metricNames.map((name) => ({
          Id: name.toLowerCase(),
          MetricStat: {
            Metric: { Namespace: "AWS/SES", MetricName: name, Dimensions: dimensions },
            Period: periodSeconds,
            Stat: "Sum",
          },
        })),
      })
    );

    const byId = Object.fromEntries((response.MetricDataResults || []).map((result) => [result.Id, result.Values?.[0] || 0]));
    const sent = byId.send || 0;
    const delivered = byId.delivery || 0;
    const bounced = byId.bounce || 0;
    const complained = byId.complaint || 0;

    return {
      emailsSent: Math.round(sent),
      emailsDelivered: Math.round(delivered),
      emailsBounced: Math.round(bounced),
      emailsComplained: Math.round(complained),
      bounceRate: sent > 0 ? round3(bounced / sent) : null,
      complaintRate: sent > 0 ? round3(complained / sent) : null,
      deliveryRate: sent > 0 ? round3(delivered / sent) : null,
    };
  }

  reputationLabelFor({ bounceRate, complaintRate, emailsSent }) {
    if (!emailsSent) return "Unknown";
    // Thresholds follow AWS's own published guidance for maintaining sending privileges:
    // bounce rate should stay under 5%, complaint rate under 0.1%.
    if (bounceRate > 0.1 || complaintRate > 0.005) return "At Risk";
    if (bounceRate > 0.05 || complaintRate > 0.001) return "Watch";
    return "Healthy";
  }

  async refreshDomainReputation(domain) {
    const { rows } = await db.query(
      `SELECT id, configuration_set_name FROM domains WHERE domain = $1 AND is_deleted = FALSE`,
      [domain]
    );
    const domainRow = rows[0];
    if (!domainRow) {
      throw Object.assign(new Error(`Domain ${domain} is not onboarded yet`), { statusCode: 404 });
    }

    let configurationSetName = domainRow.configuration_set_name;
    if (!configurationSetName) {
      // Self-heal domains onboarded before reputation tracking existed: wire up the
      // configuration set now and make it this identity's default going forward.
      configurationSetName = await this.ensureDomainConfigurationSet(domain);
      await sesClient.send(
        new PutEmailIdentityConfigurationSetAttributesCommand({
          EmailIdentity: domain,
          ConfigurationSetName: configurationSetName,
        })
      );
    }
    const metrics = await this.getDomainReputationMetrics(configurationSetName);
    const reputation = this.reputationLabelFor({ bounceRate: metrics.bounceRate ?? 0, complaintRate: metrics.complaintRate ?? 0, emailsSent: metrics.emailsSent });

    const { rows: updatedRows } = await db.query(
      `UPDATE domains SET
         configuration_set_name = $2,
         emails_sent_14d = $3,
         emails_delivered_14d = $4,
         emails_bounced_14d = $5,
         emails_complained_14d = $6,
         bounce_rate = $7,
         complaint_rate = $8,
         delivery_rate = $9,
         reputation = $10,
         reputation_checked_at = NOW(),
         updated_at = NOW()
       WHERE domain = $1
       RETURNING *`,
      [
        domain,
        configurationSetName,
        metrics.emailsSent,
        metrics.emailsDelivered,
        metrics.emailsBounced,
        metrics.emailsComplained,
        metrics.bounceRate,
        metrics.complaintRate,
        metrics.deliveryRate,
        reputation,
      ]
    );

    return mapDomainRow(updatedRows[0]);
  }

  async getReputationTrend({ days = 7 } = {}) {
    const daysNum = Math.min(Math.max(Number.parseInt(days, 10) || 7, 1), 30);

    const endTime = new Date();
    endTime.setUTCHours(0, 0, 0, 0);
    endTime.setUTCDate(endTime.getUTCDate() + 1);
    const startTime = new Date(endTime.getTime() - daysNum * 24 * 60 * 60 * 1000);

    const buckets = new Map();
    for (let i = 0; i < daysNum; i += 1) {
      const date = new Date(startTime.getTime() + i * 24 * 60 * 60 * 1000);
      buckets.set(date.toISOString().slice(0, 10), { sent: 0, bounced: 0, complained: 0 });
    }

    const { rows } = await db.query(
      `SELECT DISTINCT configuration_set_name FROM domains WHERE is_deleted = FALSE AND configuration_set_name IS NOT NULL`
    );

    const bucketKeyFor = { send: "sent", bounce: "bounced", complaint: "complained" };
    const responses = await Promise.all(
      rows.map((row) => {
        const dimensions = [{ Name: "ses:configuration-set", Value: row.configuration_set_name }];
        return cloudWatchClient
          .send(
            new GetMetricDataCommand({
              StartTime: startTime,
              EndTime: endTime,
              MetricDataQueries: ["Send", "Bounce", "Complaint"].map((name) => ({
                Id: name.toLowerCase(),
                MetricStat: {
                  Metric: { Namespace: "AWS/SES", MetricName: name, Dimensions: dimensions },
                  Period: 86400,
                  Stat: "Sum",
                },
              })),
            })
          )
          .catch(() => null);
      })
    );

    for (const response of responses) {
      if (!response) continue;
      for (const result of response.MetricDataResults || []) {
        const key = bucketKeyFor[result.Id];
        if (!key) continue;
        (result.Timestamps || []).forEach((timestamp, index) => {
          const dateKey = new Date(timestamp).toISOString().slice(0, 10);
          const bucket = buckets.get(dateKey);
          if (bucket) bucket[key] += result.Values?.[index] || 0;
        });
      }
    }

    return Array.from(buckets.entries())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, bucket]) => ({
        date,
        sentVolume: Math.round(bucket.sent),
        bounceRate: bucket.sent > 0 ? Math.round((bucket.bounced / bucket.sent) * 1000) / 10 : 0,
        complaintRate: bucket.sent > 0 ? Math.round((bucket.complained / bucket.sent) * 10000) / 10 : 0,
      }));
  }

  async deleteDomain(id) {
    const client = await db.getClient();
    try {
      await client.query("BEGIN");

      const { rows: domainRows } = await client.query(
        `UPDATE domains SET is_deleted = TRUE, updated_at = NOW()
         WHERE id = $1 AND is_deleted = FALSE
         RETURNING id, domain`,
        [id]
      );
      if (!domainRows[0]) {
        throw Object.assign(new Error("Domain not found"), { statusCode: 404 });
      }

      const { rows: mailboxRows } = await client.query(
        `UPDATE mailboxes SET is_deleted = TRUE, updated_at = NOW()
         WHERE domain_id = $1 AND is_deleted = FALSE
         RETURNING id`,
        [id]
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

  async upsertDomainRecord({ domain, hostedZoneId, mailFromSubdomain, dkimTokens, createdBy, registrar = "Route53", dnsProvider = "Route53" }) {
    const { rows } = await db.query(
      `INSERT INTO domains (
         domain, registrar, dns_provider, hosted_zone_id, aws_region,
         mail_from_subdomain, spf_status, dkim_status, dmarc_status, mx_status,
         mail_from_status, provider, status, raw_dkim_tokens, created_by, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, 'Pending', 'Pending', 'Pending', 'Pending',
         'Pending', 'Amazon SES', 'Pending Verification', $7, $8, NOW()
       )
       ON CONFLICT (domain) DO UPDATE SET
         registrar = EXCLUDED.registrar,
         dns_provider = EXCLUDED.dns_provider,
         hosted_zone_id = EXCLUDED.hosted_zone_id,
         aws_region = EXCLUDED.aws_region,
         mail_from_subdomain = EXCLUDED.mail_from_subdomain,
         spf_status = 'Pending',
         dkim_status = 'Pending',
         dmarc_status = 'Pending',
         mx_status = 'Pending',
         mail_from_status = 'Pending',
         status = 'Pending Verification',
         raw_dkim_tokens = EXCLUDED.raw_dkim_tokens,
         updated_at = NOW(),
         is_deleted = FALSE
       RETURNING *`,
      [domain, registrar, dnsProvider, hostedZoneId, AWS_REGION, mailFromSubdomain, JSON.stringify(dkimTokens), createdBy || null]
    );
    return mapDomainRow(rows[0]);
  }

  async getExistingTxtRecords(hostedZoneId, names) {
    const wanted = new Set(names.map((n) => `${n.replace(/\.$/, "")}.`));
    const found = new Map();
    let startRecordName;
    let startRecordType;

    do {
      const page = await route53Client.send(
        new ListResourceRecordSetsCommand({
          HostedZoneId: hostedZoneId,
          StartRecordName: startRecordName,
          StartRecordType: startRecordType,
        })
      );

      for (const rrset of page.ResourceRecordSets || []) {
        if (rrset.Type === "TXT" && wanted.has(rrset.Name)) {
          found.set(rrset.Name, rrset.ResourceRecords?.map((r) => r.Value) || []);
        }
      }

      startRecordName = page.IsTruncated ? page.NextRecordName : undefined;
      startRecordType = page.IsTruncated ? page.NextRecordType : undefined;
    } while (startRecordName);

    return found;
  }

  async refreshDomainStatus(domain) {
    const [identity, spfStatus, dmarcStatus] = await Promise.all([
      sesClient.send(new GetEmailIdentityCommand({ EmailIdentity: domain })),
      checkSpfRecord(domain),
      checkDmarcRecord(domain),
    ]);

    const dkimStatus = mapVerificationStatus(identity.DkimAttributes?.Status);
    const mailFromStatus = mapVerificationStatus(identity.MailFromAttributes?.MailFromDomainStatus);
    const verified = identity.VerifiedForSendingStatus === true;

    const overallStatus = verified
      ? "Verified"
      : dkimStatus === "Failed" || mailFromStatus === "Failed"
      ? "Failed"
      : "Pending Verification";

    const { rows } = await db.query(
      `UPDATE domains SET
         dkim_status = $2,
         mail_from_status = $3,
         spf_status = $4,
         mx_status = $3,
         dmarc_status = $5,
         status = $6,
         last_checked_at = NOW(),
         updated_at = NOW()
       WHERE domain = $1
       RETURNING *`,
      [domain, dkimStatus, mailFromStatus, spfStatus, dmarcStatus, overallStatus]
    );

    if (!rows[0]) {
      throw Object.assign(new Error(`Domain ${domain} is not onboarded yet`), { statusCode: 404 });
    }

    // Reputation (bounce/complaint/delivery) is pulled from CloudWatch in the same recheck pass
    // so one "Recheck status" action refreshes everything about the domain.
    try {
      return await this.refreshDomainReputation(domain);
    } catch (error) {
      console.error(`Unable to refresh reputation metrics for ${domain}:`, error.message);
      return mapDomainRow(rows[0]);
    }
  }

  async getAccountStatus() {
    const account = await sesClient.send(new GetAccountCommand({}));
    const { rows } = await db.query(
      `SELECT * FROM ses_account_requests ORDER BY requested_at DESC LIMIT 1`
    );

    return {
      awsRegion: AWS_REGION,
      sendingEnabled: account.SendingEnabled ?? null,
      productionAccessEnabled: account.ProductionAccessEnabled ?? false,
      enforcementStatus: account.EnforcementStatus ?? null,
      max24HourSend: account.SendQuota?.Max24HourSend ?? null,
      maxSendRate: account.SendQuota?.MaxSendRate ?? null,
      sentLast24Hours: account.SendQuota?.SentLast24Hours ?? null,
      latestRequest: rows[0] ? mapAccountRequestRow(rows[0]) : null,
    };
  }

  async requestProductionAccess({ mailType, websiteUrl, useCaseDescription, additionalContactEmailAddresses, createdBy }) {
    if (!mailType || !websiteUrl) {
      throw Object.assign(new Error("mailType and websiteUrl are required"), { statusCode: 400 });
    }

    let status = "Submitted";
    let errorMessage = null;
    try {
      await sesClient.send(
        new PutAccountDetailsCommand({
          MailType: mailType,
          WebsiteURL: websiteUrl,
          UseCaseDescription: useCaseDescription,
          AdditionalContactEmailAddresses: additionalContactEmailAddresses?.length ? additionalContactEmailAddresses : undefined,
          ProductionAccessEnabled: true,
        })
      );
    } catch (error) {
      status = "Failed";
      errorMessage = error.message;
    }

    const { rows } = await db.query(
      `INSERT INTO ses_account_requests (
         aws_region, mail_type, website_url, use_case_description,
         additional_contact_emails, status, error_message, requested_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        AWS_REGION,
        mailType,
        websiteUrl,
        useCaseDescription || null,
        JSON.stringify(additionalContactEmailAddresses || []),
        status,
        errorMessage,
        createdBy || null,
      ]
    );

    if (status === "Failed") {
      throw Object.assign(new Error(errorMessage), { statusCode: 502, record: mapAccountRequestRow(rows[0]) });
    }

    return mapAccountRequestRow(rows[0]);
  }

  async refreshAllDomains() {
    // Every domain is refreshed, not just unverified ones — reputation metrics (bounce/complaint/
    // delivery) need periodic refreshing for verified, actively-sending domains too.
    const { rows } = await db.query(
      `SELECT domain FROM domains WHERE is_deleted = FALSE`
    );
    const results = [];
    for (const row of rows) {
      try {
        results.push(await this.refreshDomainStatus(row.domain));
      } catch (error) {
        results.push({ domain: row.domain, status: "Failed", error: error.message });
      }
    }
    return results;
  }
}

function mergedTxtValues(existingTxt, name, newValue) {
  const key = `${name.replace(/\.$/, "")}.`;
  const existingValues = existingTxt.get(key) || [];
  const quoted = `"${newValue}"`;
  // SPF records must stay singular per RFC 7208; anything starting with "v=spf1" is replaced,
  // everything else (site verification TXTs, etc.) is preserved.
  const isSpf = newValue.startsWith("v=spf1");
  const kept = existingValues.filter((v) => !(isSpf && v.replace(/"/g, "").startsWith("v=spf1")) && v !== quoted);
  return [...kept, quoted].map((Value) => ({ Value }));
}

function buildDnsChanges({ domainName, mailFromDomain, dkimTokens, existingTxt }) {
  const changes = [];

  for (const token of dkimTokens) {
    changes.push({
      Action: "UPSERT",
      ResourceRecordSet: {
        Name: `${token}._domainkey.${domainName}`,
        Type: "CNAME",
        TTL: 600,
        ResourceRecords: [{ Value: `${token}.dkim.amazonses.com` }],
      },
    });
  }

  // MAIL FROM subdomain needs its own MX (for bounces) and SPF TXT record.
  changes.push({
    Action: "UPSERT",
    ResourceRecordSet: {
      Name: mailFromDomain,
      Type: "MX",
      TTL: 600,
      ResourceRecords: [{ Value: `10 feedback-smtp.${AWS_REGION}.amazonses.com` }],
    },
  });
  changes.push({
    Action: "UPSERT",
    ResourceRecordSet: {
      Name: mailFromDomain,
      Type: "TXT",
      TTL: 600,
      ResourceRecords: mergedTxtValues(existingTxt, mailFromDomain, "v=spf1 include:amazonses.com ~all"),
    },
  });

  // Root domain SPF (covers any direct sends from the apex, and mail clients that check it).
  changes.push({
    Action: "UPSERT",
    ResourceRecordSet: {
      Name: domainName,
      Type: "TXT",
      TTL: 600,
      ResourceRecords: mergedTxtValues(existingTxt, domainName, "v=spf1 include:amazonses.com ~all"),
    },
  });

  // DMARC — monitor-only by default; tighten to quarantine/reject once inbox placement is verified.
  changes.push({
    Action: "UPSERT",
    ResourceRecordSet: {
      Name: `_dmarc.${domainName}`,
      Type: "TXT",
      TTL: 600,
      ResourceRecords: mergedTxtValues(existingTxt, `_dmarc.${domainName}`, DMARC_POLICY),
    },
  });

  return changes;
}

function buildDnsRecordList({ domainName, mailFromDomain, dkimTokens }) {
  const records = dkimTokens.map((token) => ({
    purpose: "DKIM",
    type: "CNAME",
    host: `${token}._domainkey.${domainName}`,
    value: `${token}.dkim.amazonses.com`,
  }));

  records.push({
    purpose: "MAIL FROM (bounce routing)",
    type: "MX",
    host: mailFromDomain,
    value: `10 feedback-smtp.${AWS_REGION}.amazonses.com`,
  });
  records.push({
    purpose: "MAIL FROM SPF",
    type: "TXT",
    host: mailFromDomain,
    value: "v=spf1 include:amazonses.com ~all",
  });
  records.push({
    purpose: "SPF",
    type: "TXT",
    host: domainName,
    value: "v=spf1 include:amazonses.com ~all",
  });
  records.push({
    purpose: "DMARC",
    type: "TXT",
    host: `_dmarc.${domainName}`,
    value: DMARC_POLICY,
  });

  return records;
}

async function checkSpfRecord(domain) {
  try {
    const records = await dns.resolveTxt(domain);
    const flat = records.map((parts) => parts.join(""));
    return flat.some((value) => value.startsWith("v=spf1") && value.includes("amazonses.com")) ? "Success" : "Failed";
  } catch (error) {
    if (error.code === "ENODATA" || error.code === "ENOTFOUND") return "Pending";
    return "Failed";
  }
}

async function checkDmarcRecord(domain) {
  try {
    const records = await dns.resolveTxt(`_dmarc.${domain}`);
    const flat = records.map((parts) => parts.join(""));
    return flat.some((value) => value.startsWith("v=DMARC1")) ? "Success" : "Failed";
  } catch (error) {
    if (error.code === "ENODATA" || error.code === "ENOTFOUND") return "Pending";
    return "Failed";
  }
}

function mapVerificationStatus(status) {
  if (status === "SUCCESS") return "Success";
  if (status === "FAILED") return "Failed";
  if (status === "PENDING") return "Pending";
  return "Not started";
}

function mapAccountRequestRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    awsRegion: row.aws_region,
    mailType: row.mail_type,
    websiteUrl: row.website_url,
    useCaseDescription: row.use_case_description,
    additionalContactEmails: row.additional_contact_emails,
    status: row.status,
    errorMessage: row.error_message,
    requestedAt: row.requested_at,
  };
}

function mapDomainRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    domain: row.domain,
    registrar: row.registrar,
    dnsProvider: row.dns_provider,
    hostedZoneId: row.hosted_zone_id,
    awsRegion: row.aws_region,
    mailFromSubdomain: row.mail_from_subdomain,
    spfStatus: row.spf_status,
    dkimStatus: row.dkim_status,
    dmarcStatus: row.dmarc_status,
    mxStatus: row.mx_status,
    mailFromStatus: row.mail_from_status,
    provider: row.provider,
    status: row.status,
    reputation: row.reputation,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error,
    dkimTokens: row.raw_dkim_tokens,
    mailboxCount: row.mailbox_count ?? null,
    configurationSetName: row.configuration_set_name,
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
