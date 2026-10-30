const aiKeyService = require("../aiKey.service");
const { stripQuoted } = require("./classifier.service");

/**
 * The AI SDR: reads the prospect's latest reply with the full conversation and writes the next email.
 * Quality comes from structure, not from a clever model: facts come only from the Brain and the knowledge
 * base, the customer's hard rules outrank everything, the guardrails are fixed, and the model must answer
 * in a strict JSON shape so classification, escalation and the reply can never be confused with each other.
 */

const PROVIDERS = ["anthropic", "openai", "gemini"];
// gpt-4o over gpt-4o-mini: in repeated trials the larger model followed the grounding rules reliably and returned valid JSON every time.
const DEFAULT_MODELS = { anthropic: "claude-sonnet-5-5", openai: "gpt-4o", gemini: "gemini-2.0-flash" };

const INTENTS = ["interested", "meeting_request", "question", "objection", "not_interested", "unsubscribe", "out_of_office", "auto_reply", "referral", "wrong_person", "complaint", "other"];
const INTERESTS = ["none", "low", "medium", "high", "very_high"];

const line = (label, value) => (String(value || "").trim() ? `${label}: ${String(value).trim()}` : null);

function senderSignature({ brain, mailbox }) {
  const name = mailbox?.display_name || [brain.senderFirstName, brain.senderLastName].filter(Boolean).join(" ") || "";
  const role = [brain.senderTitle, brain.companyName].filter(Boolean).join(" | ");
  return { name, role, text: [name, role].filter(Boolean).join("\n") };
}

