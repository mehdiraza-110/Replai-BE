const crypto = require("crypto");
const db = require("../config/db.config");
const eventLogService = require("./eventLog.service");

const PLUSVIBE_API_BASE_URL = process.env.PLUSVIBE_API_BASE_URL || "https://api.plusvibe.ai";

class PlusVibeService {
  async getConnection() {
    const integration = await getActiveIntegration();

    if (!integration) {
      return buildDisconnectedState();
    }

    return mapIntegrationRow(integration);
  }

  async saveConnection(data) {
    const startedAt = Date.now();
    const apiKey = cleanString(data.apiKey);
    const workspaceId = cleanString(data.workspaceId);

    if (!workspaceId) {
      const error = new Error("PlusVibe workspace ID is required");
      error.statusCode = 400;
      throw error;
    }

    const existing = await getActiveIntegration();
    const encryptedKey = apiKey ? encrypt(apiKey) : null;

    if (!existing && !encryptedKey) {
      const error = new Error("PlusVibe API key is required");
      error.statusCode = 400;
      throw error;
    }

    const values = [
      workspaceId,
      cleanString(data.workspaceName),
      cleanString(data.apiKeyScope) || "workspace",
      cleanString(data.webhookEventType) || "ALL_EMAIL_REPLIES",
      cleanString(data.webhookUrl),
      data.createdBy ?? null,
    ];

    if (existing) {
      const keyUpdate = encryptedKey
        ? `api_key_encrypted = $6, api_key_iv = $7, api_key_tag = $8,`
        : "";
      const keyValues = encryptedKey ? [encryptedKey.encrypted, encryptedKey.iv, encryptedKey.tag] : [];

      const result = await db.query(
        `UPDATE plusvibe_integrations
         SET workspace_id = $1,
             workspace_name = $2,
             api_key_scope = $3,
             webhook_event_type = $4,
             webhook_url = $5,
             ${keyUpdate}
             connection_status = 'Configured',
             api_status = 'Not tested',
             webhook_status = CASE WHEN ($5)::varchar IS NULL THEN 'Not configured' ELSE webhook_status END,
             last_error = NULL,
             updated_at = NOW()
         WHERE id = $${6 + keyValues.length} AND is_deleted = FALSE
         RETURNING *`,
        [...values.slice(0, 5), ...keyValues, existing.id]
      );

      const mapped = mapIntegrationRow(result.rows[0]);
      await eventLogService.record({
        eventType: "plusvibe.connection.updated",
        source: "plusvibe",
        status: "Success",
        workspaceId: mapped.workspaceId,
        workspaceName: mapped.workspaceName,
        durationMs: Date.now() - startedAt,
        createdBy: data.createdBy,
        metadata: {
          apiKeyScope: mapped.apiKeyScope,
          webhookEventType: mapped.webhookEventType,
          webhookUrlConfigured: Boolean(mapped.webhookUrl),
          apiKeyRotated: Boolean(encryptedKey),
        },
      });

      return mapped;
    }

    const result = await db.query(
      `INSERT INTO plusvibe_integrations (
        workspace_id,
        workspace_name,
        api_key_scope,
        webhook_event_type,
        webhook_url,
        created_by,
        api_key_encrypted,
        api_key_iv,
        api_key_tag,
        connection_status,
        api_status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Configured', 'Not tested')
      RETURNING *`,
      [...values, encryptedKey.encrypted, encryptedKey.iv, encryptedKey.tag]
    );

    const mapped = mapIntegrationRow(result.rows[0]);
    await eventLogService.record({
      eventType: "plusvibe.connection.created",
      source: "plusvibe",
      status: "Success",
      workspaceId: mapped.workspaceId,
      workspaceName: mapped.workspaceName,
      durationMs: Date.now() - startedAt,
      createdBy: data.createdBy,
      metadata: {
        apiKeyScope: mapped.apiKeyScope,
        webhookEventType: mapped.webhookEventType,
        webhookUrlConfigured: Boolean(mapped.webhookUrl),
      },
    });

    return mapped;
  }

