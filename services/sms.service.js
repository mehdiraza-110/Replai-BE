// SMS through Twilio's REST API (no SDK needed).
//
// Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and either TWILIO_FROM_NUMBER (E.164) or TWILIO_MESSAGING_SERVICE_SID.
// Same contract as email.service: never throws, and with NODE_ENV=test or no credentials nothing goes over the
// network; messages are kept in `outbox` instead.

const outbox = [];
let warnedUnconfigured = false;

function isConfigured() {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && (process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_MESSAGING_SERVICE_SID));
}

/** Returns an E.164 number ("+14155550123") or null when the stored value cannot be one. */
function normalizePhone(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, "");
  if (raw.startsWith("+") || raw.startsWith("00")) {
    const e164 = `+${raw.startsWith("00") ? digits.slice(2) : digits}`;
    return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : null;
  }
  // A bare US number (10 digits, or 11 starting with 1) is the only unambiguous case without a country code.
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** Sends one SMS. Returns { ok, skipped?, error? } and never throws. */
async function send({ to, body }) {
  const number = normalizePhone(to);
  if (!number) return { ok: false, error: "No valid phone number." };
  const text = String(body || "").slice(0, 600);

  if (process.env.NODE_ENV === "test" || !isConfigured()) {
    outbox.push({ to: number, body: text, at: new Date().toISOString() });
    if (outbox.length > 500) outbox.shift();
    if (process.env.NODE_ENV !== "test" && !warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn("SMS not sent: Twilio is not configured (set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER).");
    }
    return { ok: true, skipped: true };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const form = new URLSearchParams({ To: number, Body: text });
    if (process.env.TWILIO_MESSAGING_SERVICE_SID) form.set("MessagingServiceSid", process.env.TWILIO_MESSAGING_SERVICE_SID);
    else form.set("From", process.env.TWILIO_FROM_NUMBER);
    const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(process.env.TWILIO_ACCOUNT_SID)}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error(`Twilio rejected an SMS (HTTP ${response.status}): ${detail.slice(0, 200)}`);
      return { ok: false, error: `Twilio returned ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    console.error("Twilio request failed:", error.message);
    return { ok: false, error: error.message };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { send, normalizePhone, isConfigured, outbox };