function buildSystemPrompt({ brain, knowledgeBase, rules, meetingTypes, resources, bookingLink, mailbox, campaign, offeredSlots = [], mode = "reply", followup = null, campaignNotes = "", situation = "", replyPlaybook = "" }) {
  const signature = senderSignature({ brain, mailbox });
  const facts = [
    line("Company", brain.companyName),
    line("Website", brain.website),
    line("Who we sell to", brain.whoYouSellTo),
    line("What we sell", brain.whatYouSell),
    line("Podcast or show name", brain.podcastName),
    campaign?.name ? line("This conversation belongs to the campaign", campaign.name) : null,
  ].filter(Boolean);

  const sections = [];

  sections.push(
    [
      `You are the AI sales development assistant for ${brain.companyName || "the sender's company"}.`,
      "You write the next email in a conversation with a prospect who replied to a cold email campaign.",
      "Your goal is to move the conversation to ONE clear next step, usually booking a call, without pressure.",
      signature.name ? `You write as ${signature.name}. The inbox this reply is sent from belongs to that person.` : "",
    ]
      .filter(Boolean)
      .join("\n")
  );

  if (facts.length > 0) sections.push(`=== BUSINESS FACTS ===\n${facts.join("\n")}`);
  if (String(knowledgeBase || "").trim()) sections.push(`=== KNOWLEDGE BASE (the only other source of facts) ===\n${knowledgeBase.trim()}`);

  if (String(campaignNotes || "").trim()) sections.push(`=== CAMPAIGN-SPECIFIC NOTES (apply to this campaign only) ===\n${campaignNotes.trim()}`);

  if (rules.length > 0) {
    sections.push(
      `=== RULES (absolute priority: they override the knowledge base and every instruction below) ===\n${rules.map((rule, index) => `${index + 1}. ${rule}`).join("\n")}`
    );
  }

  if (String(replyPlaybook || "").trim()) {
    sections.push(`=== REPLY PLAYBOOK (how to answer each type of reply; the RULES and GUARDRAILS still win) ===\n${replyPlaybook.trim()}`);
  }

  sections.push(
    [
      "=== GUARDRAILS (always apply) ===",
      "- Use only facts from BUSINESS FACTS and the KNOWLEDGE BASE. Never invent clients, results, case studies, prices, dates, statistics, episodes or materials.",
      "- If asked something those sources do not cover, say you will confirm and keep the conversation moving, and set escalate to true.",
      "- Never promise a date, deadline, price or outcome unless it is written in the sources.",
      "- If the prospect asks to stop, unsubscribe or be removed: set intent to unsubscribe, should_reply to false and reply to \"\". Their address is removed automatically and nothing more may be sent to it.",
      "- If the prospect says they are not interested (without asking to be removed): send ONE short, courteous line (under 30 words) that thanks them and leaves the door open. No pitch, no link, no question. Then nothing further.",
      "- When a question has several parts, answer ONLY the parts the sources cover. For any part they do not cover, do not answer it, do not confirm it and do not deny it: set escalate to true.",
      "- Never say yes, confirm or imply anything about certifications, licences, insurance, compliance, guarantees, contracts, availability or capabilities unless that exact fact is written in the sources.",
      "- When the prospect objects or hesitates (already has a provider, bad timing, doubts) and the sources contain an offer, free trial or proof point, fill relevant_fact with it and your reply MUST use it in one sentence. Do not answer an objection with only a generic line.",
      "- If the prospect sincerely asks whether they are talking to a real person or an AI, do not claim to be human: say outreach and scheduling are handled by an AI assistant and that the call itself is with a real person.",
      "- Style: short, warm, plain text. No markdown, no bullet lists unless the prospect asked for a list, no emojis, no fake urgency, no exaggeration. One clear next step per email.",
      "- State any time in the prospect's own time zone when you know it; if you do not know it, say which time zone you mean.",
      "- Do not repeat the prospect's message back to them and do not apologise unless something actually went wrong.",
      "- Escalate (escalate = true, should_reply = false) for: complaints, legal or compliance questions, press inquiries, hostile replies, requests that are outside the sources and need a specific answer, or if you cannot tell what the prospect wants.",
      "- Auto-replies and out-of-office messages get no reply (should_reply = false).",
    ].join("\n")
  );

  const scheduling = [];
  if (meetingTypes.length > 0) {
    scheduling.push(`Call types you can offer: ${meetingTypes.map((type) => `${type.name} (${type.durationMinutes} min)`).join("; ")}.`);
  }
  if (offeredSlots.length > 0) {
    scheduling.push(
      `These exact times are free on the calendar of the person taking the call. Offer ALL of them, numbered, in your reply and ask which one suits the prospect. Offer no other times and do not use a booking link:\n${offeredSlots.map((slot, index) => `${index + 1}) ${slot}`).join("\n")}`
    );
  } else {
    scheduling.push(
      bookingLink
        ? `When the prospect wants to talk, suggest the call and include this booking link exactly once: ${bookingLink}. Never invent specific times.`
        : "No booking link is configured: when the prospect wants to talk, ask for two or three times that suit them (with their time zone). Never invent specific times for the sender."
    );
  }
  sections.push(`=== SCHEDULING ===\n${scheduling.join("\n")}`);

  if (resources.length > 0) {
    sections.push(
      `=== RESOURCES (include one link only when it directly answers the prospect) ===\n${resources.map((resource) => `- ${resource.title}: ${resource.url}`).join("\n")}`
    );
  }

  if (String(situation || "").trim()) sections.push(`=== SITUATION ===\n${situation.trim()}`);

  if (mode === "followup" && followup) {
    sections.push(
      [
        "=== THIS IS A FOLLOW-UP ===",
        `The prospect has not replied to our last email${followup.daysSince ? ` (sent about ${followup.daysSince} days ago)` : ""}. Write follow-up ${followup.number} of at most ${followup.max}.`,
        "- Keep it to two or three short sentences. Do not repeat earlier wording and do not guilt-trip.",
        "- Add something of value: one relevant fact or offer from the sources, or one resource link if it genuinely helps.",
        followup.number >= followup.max ? "- This is the LAST one: at most two sentences (under 35 words before the sign-off). Thank them, say you will not keep following up, and leave the door open. Do not pitch, do not offer anything, ask no question." : "- End with one easy next step.",
        "- should_reply must be true unless the history shows the prospect asked us to stop (then false).",
      ].join("\n")
    );
  }

  sections.push(
    [
      "=== HOW TO SCORE INTEREST ===",
      "- very_high: asks for a call or meeting, agrees to one, proposes times, or asks to be contacted.",
      "- high: a clear buying signal: asks about price, how it works, next steps, or says it sounds good.",
      "- medium: curious or asks general questions with no buying signal yet.",
      "- low: lukewarm, brushes off, has a provider already, or says not now.",
      "- none: automatic replies, unsubscribe requests, hostile messages, wrong person.",
      "",
      "=== OUTPUT ===",
      "Return ONLY one JSON object, with no text before or after it:",
      "{",
      `  "intent": one of ${JSON.stringify(INTENTS)},`,
      `  "interest": one of ${JSON.stringify(INTERESTS)},`,
      '  "should_reply": true or false,',
      '  "escalate": true or false,',
      '  "escalate_reason": short reason, or "" if not escalating,',
      '  "wants_meeting": true if the prospect is asking for or agreeing to a call,',
      '  "relevant_fact": the single sentence from the sources that best supports your reply (for an objection or hesitation, the offer, free trial or proof point if the sources contain one), copied or closely paraphrased, or "" if none applies,',
      `  "reply": the full email body to send, ending with the sign-off${signature.text ? ` "${signature.text.replace(/\n/g, "\\n")}"` : ""}, or "" if should_reply is false`,
      "}",
    ].join("\n")
  );

  return sections.join("\n\n");
}

