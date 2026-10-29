const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");

const TIMEOUT_MS = 8000;

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    return lower === "::1" || lower === "::" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80") || lower.startsWith("::ffff:");
  }
  return true;
}

/**
 * The webhook URL is customer-supplied, so it must not be usable to reach our own network:
 * https only, and every address the hostname resolves to must be public.
 */
async function assertSafeUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw Object.assign(new Error("Enter a valid https:// URL."), { statusCode: 400 });
  }
  if (url.protocol !== "https:") throw Object.assign(new Error("The webhook URL must start with https://"), { statusCode: 400 });
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw Object.assign(new Error("The webhook URL must be a public address."), { statusCode: 400 });
  }
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((entry) => entry.address);
  if (addresses.length === 0) throw Object.assign(new Error("We couldn't resolve that webhook host."), { statusCode: 400 });
  if (addresses.some(isPrivateAddress)) throw Object.assign(new Error("The webhook URL must be a public address."), { statusCode: 400 });
  return url;
}

function sign(secret, timestamp, body) {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/**
 * Sends one signed POST. Headers: X-SendVybe-Timestamp and X-SendVybe-Signature (hex HMAC-SHA256 of
 * "<timestamp>.<raw body>" with the workspace's webhook secret).
 */
async function deliver({ url, secret, event, data }) {
  const target = await assertSafeUrl(url);
  const body = JSON.stringify({ event, createdAt: new Date().toISOString(), data });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await fetch(target, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      "X-SendVybe-Event": event,
      "X-SendVybe-Timestamp": timestamp,
      "X-SendVybe-Signature": sign(secret, timestamp, body),
    },
    body,
  });
  return { status: response.status, ok: response.ok };
}

module.exports = { deliver, assertSafeUrl, sign };
