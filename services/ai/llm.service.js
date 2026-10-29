const aiKeyService = require("../aiKey.service");
const quotaService = require("../quota.service");

const PROVIDERS = ["anthropic", "openai", "gemini"];
const DEFAULT_MODELS = { anthropic: "claude-sonnet-5-5", openai: "gpt-4o", gemini: "gemini-2.0-flash" };

const unavailable = (message, code) => Object.assign(new Error(message), { statusCode: 503, code });

// Tests swap this to run offline: (request) => Promise<string>.
let transport = null;
const setTransport = (fn) => { transport = fn; };

/** The first provider this workspace can use: its own key, or the platform key where allowed. */
async function resolve(workspaceId) {
  for (const provider of process.env.SDR_DEFAULT_PROVIDER ? [process.env.SDR_DEFAULT_PROVIDER] : PROVIDERS) {
    try {
      const apiKey = await aiKeyService.getApiKey(workspaceId, provider);
      return { provider, apiKey, model: process.env.SDR_DEFAULT_MODEL || DEFAULT_MODELS[provider] };
    } catch (error) {
      if (error.code !== "AI_PROVIDER_KEY_MISSING") throw error;
    }
  }
  return null;
}

const reasoning = (model) => /^(gpt-5|o\d)/i.test(model);

async function post(url, headers, body, label) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(150000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `${label} request failed (${response.status})`);
  return payload;
}

const CALLS = {
  async openai({ apiKey, model, system, messages, maxTokens, temperature }) {
    const payload = await post("https://api.openai.com/v1/chat/completions", { Authorization: `Bearer ${apiKey}` }, {
      model, ...(reasoning(model) ? {} : { temperature, max_tokens: maxTokens }), messages: [{ role: "system", content: system }, ...messages],
    }, "OpenAI");
    return payload.choices?.[0]?.message?.content;
  },
  async anthropic({ apiKey, model, system, messages, maxTokens, temperature }) {
    const payload = await post("https://api.anthropic.com/v1/messages", { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, { model, max_tokens: maxTokens, temperature, system, messages }, "Anthropic");
    return (payload.content || []).filter((b) => b?.type === "text").map((b) => b.text).join("");
  },
  async gemini({ apiKey, model, system, messages, maxTokens, temperature }) {
    const payload = await post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { "x-goog-api-key": apiKey }, {
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      generationConfig: { temperature, maxOutputTokens: maxTokens },
    }, "Gemini");
    return (payload.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  },
};

/**
 * One model call for a feature. Counts against the workspace's AI request limit (a QuotaError propagates).
 * Unlike the SDR helper this throws when the model can't answer, because a person is waiting for the result.
 * @returns {Promise<{text: string, model: string}>}
 */
async function complete({ workspaceId, system, messages, action, maxTokens = 4096, temperature = 0.4 }) {
  const resolved = transport ? { provider: "test", model: "test-model", apiKey: "" } : await resolve(workspaceId);
  if (!resolved) throw unavailable("AI isn't set up for this workspace yet. Add an AI provider key (account menu, then AI keys), or ask your admin.", "AI_NOT_CONFIGURED");
  await quotaService.consume(workspaceId, "ai_requests", 1, { action });
  let text;
  try {
    text = transport ? await transport({ system, messages, action }) : await CALLS[resolved.provider]({ ...resolved, system, messages, maxTokens, temperature });
  } catch (error) {
    console.warn(`AI ${action} failed:`, error.message);
    throw unavailable("The AI model couldn't answer right now. Try again in a moment.", "AI_CALL_FAILED");
  }
  text = String(text || "").trim();
  if (!text) throw unavailable("The AI model returned an empty answer. Try again.", "AI_EMPTY");
  return { text, model: `${resolved.provider}:${resolved.model}` };
}

/** Model call that must return a JSON object; retries once on unparseable output. */
async function completeJson(options) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { text, model } = await complete({ ...options, temperature: 0.2 });
    try {
      const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start === -1 || end <= start) throw new Error("not json");
      return { json: JSON.parse(cleaned.slice(start, end + 1)), model };
    } catch (error) {
      lastError = error;
    }
  }
  throw unavailable("The AI model returned something we couldn't read. Try again.", "AI_BAD_OUTPUT");
}

module.exports = { complete, completeJson, setTransport };