  async testConnection(data = {}) {
    const startedAt = Date.now();
    const integration = await getIntegrationOrThrow();
    const apiKey = cleanString(data.apiKey) || decrypt(integration);
    const workspace = await resolveWorkspace(apiKey, {
      workspaceId: cleanString(data.workspaceId) || integration.workspace_id,
      workspaceName: cleanString(data.workspaceName) || integration.workspace_name,
    });

    try {
      const [hooks, accounts] = await Promise.all([
        plusVibeRequest(`/api/v1/hook/list?workspace_id=${encodeURIComponent(workspace.id)}`, apiKey),
        plusVibeRequest(`/api/v1/account/list?workspace_id=${encodeURIComponent(workspace.id)}`, apiKey),
      ]);
      const webhookCount = Array.isArray(hooks.hooks) ? hooks.hooks.length : 0;
      const webhookStatus = webhookCount > 0 ? "Receiving" : "No webhooks found";
      const inboxes = normalizeAccounts(accounts);

      const result = await db.query(
        `UPDATE plusvibe_integrations
         SET connection_status = 'Connected',
             api_status = 'Connected',
             workspace_id = $1,
             workspace_name = COALESCE($2, workspace_name),
             webhook_status = $3,
             connected_inboxes = $4,
             last_api_request = NOW(),
             last_error = NULL,
             updated_at = NOW()
         WHERE id = $5
         RETURNING *`,
        [workspace.id, workspace.name, webhookStatus, inboxes.length, integration.id]
      );

      const mapped = {
        ...mapIntegrationRow(result.rows[0]),
        remote: { webhookCount, inboxes },
      };
      await eventLogService.record({
        eventType: "plusvibe.connection.tested",
        source: "plusvibe",
        status: "Success",
        workspaceId: mapped.workspaceId,
        workspaceName: mapped.workspaceName,
        durationMs: Date.now() - startedAt,
        metadata: { webhookCount, connectedInboxes: inboxes.length },
      });

      return mapped;
    } catch (error) {
      await markIntegrationFailure(integration.id, error.message);
      await eventLogService.record({
        eventType: "plusvibe.connection.test_failed",
        source: "plusvibe",
        status: "Failed",
        workspaceId: integration.workspace_id,
        workspaceName: integration.workspace_name,
        durationMs: Date.now() - startedAt,
        errorMessage: error.message,
      });
      throw error;
    }
  }

  async refreshConnection() {
    const startedAt = Date.now();
    const integration = await getIntegrationOrThrow();
    const apiKey = decrypt(integration);
    const workspace = await resolveWorkspace(apiKey, integration);

    try {
      const [hooks, summary, accounts] = await Promise.all([
        plusVibeRequest(`/api/v1/hook/list?workspace_id=${encodeURIComponent(workspace.id)}`, apiKey),
        plusVibeRequest(`/api/v1/analytics/workspaces/summary?workspace_id=${encodeURIComponent(workspace.id)}`, apiKey),
        plusVibeRequest(`/api/v1/account/list?workspace_id=${encodeURIComponent(workspace.id)}`, apiKey),
      ]);
      const webhookCount = Array.isArray(hooks.hooks) ? hooks.hooks.length : 0;
      const inboxes = normalizeAccounts(accounts);

      const result = await db.query(
        `UPDATE plusvibe_integrations
         SET connection_status = 'Connected',
             api_status = 'Connected',
             workspace_id = $1,
             workspace_name = COALESCE($2, workspace_name),
             webhook_status = $3,
             synced_campaigns = COALESCE(($4)::int, synced_campaigns),
             connected_inboxes = $5,
             last_api_request = NOW(),
             last_sync_at = NOW(),
             last_error = NULL,
             updated_at = NOW()
         WHERE id = $6
         RETURNING *`,
        [
          workspace.id,
          workspace.name,
          webhookCount > 0 ? "Receiving" : "No webhooks found",
          summary.total_campaigns ?? null,
          inboxes.length,
          integration.id,
        ]
      );

      const mapped = {
        ...mapIntegrationRow(result.rows[0]),
        remote: {
          webhookCount,
          inboxes,
          totalWorkspaces: summary.total_workspaces ?? null,
          totalLeads: summary.total_leads ?? null,
        },
      };
      await eventLogService.record({
        eventType: "plusvibe.connection.refreshed",
        source: "plusvibe",
        status: "Success",
        workspaceId: mapped.workspaceId,
        workspaceName: mapped.workspaceName,
        durationMs: Date.now() - startedAt,
        metadata: {
          webhookCount,
          connectedInboxes: inboxes.length,
          syncedCampaigns: mapped.syncedCampaigns,
          totalLeads: mapped.remote.totalLeads,
        },
      });

      return mapped;
    } catch (error) {
      await markIntegrationFailure(integration.id, error.message);
      await eventLogService.record({
        eventType: "plusvibe.connection.refresh_failed",
        source: "plusvibe",
        status: "Failed",
        workspaceId: integration.workspace_id,
        workspaceName: integration.workspace_name,
        durationMs: Date.now() - startedAt,
        errorMessage: error.message,
      });
      throw error;
    }
  }

