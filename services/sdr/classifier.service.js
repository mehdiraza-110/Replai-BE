const suppressionService = require("../suppression.service");

/**
 * Deterministic first pass over an inbound reply: what happened (outcome), how interested the prospect is,
 * and whether a person needs to look. It needs no AI key, so the inbox is always labelled; when an AI key
 * exists the SDR agent refines this result (see agent.service.js), it never has to start from nothing.
 */

const AUTO_SUBJECT = /^\s*(automatic reply|auto[- ]?reply|autoreply|out of office|ooo\b|undeliverable|delivery (status|failure)|mail delivery)/i;
const OUT_OF_OFFICE = /(out of (the )?office|away from (the )?(office|desk)|on (annual |maternity |paternity )?leave|on vacation|on holiday|will (be )?(back|return)|returning on|limited access to (my )?e-?mail)/i;
const CONTACT_GONE = /(no longer (works|employed|with|available|at)|has left (the company|us)|is not (monitored|a valid)|mailbox (is )?(unmonitored|full))/i;
const DECLINE = /(not interested|no,? thanks?|no thank you|not a fit|not for us|we(?:'re| are) (all set|good|fine)|already (have|use|work with)|not looking|don'?t (need|want)|pass on this)/i;
const HOSTILE = /(\bspam\b|report(ing)? you|\blegal\b|lawyer|attorney|\bsue\b|harass|gdpr|cease and desist|how did you get my)/i;
const POSITIVE = /(interested|sounds (good|great|interesting)|let'?s (talk|chat|connect|schedule|do it|set)|happy to (chat|talk|connect|jump)|would love to|love to|send (me )?(over )?(more )?(info|information|details)|tell me more|learn more|how (much|does)|what(?:'s| is) the (price|cost)|\byes\b|\bsure\b|count me in|i'?m in|give me a call|call me)/i;
const MEETING = /(book|schedule|calendar|\bcall\b|meeting|\bchat\b|zoom|google meet|available|time (works|slot)|next week|tomorrow|this week|monday|tuesday|wednesday|thursday|friday|\d{1,2}(:\d{2})?\s?(am|pm))/i;

/** Removes the quoted earlier messages ("On Tue ... wrote:", "> ...") so only the new text is judged. */
function stripQuoted(text) {
  const lines = String(text || "").split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue;
    if (/^\s*On .{5,120}wrote:\s*$/i.test(line) || /^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line) || /^\s*From:\s.+@/i.test(line)) break;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

/**
 * @returns {{outcome: string, interest: string, intent: string, wantsMeeting: boolean, needsAttention: boolean, attentionReason: string|null, text: string}}
 */
function classify({ subject = "", body = "" } = {}) {
  const text = stripQuoted(body);
  const result = { outcome: "none", interest: "low", intent: "other", wantsMeeting: false, needsAttention: false, attentionReason: null, text };

  if (suppressionService.isOptOutText(text)) {
    return { ...result, outcome: "do_not_contact", interest: "none", intent: "unsubscribe" };
  }

  if (AUTO_SUBJECT.test(subject) || OUT_OF_OFFICE.test(text) || CONTACT_GONE.test(text)) {
    if (CONTACT_GONE.test(text)) {
      return { ...result, outcome: "auto_reply", intent: "auto_reply", needsAttention: true, attentionReason: "The contact has left the company; find a replacement contact." };
    }
    return { ...result, outcome: AUTO_SUBJECT.test(subject) && !OUT_OF_OFFICE.test(text) ? "auto_reply" : "out_of_office", interest: "none", intent: "out_of_office" };
  }

  if (HOSTILE.test(text)) {
    return { ...result, outcome: "escalated", intent: "complaint", needsAttention: true, attentionReason: "Complaint, legal or hostile wording; reply personally." };
  }

  if (DECLINE.test(text)) {
    return { ...result, outcome: "declined", interest: "low", intent: "not_interested" };
  }

  if (POSITIVE.test(text) && MEETING.test(text)) {
    return { ...result, interest: "very_high", intent: "meeting_request", wantsMeeting: true };
  }
  if (POSITIVE.test(text)) {
    return { ...result, interest: "high", intent: "interested" };
  }
  if (text.includes("?")) {
    return { ...result, interest: "medium", intent: "question" };
  }
  return result;
}

const INTEREST_RANK = { none: 0, low: 1, medium: 2, high: 3, very_high: 4 };

module.exports = { classify, stripQuoted, INTEREST_RANK };
