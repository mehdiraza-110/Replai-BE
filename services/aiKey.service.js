const db = require("../config/db.config");
const plusVibeService = require("./plusVibe.service");

// Per-workspace LLM keys. Stored with the same AES-256-GCM helper (and env key) as the PlusVibe API key.
// Every LLM call in the backend must resolve its key through getApiKey().

const PROVIDERS = {
  openai: { label: "OpenAI", envKeys: ["OPENAI_API_KEY"] },
  anthropic: { label: "Anthropic", envKeys: ["ANTHROPIC_API_KEY"] },
  gemini: { label: "Google Gemini", envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
};

const MISSING_KEY_MESSAGE = "Connect an AI provider key in Settings → AI Keys to use this feature.";

function httpError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function missingKeyError(platformAiEnabled) {
  const error = httpError(MISSING_KEY_MESSAGE, 402, "AI_PROVIDER_KEY_MISSING");
  error.platformAiEnabled = Boolean(platformAiEnabled);
  return error;
}

function normalizeProvider(provider) {
  const id = String(provider || "").trim().toLowerCase().replace(/\s+/g, "-").replace(/^google-/, "");
  if (!PROVIDERS[id]) throw httpError("Unsupported AI provider. Use openai, anthropic or gemini.", 400, "AI_PROVIDER_UNSUPPORTED");
  return id;
}

function envKeyFor(provider) {
  return PROVIDERS[provider].envKeys.map((name) => process.env[name]).find(Boolean) || null;
}

async function isPlatformAiEnabled(workspaceId) {
  const { rows } = await db.query(`SELECT platform_ai_enabled FROM workspaces WHERE id = $1 AND is_deleted = FALSE`, [workspaceId]);
  return rows[0]?.platform_ai_enabled === true;
}

function previewOf(apiKey) {
  const key = String(apiKey);
  return key.length > 8 ? `${key.slice(0, 3)}…${key.slice(-4)}` : "••••";
}

// Workspace key first; the platform env key ONLY when the workspace is allowed to use it.
async function getApiKey(workspaceId, provider) {
  const id = normalizeProvider(provider);

  if (workspaceId) {
    const { rows } = await db.query(
      `SELECT api_key_encrypted, api_key_iv, api_key_tag FROM workspace_ai_keys WHERE workspace_id = $1 AND provider = $2`,
      [workspaceId, id]
    );
    if (rows[0]) return plusVibeService.decryptValue(rows[0]);
  }

  const platformEnabled = workspaceId ? await isPlatformAiEnabled(workspaceId) : false;
  if (platformEnabled) {
    const envKey = envKeyFor(id);
    if (envKey) return envKey;
  }

  throw missingKeyError(platformEnabled);
}

async function listForWorkspace(workspaceId) {
  const [keys, platformAiEnabled] = await Promise.all([
    db.query(`SELECT provider, key_preview, updated_at FROM workspace_ai_keys WHERE workspace_id = $1`, [workspaceId]),
    isPlatformAiEnabled(workspaceId),
  ]);
  const byProvider = new Map(keys.rows.map((row) => [row.provider, row]));

  return {
    platformAiEnabled,
    providers: Object.keys(PROVIDERS).map((provider) => {
      const own = byProvider.get(provider);
      const platformFallback = !own && platformAiEnabled && Boolean(envKeyFor(provider));
      return {
        provider,
        configured: Boolean(own) || platformFallback,
        preview: own ? own.key_preview : null,
        source: own ? "workspace" : platformFallback ? "platform" : null,
        updated_at: own ? own.updated_at : null,
      };
    }),
  };
}

// Lightweight authenticated call per provider. Returns { ok, message }.
async function validateWithProvider(provider, apiKey) {
  const requests = {
    openai: () => fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${apiKey}` } }),
    anthropic: () =>
      fetch("https://api.anthropic.com/v1/models?limit=1", { headers: { "anthropic-version": "2023-06-01", "x-api-key": apiKey } }),
    gemini: () =>
      fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(apiKey)}`),
  };
  const label = PROVIDERS[provider].label;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    // Each request ignores the signal if the stub does; the timeout covers the real network.
    const response = await Promise.race([
      requests[provider](),
      new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("timeout")))),
    ]);
    if (response.ok) return { ok: true, message: `${label} accepted this key.` };
    if ([400, 401, 403].includes(response.status)) {
      return { ok: false, message: `${label} rejected this API key. Check that you copied it correctly and that it is active.` };
    }
    return { ok: false, message: `${label} could not verify the key right now (status ${response.status}). Please try again.` };
  } catch (error) {
    return { ok: false, message: `We could not reach ${label} to verify the key. Please try again in a moment.` };
  } finally {
    clearTimeout(timeout);
  }
}

async function saveKey(workspaceId, provider, apiKey, userId = null) {
  const id = normalizeProvider(provider);
  const key = String(apiKey || "").trim();
  if (!key) throw httpError("Enter an API key.", 400, "AI_KEY_REQUIRED");
  if (key.length > 500 || /\s/.test(key)) throw httpError("That doesn't look like a valid API key.", 400, "AI_KEY_INVALID");

  const check = await validateWithProvider(id, key);
  if (!check.ok) {
    // A rejected key is the caller's problem (400); an unreachable provider is a temporary upstream problem.
    throw httpError(check.message, /rejected/.test(check.message) ? 400 : 502, "AI_KEY_REJECTED");
  }

  const enc = plusVibeService.encryptValue(key);
  const { rows } = await db.query(
    `INSERT INTO workspace_ai_keys (workspace_id, provider, api_key_encrypted, api_key_iv, api_key_tag, key_preview, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (workspace_id, provider)
     DO UPDATE SET api_key_encrypted = EXCLUDED.api_key_encrypted, api_key_iv = EXCLUDED.api_key_iv,
                   api_key_tag = EXCLUDED.api_key_tag, key_preview = EXCLUDED.key_preview, updated_at = NOW()
     RETURNING provider, key_preview, updated_at`,
    [workspaceId, id, enc.encrypted, enc.iv, enc.tag, previewOf(key), userId]
  );

  return { provider: id, configured: true, preview: rows[0].key_preview, source: "workspace", updated_at: rows[0].updated_at };
}

async function deleteKey(workspaceId, provider) {
  const id = normalizeProvider(provider);
  const { rowCount } = await db.query(`DELETE FROM workspace_ai_keys WHERE workspace_id = $1 AND provider = $2`, [workspaceId, id]);
  if (rowCount === 0) throw httpError(`No ${PROVIDERS[id].label} key is saved for this workspace.`, 404, "AI_KEY_NOT_FOUND");
  return { provider: id };
}

// Tests the key the workspace would actually use (own key, or the platform one when allowed).
async function testKey(workspaceId, provider) {
  const id = normalizeProvider(provider);
  let apiKey;
  try {
    apiKey = await getApiKey(workspaceId, id);
  } catch (error) {
    if (error.code === "AI_PROVIDER_KEY_MISSING") return { ok: false, message: `No ${PROVIDERS[id].label} key is connected for this workspace.` };
    throw error;
  }
  return validateWithProvider(id, apiKey);
}

module.exports = { getApiKey, listForWorkspace, saveKey, deleteKey, testKey, normalizeProvider, MISSING_KEY_MESSAGE };
