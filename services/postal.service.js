const crypto = require("crypto");

// Self-hosted Postal (see Mail-Server-Plan.md). One Postal "server" per API key; set
// POSTAL_API_BASE (e.g. https://postal.kovalr.com) and POSTAL_API_KEY in the environment.
const POSTAL_API_BASE = (process.env.POSTAL_API_BASE || "").replace(/\/+$/, "");
const POSTAL_API_KEY = process.env.POSTAL_API_KEY;

/**
 * Sends an already-built raw MIME message through Postal's /send/raw endpoint. Postal keeps
 * our Message-ID header, which is what bounce webhooks are matched against later.
 * Returns Postal's message id (or null).
 */
async function sendRaw({ mailFrom, to, raw }) {
  if (!POSTAL_API_BASE || !POSTAL_API_KEY) {
    throw new Error("Postal is not configured (POSTAL_API_BASE / POSTAL_API_KEY missing)");
  }

  const response = await fetch(`${POSTAL_API_BASE}/api/v1/send/raw`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Server-API-Key": POSTAL_API_KEY },
    body: JSON.stringify({ mail_from: mailFrom, rcpt_to: [to], data: Buffer.from(raw).toString("base64") }),
    signal: AbortSignal.timeout(30000),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok || body?.status !== "success") {
    const detail = body?.data?.message || body?.data?.code || `HTTP ${response.status}`;
    throw new Error(`Postal send failed: ${detail}`);
  }
  return body.data?.message_id || null;
}

/**
 * Postal webhooks and HTTP endpoints are authenticated with a shared secret on the URL
 * (?token=...), compared in constant time. Fails closed when no secret is configured.
 */
function isValidWebhookToken(token) {
  const secret = process.env.POSTAL_WEBHOOK_SECRET;
  if (!secret || typeof token !== "string") return false;
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { sendRaw, isValidWebhookToken };
