const crypto = require("crypto");
const db = require("../config/db.config");

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

// Refresh the access token this many ms before Google's stated expiry, so a
// token never expires mid-request.
const EXPIRY_SKEW_MS = 2 * 60 * 1000;
const STATE_TTL_MS = 15 * 60 * 1000;

class GoogleCalendarService {
  /**
   * Builds the Google consent URL. `access_type=offline` + `prompt=consent` are
   * both required for Google to hand back a refresh_token every time — that
   * refresh_token is what keeps the connection alive indefinitely.
   */
  getAuthUrl(agentId) {
    const id = normalizeAgentId(agentId);
    const params = new URLSearchParams({
      client_id: requireEnv("GOOGLE_CALENDAR_CLIENT_ID"),
      redirect_uri: requireEnv("GOOGLE_CALENDAR_REDIRECT_URI"),
      response_type: "code",
      scope: GOOGLE_SCOPES,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state: signState(id),
    });

    return `${GOOGLE_AUTH_URL}?${params.toString()}`;
  }

  async exchangeCodeForTokens(code) {
    if (!cleanString(code)) {
      const error = new Error("Google did not return an authorization code");
      error.statusCode = 400;
      throw error;
    }

    return googleTokenRequest({
      grant_type: "authorization_code",
      code: String(code),
      client_id: requireEnv("GOOGLE_CALENDAR_CLIENT_ID"),
      client_secret: requireEnv("GOOGLE_CALENDAR_CLIENT_SECRET"),
      redirect_uri: requireEnv("GOOGLE_CALENDAR_REDIRECT_URI"),
    });
  }

  async getUserEmail(accessToken) {
    const response = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = new Error(payload?.error?.message || "Unable to read the connected Google account");
      error.statusCode = response.status;
      throw error;
    }

