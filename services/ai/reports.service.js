const db = require("../../config/db.config");
const llm = require("./llm.service");
const { bad, text, page } = require("./context");

const STALE_MINUTES = 15;
const MIN_TRANSCRIPT = 1000;
const MAX_TRANSCRIPT = 300000;
const MODEL_CHARS = 90000;

const KINDS = {
  market_research: {
    label: "Market research report",
    fields: { background: 4000, skills: 3000, interests: 3000, connections: 3000, problems: 4000, constraints: 3000 },
    required: "Fill in at least a few of the fields so the research has something to work from.",
    guide: [
      "Recommend 3 to 5 niches this person could serve, best fit first.",
      "Sections to include, in this order: \"Summary\" (what stands out), then one section per niche (heading is the niche name; body says why it fits THIS person's background and what the buyer's problem is; bullets cover: who exactly buys, typical pains, an offer angle, first three steps), then \"Best first pick\" (which one to start with and why), then \"Risks and what to verify\".",
      "Market size, pricing and competition are estimates from general knowledge: say \"roughly\" and list what the person should verify. Never give exact statistics or cite sources you can't name.",
    ],
  },
  offer: {
    label: "Offer",
    fields: { results: 4000, skills: 3000, processes: 3000, industry: 3000 },
    required: "Share some of your results, skills, processes or industry knowledge first.",
    guide: [
      "Write ONE clear offer the person can put in front of a buyer.",
      "Sections, in order: \"Offer summary\" (one-line name and one-sentence promise), \"Who it's for\", \"The problem\", \"What's included\" (bullets, concrete deliverables), \"How it works\" (bullets, steps), \"Proof to use\" (only results the person actually gave; if none, say what proof to collect), \"Pricing options\" (2-3 tiers as bullets, with a reasoning line; label them suggestions), \"Guarantee idea\", \"Objections and answers\" (bullets), \"Call to action\".",
      "Use ONLY results and numbers the person provided. Do not invent clients, figures or case studies.",
    ],
  },
  growth_plan: {
    label: "Growth plan",
    fields: { prospectName: 200, prospectCompany: 200, prospectEmail: 320, industry: 200, goals: 4000, currentSituation: 4000, challenges: 4000, offer: 3000, budget: 400, timeline: 400, notes: 4000 },
    required: "Add at least the goals or the challenges so the plan has a target.",
    guide: [
      "Write a growth plan for the prospect company, from the point of view of the user's team.",
      "Sections, in order: \"Where they are today\", \"Goal\", \"Strategy\" (2-4 channels or levers with a line each on why), \"First 30 days\", \"Days 31-60\", \"Days 61-90\" (bullets of concrete actions), \"What we'd measure\" (KPIs, bullets), \"Investment and expected effort\" (use the budget given; say if none was given), \"Risks and assumptions\".",
      "The plan is about the PROSPECT's business. Their market, customers and situation come only from the input above. Never present the user's own company, customers or market as the prospect's.",
      "Use only what the input says. Where you must assume something, start the line with \"Assumption:\". No invented revenue numbers or guaranteed outcomes.",
    ],
  },
};

const mapReport = (r, { full = false } = {}) => ({
  id: Number(r.id), kind: r.kind, title: r.title, status: r.status, error: r.error,
  prospectName: r.input?.prospectName || null, prospectCompany: r.input?.prospectCompany || null,
  createdBy: r.created_by || null, createdByEmail: r.created_by_email || null, createdAt: r.created_at, completedAt: r.completed_at, model: r.model,
  ...(full ? { input: r.input, output: r.output } : {}),
});
const SELECT = `SELECT a.*, NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') AS created_by, u.email AS created_by_email FROM ai_reports a LEFT JOIN users u ON u.id = a.user_id`;

function cleanInput(kind, body) {
  const spec = KINDS[kind];
  const input = {};
  for (const [key, max] of Object.entries(spec.fields)) {
    const value = text(body[key], max + 1);
    if (value.length > max) throw bad(`"${key}" is too long (max ${max.toLocaleString()} characters).`);
    if (value) input[key] = value;
  }
  if (kind === "offer" && body.transcript) {
    const transcript = text(body.transcript, MAX_TRANSCRIPT + 1);
    if (transcript.length < MIN_TRANSCRIPT) throw bad(`The transcript is too short (at least ${MIN_TRANSCRIPT.toLocaleString()} characters).`);
    if (transcript.length > MAX_TRANSCRIPT) throw bad(`Transcripts can be up to ${MAX_TRANSCRIPT.toLocaleString()} characters.`);
    input.transcript = transcript;
  }
  if (kind === "growth_plan" && input.prospectEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.prospectEmail)) throw bad("Enter a valid prospect email, or leave it empty.");
  const chars = Object.entries(input).filter(([k]) => !k.startsWith("prospect")).reduce((n, [, v]) => n + v.length, 0);
  if (chars < 20 || (kind === "growth_plan" && !input.goals && !input.challenges)) throw bad(spec.required);
  return input;
}

