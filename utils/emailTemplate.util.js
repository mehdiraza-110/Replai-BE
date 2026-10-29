const crypto = require("crypto");

const HTML_TAG_RE = /<\/?(?:div|p|br|span|a|b|i|u|strong|em|ul|ol|li|h[1-6]|blockquote)\b[^>]*>/i;
const PLACEHOLDER_RE = /\{\{\s*(\w+)\s*\}\}/g;
const UNRESOLVED_RE = /\{\{[^}]*\}\}/;

/** The campaign editor stores rich text as HTML; imported/legacy campaigns are plain text. */
function isHtml(text) {
  return HTML_TAG_RE.test(String(text || ""));
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function decodeEntities(value) {
  return String(value)
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/gi, "&");
}

function htmlToText(html) {
  const text = String(html)
    .replace(/\r/g, "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(?:div|p|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Imported leads sometimes carry UTF-8 read as latin1 ("RenÃ¨e", "AifÂ®", emoji as "ð..."): undo it when it round-trips cleanly. */
function fixMojibake(value) {
  const text = String(value || "");
  if (!/[ÃÂâð]/.test(text) || [...text].some((ch) => ch.charCodeAt(0) > 255)) return text;
  const fixed = Buffer.from(text, "latin1").toString("utf8");
  return fixed.includes("\uFFFD") ? text : fixed;
}

function collapseSpaces(value) {
  return value.replace(/\s+/g, " ").trim();
}

/** Letters, marks, spaces and . ' - only: drops emoji, symbols (®), digits and stray control characters. */
function keepNameChars(value) {
  return collapseSpaces(value.replace(/\([^)]*\)/g, " ").replace(/[^\p{L}\p{M}\s.'-]/gu, " "));
}

/** "Michael A. Khalil, Cpa, Mbt" -> "Michael A. Khalil": credentials follow the first comma. */
function cleanFullName(value) {
  return keepNameChars(fixMojibake(value).split(",")[0]);
}

/** First usable given name: skips bare initials ("J.") and anything after a comma or second word. */
function cleanFirstName(value) {
  const tokens = cleanFullName(value).split(" ");
  const token = tokens.find((t) => t.replace(/[^\p{L}\p{M}]/gu, "").length >= 2);
  return token ? token.replace(/\.+$/, "") : "";
}

function cleanText(value) {
  const cleaned = fixMojibake(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufe00-\ufe0f\ufeff]/g, " ")
    .replace(/\p{Extended_Pictographic}/gu, " ")
    // a multibyte sequence cut off at the end of the value ("...1%â") can't be decoded: drop the stub
    .replace(/[ÃÂâð]\s*$/g, " ");
  return collapseSpaces(cleaned);
}

/** Company names are cut off mid-way in some imports ("Sasserath &"): drop dangling joiners. */
function cleanCompany(value) {
  return cleanText(value).replace(/[\s&,|\-]+$/g, "").trim();
}

/**
 * Every merge variable the campaign editor offers (snake_case) plus the camelCase names older campaigns use.
 * sender_name is the display name of the mailbox the email goes out from. Lead values are cleaned first.
 */
function mergeValues(lead, mailbox) {
  const fullName = cleanFullName(lead.full_name) || cleanFullName([lead.first_name, lead.last_name].filter(Boolean).join(" "));
  const firstName = cleanFirstName(lead.first_name) || cleanFirstName(lead.full_name) || "there";
  const lastName = cleanFullName(lead.last_name);
  const cleanedCompany = cleanCompany(lead.company);
  const company = cleanedCompany.replace(/[^\p{L}\p{N}]/gu, "").length >= 2 ? cleanedCompany : "";
  const role = cleanText(lead.role);
  const email = String(lead.email || "").trim();
  const senderName = (mailbox && (cleanText(mailbox.display_name) || String(mailbox.email || "").split("@")[0])) || "";
  return {
    first_name: firstName, firstName,
    last_name: lastName, lastName,
    full_name: fullName || firstName, fullName: fullName || firstName,
    company, role, email,
    sender_name: senderName, senderName,
  };
}

/** Fills {{variable}} placeholders. Unknown names are left in place so the caller can refuse to send them. */
function renderTemplate(text, lead, mailbox, { html = false } = {}) {
  const values = mergeValues(lead, mailbox);
  return String(text || "").replace(PLACEHOLDER_RE, (match, key) => {
    if (!(key in values)) return match;
    return html ? escapeHtml(values[key]) : values[key];
  });
}

function hasUnresolvedPlaceholders(text) {
  return UNRESOLVED_RE.test(String(text || ""));
}

function encodeSubject(subject) {
  const text = String(subject || "");
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

function base64Lines(text) {
  return Buffer.from(text, "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

/**
 * Plain bodies go out as text/plain exactly as before. When htmlBody is given the message is
 * multipart/alternative with `body` as the plain-text part and `htmlBody` as the HTML part.
 */
function buildRawMimeMessage({ from, to, subject, body, htmlBody = null, extraHeaders = {}, messageIdDomain = "replyos" }) {
  const messageId = `<${crypto.randomUUID()}@${messageIdDomain}>`;
  const headerLines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
  ];

  if (htmlBody) {
    const boundary = `=_${crypto.randomBytes(12).toString("hex")}`;
    headerLines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    headerLines.push(`Message-ID: ${messageId}`);
    headerLines.push(...Object.entries(extraHeaders).map(([key, value]) => `${key}: ${value}`));
    const parts = [
      `--${boundary}`,
      `Content-Type: text/plain; charset="UTF-8"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      base64Lines(body),
      `--${boundary}`,
      `Content-Type: text/html; charset="UTF-8"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      base64Lines(htmlBody),
      `--${boundary}--`,
      ``,
    ];
    return { raw: Buffer.from(`${headerLines.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`, "utf8"), messageId };
  }

  headerLines.push(`Content-Type: text/plain; charset="UTF-8"`);
  headerLines.push(`Content-Transfer-Encoding: 7bit`);
  headerLines.push(`Message-ID: ${messageId}`);
  headerLines.push(...Object.entries(extraHeaders).map(([key, value]) => `${key}: ${value}`));
  return { raw: Buffer.from(`${headerLines.join("\r\n")}\r\n\r\n${body}`, "utf8"), messageId };
}

/** Merge variables the template uses that have no value for this lead (last_name may legitimately be blank). */
function missingValues(templates, lead, mailbox) {
  const values = mergeValues(lead, mailbox);
  const missing = new Set();
  for (const template of templates) {
    for (const [, key] of String(template || "").matchAll(PLACEHOLDER_RE)) {
      if (key in values && values[key] === "" && key !== "last_name" && key !== "lastName") missing.add(key);
    }
  }
  return [...missing];
}

/**
 * Subject + body for one lead. HTML bodies are rendered with escaped values, newlines outside tags
 * (the opt-out footer is appended after a newline) become <br>, and a plain-text alternative is derived.
 * `missing` lists template variables this lead has no value for: the caller must not send in that case.
 */
function renderMessage({ subject, body }, lead, mailbox) {
  const renderedSubject = renderTemplate(subject, lead, mailbox);
  const missing = missingValues([subject, body], lead, mailbox);
  if (isHtml(body)) {
    const htmlBody = renderTemplate(body, lead, mailbox, { html: true }).replace(/\r?\n+/g, "<br>");
    return { subject: renderedSubject, text: htmlToText(htmlBody), html: htmlBody, missing };
  }
  return { subject: renderedSubject, text: renderTemplate(body, lead, mailbox), html: null, missing };
}

module.exports = {
  isHtml,
  htmlToText,
  mergeValues,
  renderTemplate,
  renderMessage,
  hasUnresolvedPlaceholders,
  buildRawMimeMessage,
};