  async listInboxes() {
    const startedAt = Date.now();
    const integration = await getIntegrationOrThrow();
    const apiKey = decrypt(integration);
    const workspace = await resolveWorkspace(apiKey, integration);

    const accounts = await plusVibeRequest(`/api/v1/account/list?workspace_id=${encodeURIComponent(workspace.id)}`, apiKey);
    const inboxes = normalizeAccounts(accounts);

    await db.query(
      `UPDATE plusvibe_integrations
       SET workspace_id = $1,
           workspace_name = COALESCE($2, workspace_name),
           connected_inboxes = $3,
           last_api_request = NOW(),
           updated_at = NOW()
       WHERE id = $4`,
      [workspace.id, workspace.name, inboxes.length, integration.id]
    );

    await eventLogService.record({
      eventType: "plusvibe.inboxes.listed",
      source: "plusvibe",
      status: "Success",
      workspaceId: workspace.id,
      workspaceName: workspace.name || integration.workspace_name,
      durationMs: Date.now() - startedAt,
      metadata: { connectedInboxes: inboxes.length },
    });

    return inboxes;
  }

  async listCampaigns() {
    const result = await db.query(
      `SELECT c.*,
              a.name AS assigned_agent_name,
              a.status AS assigned_agent_status
       FROM plusvibe_campaigns c
       LEFT JOIN ai_agents a ON a.id = c.assigned_ai_agent_id
       WHERE c.is_deleted = FALSE
       ORDER BY c.last_lead_replied DESC NULLS LAST, c.updated_at DESC`
    );

    return result.rows.map(mapCampaignRow);
  }