    return cleanString(payload.email);
  }

  async handleCallback(code, state) {
    const agentId = verifyState(state);
    const tokens = await this.exchangeCodeForTokens(code);
    const accessToken = cleanString(tokens.access_token);
    const refreshToken = cleanString(tokens.refresh_token);

    if (!accessToken) {
      const error = new Error("Google did not return an access token");
      error.statusCode = 502;
      throw error;
    }

    if (!refreshToken) {
      // Without a refresh token the connection would silently die in ~1 hour.
      const error = new Error(
        "Google did not return a refresh token. Remove this app from your Google account permissions and connect again."
      );
      error.statusCode = 502;
      throw error;
    }

    const email = await this.getUserEmail(accessToken).catch(() => null);
    const encryptedAccess = encrypt(accessToken);
    const encryptedRefresh = encrypt(refreshToken);
    const expiry = expiryFromSeconds(tokens.expires_in);

    const result = await db.query(
      `INSERT INTO calendar_connections (
        ai_agent_id,
        provider,
        google_email,
        access_token_encrypted,
        access_token_iv,
        access_token_tag,
        refresh_token_encrypted,
        refresh_token_iv,
        refresh_token_tag,
        token_expiry,
        calendar_id,
        status
      )
      VALUES ($1, 'google', $2, $3, $4, $5, $6, $7, $8, $9, 'primary', 'connected')
      ON CONFLICT (ai_agent_id, provider)
      DO UPDATE SET google_email = EXCLUDED.google_email,
                    access_token_encrypted = EXCLUDED.access_token_encrypted,
                    access_token_iv = EXCLUDED.access_token_iv,
                    access_token_tag = EXCLUDED.access_token_tag,
                    refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
                    refresh_token_iv = EXCLUDED.refresh_token_iv,
                    refresh_token_tag = EXCLUDED.refresh_token_tag,
                    token_expiry = EXCLUDED.token_expiry,
                    status = 'connected',
                    updated_at = now()
      RETURNING id, ai_agent_id, provider, google_email, status, created_at`,
      [
        agentId,
        email,
        encryptedAccess.encrypted,
        encryptedAccess.iv,
        encryptedAccess.tag,
        encryptedRefresh.encrypted,
        encryptedRefresh.iv,
        encryptedRefresh.tag,
        expiry,
      ]
    );

    return mapConnectionRow(result.rows[0]);
  }

  /**
   * Always returns a usable access token: the stored one while it is still
   * comfortably valid, otherwise a freshly minted one from the refresh token.
   * If Google has revoked the grant, the connection is marked 'revoked' and a
   * typed error (code CALENDAR_CONNECTION_REVOKED) is thrown for the caller.
   */
  async getValidAccessToken(connection) {
    if (!connection) {
      const error = new Error("No calendar connection was provided");
      error.statusCode = 400;
      throw error;
    }

    const expiresAt = connection.token_expiry ? new Date(connection.token_expiry).getTime() : 0;
    const stillValid = Number.isFinite(expiresAt) && expiresAt - EXPIRY_SKEW_MS > Date.now();
    const storedAccessToken = connection.access_token_encrypted
      ? decrypt(connection, "access_token")
      : null;

    if (stillValid && storedAccessToken) return storedAccessToken;

    if (!connection.refresh_token_encrypted) {
      await markRevoked(connection.id);
      throw buildRevokedError("This calendar connection has no refresh token. Reconnect the Google account.");
    }

    const refreshToken = decrypt(connection, "refresh_token");

    let tokens;
    try {
      tokens = await googleTokenRequest({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: requireEnv("GOOGLE_CALENDAR_CLIENT_ID"),
        client_secret: requireEnv("GOOGLE_CALENDAR_CLIENT_SECRET"),
      });
    } catch (error) {
      if (error.statusCode === 400 || error.googleError === "invalid_grant") {
        await markRevoked(connection.id);
        throw buildRevokedError(
          "Google revoked access to this calendar. Reconnect the Google account to resume automatic booking."
        );
      }
      throw error;
    }

    const accessToken = cleanString(tokens.access_token);
    if (!accessToken) {
      throw new Error("Google did not return a refreshed access token");
    }

    const encryptedAccess = encrypt(accessToken);
    const expiry = expiryFromSeconds(tokens.expires_in);

    await db.query(
      `UPDATE calendar_connections
       SET access_token_encrypted = $1,
           access_token_iv = $2,
           access_token_tag = $3,
           token_expiry = $4,
           status = 'connected',
           updated_at = now()
       WHERE id = $5`,
      [encryptedAccess.encrypted, encryptedAccess.iv, encryptedAccess.tag, expiry, connection.id]
    );

    // Keep the in-memory row in sync so a caller reusing it does not refresh twice.
    connection.access_token_encrypted = encryptedAccess.encrypted;
    connection.access_token_iv = encryptedAccess.iv;
    connection.access_token_tag = encryptedAccess.tag;
    connection.token_expiry = expiry;

    return accessToken;
  }

  async listConnections(agentId) {
    const id = normalizeAgentId(agentId);
    const result = await db.query(
      `SELECT id, provider, google_email, status, created_at
       FROM calendar_connections
       WHERE ai_agent_id = $1
       ORDER BY created_at DESC`,
      [id]
    );

    return result.rows.map(mapConnectionRow);
  }

  /**
   * Fetches the full (token-bearing) row for internal use. Never expose this
   * over HTTP — it carries the encrypted credential columns.
   */
  async getConnectedForAgent(agentId) {
    const result = await db.query(
      `SELECT *
       FROM calendar_connections
       WHERE ai_agent_id = $1
         AND provider = 'google'
         AND status = 'connected'
       LIMIT 1`,
      [agentId]
    );

    return result.rows[0] || null;
  }

  /**
   * Best-effort revoke at Google, then always delete the local row — a failed
   * revoke (already-revoked token, network blip) must not leave a dangling
   * connection the user cannot get rid of.
   */
  async disconnectConnection(connectionId) {
    const result = await db.query(`SELECT * FROM calendar_connections WHERE id = $1`, [connectionId]);
    const connection = result.rows[0];

    if (!connection) {
      const error = new Error("Calendar connection not found");
      error.statusCode = 404;
      throw error;
    }

    try {
      const token = connection.access_token_encrypted
        ? decrypt(connection, "access_token")
        : connection.refresh_token_encrypted
          ? decrypt(connection, "refresh_token")
          : null;

      if (token) {
        await fetch(GOOGLE_REVOKE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token }).toString(),
        });
      }
    } catch (error) {
      console.warn("Google token revoke failed, deleting the local connection anyway:", error.message);
    }

    await db.query(`DELETE FROM calendar_connections WHERE id = $1`, [connectionId]);

    return { id: connection.id, aiAgentId: connection.ai_agent_id, provider: connection.provider };
  }
}