function buildPrompt(kind, input) {
  const spec = KINDS[kind];
  const facts = Object.entries(input).filter(([k]) => k !== "transcript").map(([k, v]) => `${k}: ${v}`).join("\n");
  const transcript = input.transcript ? `\n=== TRANSCRIPT OF A CALL (the source for this offer) ===\n${input.transcript.length > MODEL_CHARS ? `${input.transcript.slice(0, MODEL_CHARS)}\n[transcript shortened]` : input.transcript}` : "";
  // The workspace Brain is deliberately not included: with it the model wrote the user's own business into reports about someone else's
  // (or about what the form said), so every report uses only what was entered here.
  return [
    `You are an experienced go-to-market consultant producing a ${spec.label.toLowerCase()} for a small service business or agency.`,
    `=== WHAT THE USER PROVIDED ===\n${facts || "(see transcript)"}${transcript}`,
    ["=== HOW TO WRITE IT ===", ...spec.guide.map((g) => `- ${g}`), "- Plain, specific language. No hype, no filler, no emojis. Short bodies (1-3 sentences) and bullets that each carry one concrete idea."].join("\n"),
    `=== OUTPUT ===\nReturn ONLY JSON: {"title":"short report title","sections":[{"heading":"...","body":"optional short paragraph","bullets":["optional","list"]}]}`,
  ].filter(Boolean).join("\n\n");
}

function shapeOutput(raw) {
  const sections = (Array.isArray(raw.sections) ? raw.sections : []).map((s) => ({
    heading: text(s?.heading, 140),
    body: text(s?.body, 2000),
    bullets: (Array.isArray(s?.bullets) ? s.bullets : []).map((b) => text(b, 500)).filter(Boolean).slice(0, 12),
  })).filter((s) => s.heading && (s.body || s.bullets.length)).slice(0, 16);
  if (sections.length < 2) throw new Error("The report came back empty.");
  return { title: text(raw.title, 160), sections };
}

async function create(workspaceId, userId, kind, body) {
  if (!KINDS[kind]) throw bad("Unknown report type.", 404);
  const input = cleanInput(kind, body || {});
  const who = input.prospectCompany || input.prospectName;
  const title = kind === "growth_plan" ? (who ? `Growth plan for ${who}` : "Growth plan") : KINDS[kind].label;
  const { rows } = await db.query(`INSERT INTO ai_reports (workspace_id, user_id, kind, title, input) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id`, [workspaceId, userId, kind, title, JSON.stringify(input)]);
  const id = Number(rows[0].id);
  setImmediate(() => generate(id).catch((error) => console.error("Report generation crashed:", error)));
  return get(workspaceId, kind, id);
}

const running = new Set();
async function generate(id) {
  if (running.has(id)) return;
  running.add(id);
  try {
    const { rows } = await db.query(`SELECT * FROM ai_reports WHERE id = $1 AND status = 'processing'`, [id]);
    const row = rows[0];
    if (!row) return;
    try {
      const system = buildPrompt(row.kind, row.input);
      const { json, model } = await llm.completeJson({ workspaceId: row.workspace_id, system, messages: [{ role: "user", content: "Write the report now." }], action: row.kind, maxTokens: 6000 });
      const output = shapeOutput(json);
      await db.query(`UPDATE ai_reports SET status = 'completed', output = $2::jsonb, title = COALESCE(NULLIF($3, ''), title), model = $4, error = NULL, completed_at = NOW() WHERE id = $1`, [id, JSON.stringify(output), kind3(row, output), model]);
    } catch (error) {
      await db.query(`UPDATE ai_reports SET status = 'failed', error = $2, completed_at = NOW() WHERE id = $1`, [id, text(error.message, 400)]);
    }
  } finally {
    running.delete(id);
  }
}
// Growth plan titles stay "Growth plan for <company>"; the other kinds take the model's title.
const kind3 = (row, output) => (row.kind === "growth_plan" ? "" : output.title);