  async syncCampaigns() {
    const startedAt = Date.now();
    const integration = await getIntegrationOrThrow();
    const apiKey = decrypt(integration);
    const workspace = await resolveWorkspace(apiKey, integration);
    const payload = await plusVibeRequest(
      `/api/v1/campaign/list-all?workspace_id=${encodeURIComponent(workspace.id)}&skip=0&limit=100`,
      apiKey
    );
    const campaigns = normalizeCampaigns(payload);
    const client = await db.getClient();

    try {
      await client.query("BEGIN");

      for (const campaign of campaigns) {
        await client.query(
          `INSERT INTO plusvibe_campaigns (
            integration_id,
            plusvibe_campaign_id,
            name,
            status,
            tags,
            last_lead_sent,
            last_lead_replied,
            raw_payload,
            last_synced_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
          ON CONFLICT (integration_id, plusvibe_campaign_id)
          DO UPDATE SET
            name = EXCLUDED.name,
            status = EXCLUDED.status,
            tags = EXCLUDED.tags,
            last_lead_sent = EXCLUDED.last_lead_sent,
            last_lead_replied = EXCLUDED.last_lead_replied,
            raw_payload = EXCLUDED.raw_payload,
            last_synced_at = NOW(),
            updated_at = NOW(),
            is_deleted = FALSE`,
          [
            integration.id,
            campaign.plusvibeCampaignId,
            campaign.name,
            campaign.status,
            JSON.stringify(campaign.tags),
            campaign.lastLeadSent,
            campaign.lastLeadReplied,
            campaign.raw,
          ]
        );
      }

      await client.query(
        `UPDATE plusvibe_integrations
         SET workspace_id = $1,
             workspace_name = COALESCE($2, workspace_name),
             synced_campaigns = $3,
             last_api_request = NOW(),
             last_sync_at = NOW(),
             last_error = NULL,
             updated_at = NOW()
         WHERE id = $4`,
        [workspace.id, workspace.name, campaigns.length, integration.id]
      );

      await client.query(
        `UPDATE plusvibe_campaigns
         SET is_deleted = TRUE,
             updated_at = NOW()
         WHERE integration_id = $1
           AND is_deleted = FALSE
           AND NOT (plusvibe_campaign_id = ANY($2::varchar[]))`,
        [integration.id, campaigns.map((campaign) => campaign.plusvibeCampaignId)]
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    await eventLogService.record({
      eventType: "plusvibe.campaigns.synced",
      source: "plusvibe",
      status: "Success",
      workspaceId: workspace.id,
      workspaceName: workspace.name || integration.workspace_name,
      durationMs: Date.now() - startedAt,
      metadata: { syncedCampaigns: campaigns.length },
    });

    return this.listCampaigns();
  }

  async assignCampaignAgent(campaignId, agentId) {
    if (agentId) {
      const agent = await db.query(
        `SELECT id FROM ai_agents WHERE id = $1 AND is_deleted = FALSE`,
        [agentId]
      );

      if (agent.rows.length === 0) {
        const error = new Error("AI agent not found");
        error.statusCode = 404;
        throw error;
      }
    }

    const result = await db.query(
      `UPDATE plusvibe_campaigns
       SET assigned_ai_agent_id = $1,
           updated_at = NOW()
       WHERE id = $2 AND is_deleted = FALSE
       RETURNING *`,
      [agentId || null, campaignId]
    );

    if (result.rows.length === 0) {
      const error = new Error("PlusVibe campaign not found");
      error.statusCode = 404;
      throw error;
    }

    const campaigns = await this.listCampaigns();
    const campaign = campaigns.find((item) => item.id === Number(campaignId));

    await eventLogService.record({
      eventType: agentId ? "plusvibe.campaign.agent_assigned" : "plusvibe.campaign.agent_unassigned",
      source: "plusvibe",
      status: "Success",
      campaignId: campaign?.plusVibeCampaignId,
      campaignName: campaign?.name,
      aiAgentId: campaign?.assignedAgent?.id || null,
      aiAgentName: campaign?.assignedAgent?.name || null,
      metadata: { campaignRecordId: Number(campaignId) },
    });

    return campaign;
  }

  async getAuthorizedWorkspace() {
    const integration = await getIntegrationOrThrow();
    const apiKey = decrypt(integration);
    const workspace = await resolveWorkspace(apiKey, integration);

    return { integration, apiKey, workspace };
  }

  async request(path, apiKey, options = {}) {
    return plusVibeRequest(path, apiKey, options);
  }

  async recordWebhook(payload) {
    const startedAt = Date.now();
    const workspaceId = cleanString(payload.workspace_id);
    const integration = workspaceId ? await getIntegrationByWorkspace(workspaceId) : await getActiveIntegration();

    const result = await db.query(
      `INSERT INTO plusvibe_webhook_events (
        integration_id,
        webhook_id,
        webhook_event,
        workspace_id,
        email_account_id,
        campaign_id,
        lead_email,
        thread_id,
        source_message_id,
        payload
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, received_at`,
      [
        integration?.id ?? null,
        cleanString(payload.webhook_id),
        cleanString(payload.webhook_event),
        workspaceId,
        cleanString(payload.email_account_id),
        cleanString(payload.campaign_id ?? payload.camp_id),
        cleanString(payload.email ?? payload.lead_email),
        cleanString(payload.thread_id ?? payload.source_thread_id),
        cleanString(payload.source_message_id),
        payload,
      ]
    );

    if (integration) {
      await db.query(
        `UPDATE plusvibe_integrations
         SET webhook_status = 'Receiving',
             last_webhook_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [integration.id]
      );
    }

    const row = result.rows[0];
    await eventLogService.record({
      eventType: "plusvibe.webhook.received",
      source: "plusvibe",
      status: "Success",
      workspaceId,
      workspaceName: integration?.workspace_name,
      campaignId: cleanString(payload.campaign_id ?? payload.camp_id),
      leadEmail: cleanString(payload.email ?? payload.lead_email),
      threadId: cleanString(payload.thread_id ?? payload.source_thread_id),
      messageId: cleanString(payload.source_message_id),
      durationMs: Date.now() - startedAt,
      metadata: {
        webhookEvent: cleanString(payload.webhook_event),
        webhookId: cleanString(payload.webhook_id),
        webhookEventId: row.id,
      },
    });

    return row;
  }
}

async function getActiveIntegration() {
  const result = await db.query(
    `SELECT *
     FROM plusvibe_integrations
     WHERE is_deleted = FALSE
     ORDER BY updated_at DESC
     LIMIT 1`
  );

  return result.rows[0] || null;
}

async function getIntegrationByWorkspace(workspaceId) {
  const result = await db.query(
    `SELECT *
     FROM plusvibe_integrations
     WHERE workspace_id = $1 AND is_deleted = FALSE
     ORDER BY updated_at DESC
     LIMIT 1`,
    [workspaceId]
  );

  return result.rows[0] || null;
}

async function getIntegrationOrThrow() {
  const integration = await getActiveIntegration();

  if (!integration) {
    const error = new Error("Configure PlusVibe before testing the connection");
    error.statusCode = 400;
    throw error;
  }

  return integration;
}

async function resolveWorkspace(apiKey, input = {}) {
  const requestedId = cleanString(input.workspaceId || input.workspace_id);
  const requestedName = cleanString(input.workspaceName || input.workspace_name);
  const payload = await plusVibeRequest("/api/v1/authenticate", apiKey);
  const workspaces = Array.isArray(payload.workspaces) ? payload.workspaces : [];

  if (workspaces.length === 0) {
    const error = new Error("No PlusVibe workspaces are available for this API key");
    error.statusCode = 400;
    throw error;
  }

  const match = workspaces.find((workspace) => {
    const id = cleanString(workspace._id || workspace.id);
    const name = cleanString(workspace.name);

    return id === requestedId || name === requestedId || name === requestedName;
  });

  const workspace = match || (workspaces.length === 1 ? workspaces[0] : null);

  if (!workspace) {
    const error = new Error("PlusVibe workspace ID does not match a workspace for this API key");
    error.statusCode = 400;
    throw error;
  }

  return {
    id: cleanString(workspace._id || workspace.id),
    name: cleanString(workspace.name),
  };
}

async function plusVibeRequest(path, apiKey, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(`${PLUSVIBE_API_BASE_URL}${path}`, {
      method: options.method || "GET",
      headers: {
        "x-api-key": apiKey,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = new Error(payload.message || payload.error || `PlusVibe request failed with ${response.status}`);
      error.statusCode = response.status;
      throw error;
    }

    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function markIntegrationFailure(integrationId, message) {
  await db.query(
    `UPDATE plusvibe_integrations
     SET connection_status = 'Error',
         api_status = 'Failed',
         last_api_request = NOW(),
         last_error = $1,
         updated_at = NOW()
     WHERE id = $2`,
    [message, integrationId]
  );
}

function mapIntegrationRow(row) {
  return {
    id: row.id,
    provider: "PlusVibe",
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    apiKeyScope: row.api_key_scope || "workspace",
    webhookEventType: row.webhook_event_type || "ALL_EMAIL_REPLIES",
    apiKeyConfigured: Boolean(row.api_key_encrypted),
    apiKeyPreview: row.api_key_encrypted ? "••••••••" : null,
    webhookUrl: row.webhook_url,
    connectionStatus: row.connection_status,
    apiStatus: row.api_status,
    webhookStatus: row.webhook_status,
    connectedInboxes: row.connected_inboxes,
    syncedCampaigns: row.synced_campaigns,
    lastApiRequest: row.last_api_request,
    lastWebhook: row.last_webhook_at,
    lastSync: row.last_sync_at,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

function normalizeAccounts(payload) {
  const source = payload?.data || payload?.accounts || payload?.email_accounts || payload?.items || payload;
  const accounts = Array.isArray(source) ? source : [];

  return accounts.map((account) => ({
    id: account.id || account._id || account.email_account_id || account.account_id || null,
    email: account.email || account.email_address || account.from_email || account.username || null,
    name: account.name || account.sender_name || account.from_name || account.email || account.email_address || "Unnamed inbox",
    status: account.status || account.connection_status || account.provider_status || "Unknown",
    provider: account.provider || account.type || null,
  }));
}

function normalizeCampaigns(payload) {
  const source = payload?.data || payload?.campaigns || payload?.items || payload;
  const campaigns = Array.isArray(source) ? source : [];

  return campaigns.map((campaign) => ({
    plusvibeCampaignId: String(campaign.id || campaign._id || campaign.campaign_id),
    name: cleanString(campaign.name || campaign.camp_name) || "Untitled campaign",
    status: cleanString(campaign.status),
    tags: Array.isArray(campaign.tags) ? campaign.tags : [],
    lastLeadSent: cleanString(campaign.last_lead_sent),
    lastLeadReplied: cleanString(campaign.last_lead_replied),
    raw: campaign,
  })).filter((campaign) => campaign.plusvibeCampaignId && campaign.plusvibeCampaignId !== "undefined");
}

function mapCampaignRow(row) {
  return {
    id: row.id,
    plusVibeCampaignId: row.plusvibe_campaign_id,
    name: row.name,
    status: row.status,
    tags: row.tags || [],
    lastLeadSent: row.last_lead_sent,
    lastLeadReplied: row.last_lead_replied,
    assignedAiAgentId: row.assigned_ai_agent_id,
    assignedAgent: row.assigned_ai_agent_id ? {
      id: row.assigned_ai_agent_id,
      name: row.assigned_agent_name,
      status: row.assigned_agent_status,
    } : null,
    lastSyncedAt: row.last_synced_at,
    updatedAt: row.updated_at,
  };
}

function buildDisconnectedState() {
  return {
    id: null,
    provider: "PlusVibe",
    workspaceId: "",
    workspaceName: "",
    apiKeyScope: "workspace",
    webhookEventType: "ALL_EMAIL_REPLIES",
    apiKeyConfigured: false,
    apiKeyPreview: null,
    webhookUrl: "",
    connectionStatus: "Disconnected",
    apiStatus: "Not configured",
    webhookStatus: "Not configured",
    connectedInboxes: 0,
    syncedCampaigns: 0,
    lastApiRequest: null,
    lastWebhook: null,
    lastSync: null,
    lastError: null,
    updatedAt: null,
  };
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    encrypted: encrypted.toString("hex"),
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
  };
}

function decrypt(row) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", getEncryptionKey(), Buffer.from(row.api_key_iv, "hex"));
  decipher.setAuthTag(Buffer.from(row.api_key_tag, "hex"));

  return Buffer.concat([
    decipher.update(Buffer.from(row.api_key_encrypted, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

function getEncryptionKey() {
  const secret = process.env.PLUSVIBE_SECRET_KEY || process.env.JWT_SECRET || process.env.DB_PASSWORD || "replai-local-plusvibe-secret";
  return crypto.createHash("sha256").update(secret).digest();
}

function cleanString(value) {
  if (value === undefined || value === null) return null;

  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

module.exports = new PlusVibeService();
