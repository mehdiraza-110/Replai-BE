const crypto = require("crypto");
const db = require("../config/db.config");
const eventLogService = require("./eventLog.service");

const GHL_API_BASE_URL = process.env.GHL_API_BASE_URL || "https://services.leadconnectorhq.com";
const GHL_API_VERSION = process.env.GHL_API_VERSION || "2021-07-28";

class GhlService {
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
    const locationId = cleanString(data.locationId);

    if (!locationId) {
      const error = new Error("GHL location ID is required");
      error.statusCode = 400;
      throw error;
    }

    const existing = await getActiveIntegration();
    const encryptedKey = apiKey ? encrypt(apiKey) : null;

    if (!existing && !encryptedKey) {
      const error = new Error("GHL API key is required");
      error.statusCode = 400;
      throw error;
    }

    const values = [locationId, cleanString(data.locationName), data.createdBy ?? null];

    if (existing) {
      const keyUpdate = encryptedKey ? `api_key_encrypted = $4, api_key_iv = $5, api_key_tag = $6,` : "";
      const keyValues = encryptedKey ? [encryptedKey.encrypted, encryptedKey.iv, encryptedKey.tag] : [];

      const result = await db.query(
        `UPDATE ghl_integrations
         SET location_id = $1,
             location_name = $2,
             ${keyUpdate}
             connection_status = 'Configured',
             api_status = 'Not tested',
             last_error = NULL,
             updated_at = NOW()
         WHERE id = $${4 + keyValues.length} AND is_deleted = FALSE
         RETURNING *`,
        [...values.slice(0, 2), ...keyValues, existing.id]
      );

      const mapped = mapIntegrationRow(result.rows[0]);
      await eventLogService.record({
        eventType: "ghl.connection.updated",
        source: "ghl",
        status: "Success",
        workspaceId: mapped.locationId,
        workspaceName: mapped.locationName,
        durationMs: Date.now() - startedAt,
        createdBy: data.createdBy,
        metadata: { apiKeyRotated: Boolean(encryptedKey) },
      });

      return mapped;
    }

    const result = await db.query(
      `INSERT INTO ghl_integrations (
        location_id,
        location_name,
        created_by,
        api_key_encrypted,
        api_key_iv,
        api_key_tag,
        connection_status,
        api_status
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'Configured', 'Not tested')
      RETURNING *`,
      [...values, encryptedKey.encrypted, encryptedKey.iv, encryptedKey.tag]
    );

    const mapped = mapIntegrationRow(result.rows[0]);
    await eventLogService.record({
      eventType: "ghl.connection.created",
      source: "ghl",
      status: "Success",
      workspaceId: mapped.locationId,
      workspaceName: mapped.locationName,
      durationMs: Date.now() - startedAt,
      createdBy: data.createdBy,
      metadata: {},
    });