async function list(workspaceId, kind, query = {}) {
  if (!KINDS[kind]) throw bad("Unknown report type.", 404);
  await db.query(`UPDATE ai_reports SET status = 'failed', error = 'The report was interrupted. Generate it again.', completed_at = NOW() WHERE workspace_id = $1 AND status = 'processing' AND started_at < NOW() - ($2 || ' minutes')::interval`, [workspaceId, String(STALE_MINUTES)]);
  const { page: pg, limit } = page(query, 20);
  const params = [workspaceId, kind];
  let clause = "a.workspace_id = $1 AND a.kind = $2";
  if (["processing", "completed", "failed"].includes(query.status)) { params.push(query.status); clause += ` AND a.status = $${params.length}`; }
  const total = Number((await db.query(`SELECT COUNT(*) AS n FROM ai_reports a WHERE ${clause}`, params)).rows[0].n);
  const rows = (await db.query(`${SELECT} WHERE ${clause} ORDER BY a.id DESC LIMIT ${limit} OFFSET ${(pg - 1) * limit}`, params)).rows;
  return { items: rows.map((r) => mapReport(r)), page: pg, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

async function get(workspaceId, kind, id) {
  if (!/^\d+$/.test(String(id))) throw bad("Report not found.", 404);
  const { rows } = await db.query(`${SELECT} WHERE a.id = $1 AND a.workspace_id = $2 AND a.kind = $3`, [id, workspaceId, kind]);
  if (!rows[0]) throw bad("Report not found.", 404);
  return mapReport(rows[0], { full: true });
}

async function retry(workspaceId, kind, id) {
  const report = await get(workspaceId, kind, id);
  if (report.status === "processing") throw bad("This report is already being generated.", 409);
  await db.query(`UPDATE ai_reports SET status = 'processing', error = NULL, output = NULL, completed_at = NULL, started_at = NOW() WHERE id = $1`, [report.id]);
  setImmediate(() => generate(report.id).catch((error) => console.error("Report generation crashed:", error)));
  return get(workspaceId, kind, id);
}

async function remove(workspaceId, kind, id) {
  const report = await get(workspaceId, kind, id);
  await db.query(`DELETE FROM ai_reports WHERE id = $1`, [report.id]);
  return { deleted: true };
}

/** Reads a call transcript and fills in the growth plan form. Only facts the transcript supports are returned. */
async function prefillGrowthPlan(workspaceId, transcriptRaw) {
  const transcript = text(transcriptRaw, MAX_TRANSCRIPT + 1);
  if (transcript.length < MIN_TRANSCRIPT) throw bad(`The transcript is too short (at least ${MIN_TRANSCRIPT.toLocaleString()} characters).`);
  if (transcript.length > MAX_TRANSCRIPT) throw bad(`Transcripts can be up to ${MAX_TRANSCRIPT.toLocaleString()} characters.`);
  if (!/^[^:\n]{1,40}:\s*\S/m.test(transcript)) throw bad("Add speaker labels such as \"Speaker 1:\", \"John:\" or \"Prospect:\".");
  const keys = Object.keys(KINDS.growth_plan.fields);
  const system = [
    "You read a discovery call transcript and extract the details needed for a growth plan.",
    `Return ONLY JSON with these string keys (use "" when the call doesn't say): ${keys.join(", ")}.`,
    "Rules: use only what the call states. Never guess an email address or a budget. Keep each value under 600 characters, in the prospect's own terms. \"goals\" are what they want to achieve, \"currentSituation\" is how things work today, \"challenges\" are what's in the way, \"offer\" is what the user's team would sell them, if discussed.",
  ].join("\n");
  const { json } = await llm.completeJson({ workspaceId, system, messages: [{ role: "user", content: `TRANSCRIPT:\n${transcript.slice(0, MODEL_CHARS)}` }], action: "growth_plan_prefill", maxTokens: 2000 });
  const fields = {};
  for (const key of keys) fields[key] = text(json[key], KINDS.growth_plan.fields[key]);
  // An email the call never mentioned would be a hallucination.
  if (fields.prospectEmail && !transcript.toLowerCase().includes(fields.prospectEmail.toLowerCase())) fields.prospectEmail = "";
  return { fields, filled: keys.filter((k) => fields[k]).length };
}

module.exports = { KINDS, create, generate, list, get, retry, remove, prefillGrowthPlan, shapeOutput, cleanInput };