async function googleTokenRequest(form) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      payload.error_description || payload.error || `Google token request failed with ${response.status}`
    );
    error.statusCode = response.status;
    error.googleError = payload.error || null;
    throw error;
  }

  return payload;
}

async function markRevoked(connectionId) {
  await db.query(
    `UPDATE calendar_connections
     SET status = 'revoked', updated_at = now()
     WHERE id = $1`,
    [connectionId]
  );
}

function buildRevokedError(message) {
  const error = new Error(message);
  error.statusCode = 401;
  error.code = "CALENDAR_CONNECTION_REVOKED";
  return error;
}

function mapConnectionRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    provider: row.provider,
    googleEmail: row.google_email,
    status: row.status,
    createdAt: row.created_at,
  };
}

function expiryFromSeconds(expiresIn) {
  const seconds = Number(expiresIn);
  const ttl = Number.isFinite(seconds) && seconds > 0 ? seconds : 3600;
  return new Date(Date.now() + ttl * 1000);
}

function normalizeAgentId(agentId) {
  const id = Number(agentId);

  if (!Number.isInteger(id) || id <= 0) {
    const error = new Error("A valid agentId is required");
    error.statusCode = 400;
    throw error;
  }

  return id;
}

/**
 * OAuth state is HMAC-signed so a caller cannot swap in another agent's id and
 * attach their Google account to an agent they do not control.
 */
function signState(agentId) {
  const payload = `${agentId}.${Date.now()}`;
  const signature = crypto.createHmac("sha256", getEncryptionKey()).update(payload).digest("hex");
  return Buffer.from(`${payload}.${signature}`, "utf8").toString("base64url");
}

function verifyState(state) {
  const raw = cleanString(state);
  if (!raw) throw buildStateError();

  let decoded;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    throw buildStateError();
  }

  const parts = decoded.split(".");
  if (parts.length !== 3) throw buildStateError();

  const [agentId, issuedAt, signature] = parts;
  const expected = crypto
    .createHmac("sha256", getEncryptionKey())
    .update(`${agentId}.${issuedAt}`)
    .digest("hex");

  const provided = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  if (provided.length !== expectedBuffer.length || !crypto.timingSafeEqual(provided, expectedBuffer)) {
    throw buildStateError();
  }

  if (!Number.isFinite(Number(issuedAt)) || Date.now() - Number(issuedAt) > STATE_TTL_MS) {
    throw buildStateError("This Google Calendar connection link has expired. Start the connection again.");
  }

  return normalizeAgentId(agentId);
}

function buildStateError(message) {
  const error = new Error(message || "The Google Calendar connection request could not be verified");
  error.statusCode = 400;
  error.code = "CALENDAR_STATE_INVALID";
  return error;
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

function decrypt(row, prefix) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(row[`${prefix}_iv`], "hex")
  );
  decipher.setAuthTag(Buffer.from(row[`${prefix}_tag`], "hex"));

  return Buffer.concat([
    decipher.update(Buffer.from(row[`${prefix}_encrypted`], "hex")),
    decipher.final(),
  ]).toString("utf8");
}

// No fallback chain on purpose: this key protects long-lived Google credentials,
// so a missing/rotated key must fail loudly rather than quietly encrypt tokens
// under a guessable secret.
function getEncryptionKey() {
  const secret = process.env.CALENDAR_ENCRYPTION_KEY;

  if (!secret || String(secret).trim().length === 0) {
    const error = new Error("CALENDAR_ENCRYPTION_KEY is not configured. Google Calendar features are disabled.");
    error.statusCode = 500;
    error.code = "CALENDAR_ENCRYPTION_KEY_MISSING";
    throw error;
  }

  return crypto.createHash("sha256").update(String(secret)).digest();
}

function requireEnv(name) {
  const value = cleanString(process.env[name]);

  if (!value) {
    const error = new Error(`${name} is not configured. Google Calendar features are disabled.`);
    error.statusCode = 500;
    error.code = "CALENDAR_CONFIG_MISSING";
    throw error;
  }

  return value;
}

function cleanString(value) {
  if (value === undefined || value === null) return null;

  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

module.exports = new GoogleCalendarService();
