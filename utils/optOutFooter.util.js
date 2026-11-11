// The reply-based opt-out line. Replies containing it are detected by suppressionService.isOptOutText and the sender
// is suppressed. Whether it is appended is a workspace setting (Settings > Cold Email Agent), applied when the email
// is sent, so changing the setting affects campaigns that are already running.
const OPT_OUT_FOOTER = "\n\nIf you'd prefer not to hear from us again, just reply to this email with \"OPT OUT\" and we'll remove you from our list right away.";
const OPT_OUT_LANGUAGE_PATTERN = /opt[\s-]?out|unsubscribe|remove (you|me) from (this|our|your) (list|mailing list)/i;

/** Appends the footer unless the text already carries its own opt-out wording. */
function withOptOutFooter(body) {
  const text = String(body || "");
  if (OPT_OUT_LANGUAGE_PATTERN.test(text)) return text;
  return `${text}${OPT_OUT_FOOTER}`;
}

/** Campaigns created before the footer became a setting have it stored inside the body; this removes exactly that copy. */
function stripOptOutFooter(body) {
  const text = String(body || "");
  return text.endsWith(OPT_OUT_FOOTER) ? text.slice(0, -OPT_OUT_FOOTER.length) : text;
}

/** The body as it should go out for a workspace whose footer setting is `enabled`. */
function applyOptOutSetting(body, enabled) {
  const clean = stripOptOutFooter(body);
  return enabled ? withOptOutFooter(clean) : clean;
}

module.exports = { OPT_OUT_FOOTER, withOptOutFooter, stripOptOutFooter, applyOptOutSetting };
