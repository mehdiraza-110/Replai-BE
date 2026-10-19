// Transactional email through SendGrid (password reset, member invites, order and trial notifications, workflow notifications).
//
// Env: SENDGRID_API_KEY, SENDGRID_FROM_EMAIL, SENDGRID_FROM_NAME, APP_FRONTEND_URL (defaults to the production app).
// Never throws: every caller treats email as best effort and must not fail the action that triggered it. With
// NODE_ENV=test, or no API key configured, nothing is sent over the network; messages are kept in `outbox` instead
// (tests assert on it, and an unconfigured environment just logs a warning once).

const outbox = [];
let warnedUnconfigured = false;

const DEFAULT_APP_URL = "https://www.replyos.kovalai.ai/app";

function appUrl(path = "") {
  const base = String(process.env.APP_FRONTEND_URL || DEFAULT_APP_URL).replace(/\/+$/, "");
  const suffix = path ? `/${String(path).replace(/^\/+/, "")}` : "";
  return `${base}${suffix}`;
}

function isConfigured() {
  return Boolean(process.env.SENDGRID_API_KEY && process.env.SENDGRID_FROM_EMAIL);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Wraps content in the standard ReplyOS email layout. `bodyHtml` must already be safe HTML (build it with
 * escapeHtml for any user-supplied text). Returns { html, text }.
 */
function renderEmail({ title, preheader = "", paragraphs = [], cta = null, footnote = "" }) {
  const paras = paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#1f2933;">${p}</p>`).join("");
  const button = cta
    ? `<p style="margin:22px 0;"><a href="${escapeHtml(cta.url)}" style="background:#0b6bff;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:10px;font-size:15px;font-weight:600;display:inline-block;">${escapeHtml(cta.label)}</a></p>
       <p style="margin:0 0 14px;font-size:12px;color:#6b7280;word-break:break-all;">If the button does not work, copy this link into your browser:<br>${escapeHtml(cta.url)}</p>`
    : "";
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;">
  <span style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 12px;">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;padding:30px;">
      <tr><td>
        <p style="margin:0 0 18px;font-size:13px;font-weight:700;letter-spacing:.04em;color:#0b6bff;">ReplyOS</p>
        <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#111827;">${escapeHtml(title)}</h1>
        ${paras}${button}
        ${footnote ? `<p style="margin:18px 0 0;font-size:12px;line-height:1.5;color:#6b7280;">${footnote}</p>` : ""}
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
  const stripTags = (s) => String(s).replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const text = [title, "", ...paragraphs.map(stripTags), cta ? `${cta.label}: ${cta.url}` : "", footnote ? stripTags(footnote) : ""].filter((l) => l !== undefined).join("\n");
  return { html, text };
}

/**
 * Sends one email. `to` is an address or an array of addresses. Returns { ok, skipped?, error? } and never throws.
 */
async function send({ to, subject, text, html, replyTo = null, category = null }) {
  const recipients = (Array.isArray(to) ? to : [to])
    .map((address) => String(address || "").trim())
    .filter((address) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address));
  const unique = [...new Set(recipients.map((a) => a.toLowerCase()))];
  if (unique.length === 0) return { ok: false, error: "No valid recipient address." };

  const message = { to: unique, subject: String(subject || "").slice(0, 200), text: text || "", html: html || null, replyTo, category };

  if (process.env.NODE_ENV === "test" || !isConfigured()) {
    outbox.push({ ...message, at: new Date().toISOString() });
    if (outbox.length > 500) outbox.shift();
    if (process.env.NODE_ENV !== "test" && !warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn("Email not sent: SendGrid is not configured (set SENDGRID_API_KEY and SENDGRID_FROM_EMAIL).");
    }
    return { ok: true, skipped: true };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const content = [{ type: "text/plain", value: message.text || message.subject }];
    if (message.html) content.push({ type: "text/html", value: message.html });
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        // One personalization per recipient so addresses are never exposed to each other.
        personalizations: unique.map((address) => ({ to: [{ email: address }] })),
        from: { email: process.env.SENDGRID_FROM_EMAIL, name: process.env.SENDGRID_FROM_NAME || "ReplyOS" },
        ...(replyTo ? { reply_to: { email: replyTo } } : {}),
        subject: message.subject,
        content,
        ...(category ? { categories: [String(category).slice(0, 40)] } : {}),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`SendGrid rejected an email (${response.status}): ${body.slice(0, 300)}`);
      return { ok: false, error: `SendGrid returned ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    console.error("SendGrid request failed:", error.message);
    return { ok: false, error: error.message };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { send, renderEmail, escapeHtml, appUrl, isConfigured, outbox };
