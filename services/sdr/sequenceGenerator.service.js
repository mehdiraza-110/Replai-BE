const settingsService = require("./settings.service");
const agent = require("./agent.service");

/** The merge variables the send engine fills in. Anything else would be sent as literal text, so the engine refuses to send it. */
const ALLOWED = new Set(["firstName", "lastName", "fullName", "company", "role", "email", "senderName"]);
const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;
const MAX_STEPS = 5;
const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function buildPrompt({ brain, knowledgeBase, name, audience, steps }) {
  const facts = [
    brain.companyName && `Company: ${brain.companyName}`,
    brain.website && `Website: ${brain.website}`,
    brain.whoYouSellTo && `Who we sell to: ${brain.whoYouSellTo}`,
    brain.whatYouSell && `What we sell: ${brain.whatYouSell}`,
    brain.senderTitle && `Sender title: ${brain.senderTitle}`,
  ].filter(Boolean);
  return [
    `You write cold email sequences for ${brain.companyName || "the sender's company"}. Campaign name: "${name}".`,
    audience ? `Audience for this campaign: ${audience}` : "",
    facts.length ? `=== BUSINESS FACTS ===\n${facts.join("\n")}` : "",
    String(knowledgeBase || "").trim() ? `=== KNOWLEDGE BASE (the only other source of facts) ===\n${knowledgeBase.trim()}` : "",
    [
      "=== RULES ===",
      "- Use only facts from the sources above. Never invent clients, results, numbers, case studies or claims. If there are few facts, write less and stay general.",
      `- Write ${steps} emails: one first email, then ${steps - 1} follow-up${steps > 2 ? "s" : ""}.`,
      "- These emails go out from several inboxes with different sender names. Write as \"we\" for the company; NEVER say \"I\" about who the sender is, what they personally do or who runs calls (say \"our owner\" or \"we\" instead). The only first-person singular allowed is ordinary phrasing like \"I wanted to share\".",
      "- State only what the sources literally say, paraphrased closely. Add NO promises or praise about quality, results or service level. Never use words like best, guarantee, seamless, efficient, top-notch, trusted, proven, or leading.",
      "- Plain text only: no markdown, no bullet lists, no emojis, no exclamation marks. Each email under 90 words. Warm, direct, specific, like one person writing to another.",
      "- The first email has a subject line of at most 7 words, no clickbait, no ALL CAPS. Follow-ups are short replies in the same thread and have no subject.",
      "- Each follow-up adds one new angle or fact; never repeat earlier wording and never guilt-trip.",
      "- End every email with a sign-off, then {{senderName}} on its own line.",
      "- The ONLY merge variables you may use are: {{firstName}}, {{lastName}}, {{fullName}}, {{company}}, {{role}}, {{senderName}}. Write them exactly like that. Open with 'Hi {{firstName}},'. Do not use any other {{...}} variable.",
      "- Do not mention opting out; an unsubscribe line is added automatically.",
    ].join("\n"),
    `=== OUTPUT ===\nReturn ONLY JSON: {"steps":[{"subject":"first email only","body":"email text with \\n for line breaks","delayDays":number of days after the previous email (0 for the first)}]}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Turns plain text into the paragraph HTML the campaign editor stores. */
function toHtml(text) {
  const esc = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text
    .split(/\n{2,}/)
    .map((block) => `<p>${esc(block.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** @returns {Array<{subject: string, body: string, delayDays: number}>} or throws when the output is unusable. */
function parseSteps(text, wanted) {
  const cleaned = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("not json");
  const raw = JSON.parse(cleaned.slice(start, end + 1));
  if (!Array.isArray(raw.steps) || raw.steps.length < 1) throw new Error("no steps");
  const steps = raw.steps.slice(0, wanted).map((step, index) => {
    const body = String(step?.body || "").trim();
    if (body.length < 20) throw new Error("empty body");
    for (const value of [body, String(step?.subject || "")]) {
      for (const [, key] of value.matchAll(PLACEHOLDER)) if (!ALLOWED.has(key)) throw new Error(`unknown variable ${key}`);
      if (/\{\{|\}\}/.test(value.replace(PLACEHOLDER, ""))) throw new Error("malformed braces");
    }
    const subject = String(step?.subject || "").trim().slice(0, 120);
    if (index === 0 && !subject) throw new Error("missing subject");
    const delay = Number.parseInt(step?.delayDays, 10);
    return { subject: index === 0 ? subject : "", body: toHtml(body), delayDays: index === 0 ? 0 : Math.min(Math.max(Number.isInteger(delay) ? delay : 3, 1), 30) };
  });
  return steps;
}

class SequenceGeneratorService {
  async generate(workspaceId, { name, audience = "", steps = 3 } = {}) {
    const title = String(name || "").trim().slice(0, 160);
    if (!title) throw bad("Give the campaign a name first.");
    const count = Math.min(Math.max(Number.parseInt(steps, 10) || 3, 1), MAX_STEPS);
    const all = await settingsService.getAll(workspaceId);
    if (!all.brain.companyName && !all.brain.whatYouSell && !all.settings.knowledgeBase.trim()) {
      throw bad("Add your company and what you sell in Settings → Brain first, so the AI has real facts to write from.");
    }
    const resolved = await agent.resolveProvider(workspaceId);
    if (!resolved) throw bad("The AI is not available for this workspace yet. Write the sequence yourself, or add an AI key.", 503);

    const { askModel } = require("../message.service").agentHelpers;
    const system = buildPrompt({ brain: all.brain, knowledgeBase: all.settings.knowledgeBase, name: title, audience: String(audience).trim().slice(0, 500), steps: count });
    // One retry: a malformed answer or an unknown placeholder must never reach the editor.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const text = await askModel({ workspace_id: workspaceId, agent_provider: resolved.provider, agent_model: resolved.model }, { system, user: "Write the sequence now.", action: "sequence" });
      try {
        return { steps: parseSteps(text, count), generatedBy: `${resolved.provider}:${resolved.model}` };
      } catch {
        /* try once more */
      }
    }
    throw bad("The AI could not write a usable sequence this time. Try again, or write it yourself.", 502);
  }
}

module.exports = new SequenceGeneratorService();
module.exports.parseSteps = parseSteps;
module.exports.toHtml = toHtml;
module.exports.ALLOWED = ALLOWED;
