const aiKeyService = require("./aiKey.service");

const PROVIDERS = {
  openai: {
    label: "OpenAI",
    envKeys: ["OPENAI_API_KEY"],
    async listModels(apiKey) {
      const payload = await fetchJson("https://api.openai.com/v1/models", {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      return (payload.data || [])
        .map((model) => model.id)
        .filter(isChatModel)
        .sort(sortModelIds);
    },
  },
  anthropic: {
    label: "Anthropic",
    envKeys: ["ANTHROPIC_API_KEY"],
    async listModels(apiKey) {
      const payload = await fetchJson("https://api.anthropic.com/v1/models", {
        headers: {
          "anthropic-version": "2023-06-01",
          "x-api-key": apiKey,
        },
      });

      return (payload.data || []).map((model) => model.id).filter(Boolean);
    },
  },
  gemini: {
    label: "Google Gemini",
    envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    async listModels(apiKey) {
      const payload = await fetchJson(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=1000`
      );

      return (payload.models || [])
        .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
        .map((model) => model.name?.replace(/^models\//, ""))
        .filter(Boolean)
        .sort(sortModelIds);
    },
  },
};

function getProvider(providerId) {
  return PROVIDERS[normalizeProvider(providerId)];
}

async function getModels(providerId, workspaceId) {
  const provider = getProvider(providerId);

  if (!provider) {
    const error = new Error("Unsupported AI provider");
    error.statusCode = 400;
    throw error;
  }

  // Workspace key first; platform env key only when the workspace is allowed to use it (throws AI_PROVIDER_KEY_MISSING / 402).
  const apiKey = await aiKeyService.getApiKey(workspaceId, normalizeProvider(providerId));

  const models = await provider.listModels(apiKey);

  return {
    provider: normalizeProvider(providerId),
    models: [...new Set(models)],
  };
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      const error = new Error(payload?.error?.message || payload?.message || "Unable to fetch models");
      error.statusCode = response.status;
      throw error;
    }

    return payload || {};
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeProvider(providerId) {
  return String(providerId || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/^google-/, "");
}

function isChatModel(modelId) {
  return /^(gpt-|o\d|chatgpt-)/i.test(modelId) && !/audio|image|tts|transcribe|whisper|embedding|moderation|realtime/i.test(modelId);
}

function sortModelIds(a, b) {
  return b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" });
}

module.exports = {
  getModels,
};