    return mapped;
  }

  async testConnection(data = {}) {
    const startedAt = Date.now();
    const integration = await getIntegrationOrThrow();
    const apiKey = cleanString(data.apiKey) || decrypt(integration);
    const locationId = cleanString(data.locationId) || integration.location_id;

    try {
      const location = await ghlRequest(`/locations/${encodeURIComponent(locationId)}`, apiKey);
      const locationName = cleanString(location?.location?.name || location?.name) || integration.location_name;

      const result = await db.query(
        `UPDATE ghl_integrations
         SET connection_status = 'Connected',
             api_status = 'Connected',
             location_id = $1,
             location_name = COALESCE($2, location_name),
             last_api_request = NOW(),
             last_error = NULL,
             updated_at = NOW()
         WHERE id = $3
         RETURNING *`,
        [locationId, locationName, integration.id]
      );

      const mapped = mapIntegrationRow(result.rows[0]);
      await eventLogService.record({
        eventType: "ghl.connection.tested",
        source: "ghl",
        status: "Success",
        workspaceId: mapped.locationId,
        workspaceName: mapped.locationName,
        durationMs: Date.now() - startedAt,
        metadata: {},
      });

      return mapped;
    } catch (error) {
      await markIntegrationFailure(integration.id, error.message);
      await eventLogService.record({
        eventType: "ghl.connection.test_failed",
        source: "ghl",
        status: "Failed",
        workspaceId: integration.location_id,
        workspaceName: integration.location_name,
        durationMs: Date.now() - startedAt,
        errorMessage: error.message,
      });
      throw error;
    }
  }

  /**
   * Best-effort push of a lead's reply into GHL Conversations, once an AI agent's
   * reply has actually gone out (either auto-sent, or approved by a human reviewer).
   * Never throws — a misconfigured or unreachable GHL connection should not block
   * the reply from being sent to the lead through the primary channel.
   */
  async syncLeadConversation({ leadEmail, leadName, subject, body, direction = "outbound" }) {
    const startedAt = Date.now();
    const email = cleanString(leadEmail);

    if (!email) return { synced: false, reason: "missing_lead_email" };

    const integration = await getActiveIntegration();
    if (!integration || integration.connection_status !== "Connected") {
      return { synced: false, reason: "not_connected" };
    }

    try {
      const apiKey = decrypt(integration);
      const contact = await ghlRequest("/contacts/upsert", apiKey, {
        method: "POST",
        body: {
          locationId: integration.location_id,
          email,
          name: cleanString(leadName) || email,
        },
      });
      const contactId = contact?.contact?.id || contact?.id;

      if (!contactId) {
        throw new Error("GHL did not return a contact ID for this lead");
      }

      await ghlRequest("/conversations/messages", apiKey, {
        method: "POST",
        body: {
          type: "Email",
          contactId,
          subject: cleanString(subject) || "Reply from ReplyOS AI agent",
          message: cleanString(body) || "",
          direction,
        },
      });

      await db.query(
        `UPDATE ghl_integrations
         SET synced_leads = synced_leads + 1,
             last_api_request = NOW(),
             last_sync_at = NOW(),
             last_error = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [integration.id]
      );

      await eventLogService.record({
        eventType: "ghl.conversation.synced",
        source: "ghl",
        status: "Success",
        workspaceId: integration.location_id,
        workspaceName: integration.location_name,
        leadEmail: email,
        durationMs: Date.now() - startedAt,
        metadata: { contactId },
      });

      return { synced: true, contactId };
    } catch (error) {
      await markIntegrationFailure(integration.id, error.message);
      await eventLogService.record({
        eventType: "ghl.conversation.sync_failed",
        source: "ghl",
        status: "Failed",
        workspaceId: integration.location_id,
        workspaceName: integration.location_name,
        leadEmail: email,
        durationMs: Date.now() - startedAt,
        errorMessage: error.message,
      });

      return { synced: false, reason: "request_failed", error: error.message };
    }
  }
}

async function getActiveIntegration() {
  const result = await db.query(
    `SELECT *
     FROM ghl_integrations
     WHERE is_deleted = FALSE
     ORDER BY updated_at DESC
     LIMIT 1`
  );

  return result.rows[0] || null;
}

async function getIntegrationOrThrow() {
  const integration = await getActiveIntegration();

  if (!integration) {
    const error = new Error("Configure GHL before testing the connection");
    error.statusCode = 400;
    throw error;
  }

  return integration;
}

async function ghlRequest(path, apiKey, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(`${GHL_API_BASE_URL}${path}`, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Version: GHL_API_VERSION,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = new Error(payload.message || payload.error || `GHL request failed with ${response.status}`);
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
    `UPDATE ghl_integrations
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
    provider: "GHL",
    locationId: row.location_id,
    locationName: row.location_name,
    apiKeyConfigured: Boolean(row.api_key_encrypted),
    apiKeyPreview: row.api_key_encrypted ? "••••••••" : null,
    connectionStatus: row.connection_status,
    apiStatus: row.api_status,
    syncedLeads: row.synced_leads,
    lastApiRequest: row.last_api_request,
    lastSync: row.last_sync_at,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

function buildDisconnectedState() {
  return {
    id: null,
    provider: "GHL",
    locationId: "",
    locationName: "",
    apiKeyConfigured: false,
    apiKeyPreview: null,
    connectionStatus: "Disconnected",
    apiStatus: "Not configured",
    syncedLeads: 0,
    lastApiRequest: null,
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
  const secret = process.env.GHL_SECRET_KEY || process.env.JWT_SECRET || process.env.DB_PASSWORD || "replai-local-ghl-secret";
  return crypto.createHash("sha256").update(secret).digest();
}

function cleanString(value) {
  if (value === undefined || value === null) return null;

  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

module.exports = new GhlService();