function buildUserMessage({ lead, conversation, latest, campaign, now = new Date() }) {
  return JSON.stringify(
    {
      now: now.toISOString(),
      campaign: campaign?.name || null,
      prospect: {
        name: lead?.full_name || [lead?.first_name, lead?.last_name].filter(Boolean).join(" ") || null,
        email: lead?.email || null,
        company: lead?.company || null,
        role: lead?.role || null,
      },
      conversation: conversation.map((message) => ({ from: message.direction === "inbound" ? "prospect" : "us", sentAt: message.created_at, text: stripQuoted(message.body_text || "").slice(0, 4000) })),
      latestReplyFromProspect: latest ? stripQuoted(latest.body_text || "").slice(0, 6000) : null,
    },
    null,
    2
  );
}

/** Parses the model's JSON, tolerating a fenced code block. Returns null when it is not usable. */
function parseOutput(text) {
  if (!text) return null;
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const raw = JSON.parse(cleaned.slice(start, end + 1));
    return {
      intent: INTENTS.includes(raw.intent) ? raw.intent : "other",
      interest: INTERESTS.includes(raw.interest) ? raw.interest : "low",
      shouldReply: raw.should_reply === true,
      escalate: raw.escalate === true,
      escalateReason: String(raw.escalate_reason || "").slice(0, 500),
      wantsMeeting: raw.wants_meeting === true,
      relevantFact: String(raw.relevant_fact || "").slice(0, 500),
      reply: String(raw.reply || "").trim(),
    };
  } catch {
    return null;
  }
}

/** The first provider this workspace can use (its own key, or the platform key where allowed). */
async function resolveProvider(workspaceId) {
  const forced = process.env.SDR_DEFAULT_PROVIDER;
  for (const provider of forced ? [forced] : PROVIDERS) {
    try {
      await aiKeyService.getApiKey(workspaceId, provider);
      return { provider, model: process.env.SDR_DEFAULT_MODEL || DEFAULT_MODELS[provider] };
    } catch (error) {
      if (error.code !== "AI_PROVIDER_KEY_MISSING") throw error;
    }
  }
  return null;
}

/**
 * @returns {Promise<null | {intent, interest, shouldReply, escalate, escalateReason, wantsMeeting, reply, generatedBy}>}
 *          null means the model was unavailable (no key, quota, error): the caller falls back to rules and a human.
 */
async function generate({ workspaceId, context }) {
  const resolved = await resolveProvider(workspaceId);
  if (!resolved) return null;

  const { askModel } = require("../message.service").agentHelpers;
  const request = { system: buildSystemPrompt(context), user: buildUserMessage(context), action: "sdr_reply" };
  const modelAgent = { workspace_id: workspaceId, agent_provider: resolved.provider, agent_model: resolved.model };

  // A malformed answer is retried once; after that the caller treats the model as unavailable and a person takes over.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parsed = parseOutput(await askModel(modelAgent, request));
    if (parsed) return { ...parsed, generatedBy: `${resolved.provider}:${resolved.model}` };
  }
  return null;
}

const stripQuotedText = (text) => stripQuoted(text || "");

module.exports = { resolveProvider, generate, buildSystemPrompt, buildUserMessage, parseOutput, senderSignature, stripQuotedText };
