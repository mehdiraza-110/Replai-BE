const db = require("../../config/db.config");
const llm = require("./llm.service");
const prefs = require("../settings/preferences.service");
const { brainContext, bad, text, page } = require("./context");

const MIN_CHARS = 300;
const MAX_CHARS = 300000;
const MODEL_CHARS = 90000;
const STALE_MINUTES = 15;

const FRAMEWORKS = {
  discovery: { label: "Discovery Call", stages: [
    ["Intro", ["Rapport", "Agenda and frame"]],
    ["Situation", ["Current process", "Goals and priorities"]],
    ["Problem", ["Pain uncovered", "Impact quantified"]],
    ["Fit", ["Relevance of the solution", "Value explained"]],
    ["Objections", ["Concerns surfaced", "Handling"]],
    ["Next steps", ["Clear next step", "Commitment"]],
  ] },
  sales: { label: "Sales Call", stages: [
    ["Opening", ["Rapport", "Agenda and frame"]],
    ["Qualification", ["Need confirmed", "Budget and authority"]],
    ["Pitch", ["Tied to their pain", "Proof used"]],
    ["Objections", ["Concerns surfaced", "Handling"]],
    ["Pricing", ["Value before price", "Options presented"]],
    ["Close", ["Asked for the decision", "Next step agreed"]],
  ] },
  interview: { label: "Interview Call", stages: [
    ["Intro", ["Rapport", "Purpose explained"]],
    ["Background", ["Open questions", "Active listening"]],
    ["Depth", ["Follow-up questions", "Specific examples drawn out"]],
    ["Close", ["Guest questions", "Next steps"]],
  ] },
  podcast: { label: "Podcast Call", stages: [
    ["Intro", ["Rapport", "Frame"]],
    ["Questions", ["Quality of questions", "Listening and follow-up"]],
    ["Transition", ["Smooth movement between topics", "Setting expectations"]],
    ["Close", ["Wrap-up", "Next steps"]],
  ] },
};
const TYPES = Object.keys(FRAMEWORKS);

const round1 = (n) => Math.round(n * 10) / 10;
const clamp = (n) => (Number.isFinite(Number(n)) ? Math.min(10, Math.max(0, round1(Number(n)))) : 0);
const norm = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function mapRow(r, { withTranscript = false } = {}) {
  const result = r.result || null;
  return {
    id: Number(r.id),
    submissionId: Number(r.id).toString(16).padStart(8, "0"),
    type: r.call_type,
    typeLabel: FRAMEWORKS[r.call_type]?.label || r.call_type,
    status: r.status,
    error: r.error,
    prospectName: r.prospect_name,
    prospectEmail: r.prospect_email,
    company: r.prospect_company,
    role: r.prospect_role,
    callDate: r.call_date_text || null,
    language: r.language,
    submittedBy: r.submitted_by || null,
    model: r.model,
    createdAt: r.created_at,
    completedAt: r.completed_at,
    totalScore: result ? result.totalScore : null,
    averageScore: result ? result.averageScore : null,
    hasInsights: Boolean(result?.marketingInsights),
    ...(withTranscript ? { transcript: r.transcript, result } : {}),
  };
}

const SELECT = `SELECT c.*, to_char(c.call_date, 'YYYY-MM-DD') AS call_date_text, NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') AS submitted_by FROM call_analyses c LEFT JOIN users u ON u.id = c.user_id`;

function buildPrompt({ type, language, custom, brain }) {
  const fw = FRAMEWORKS[type];
  const stages = fw.stages.map(([name, criteria]) => `- ${name}: ${criteria.join("; ")}`).join("\n");
  const spelling = { "en-GB": "British", "en-AU": "Australian" }[language] || "American";
  return [
    `You are a sales coach reviewing a recorded ${fw.label.toLowerCase()}. Score the HOST (the person running the call for the user's company), not the prospect.`,
    brain,
    `=== STAGES TO SCORE (score every stage and every criterion from 0 to 10) ===\n${stages}`,
    custom ? `=== THIS TEAM'S OWN EVALUATION FRAMEWORK (weigh these points too, in the relevant stages) ===\n${custom}` : "",
    [
      "=== RULES ===",
      "- Base every judgement only on the transcript. If a stage did not happen, score it 0 and say it was not covered.",
      "- \"examples\" must be EXACT quotes copied word for word from the transcript (max 3 per criterion, each under 200 characters). Never paraphrase or invent a quote. Use an empty list if there is none.",
      "- \"feedback\" is 1-3 short, specific observations. \"improvement\" is a short example of what the host could have said instead, written as dialogue; use [placeholders] for unknown names.",
      "- Score honestly. A mediocre call gets mediocre scores. Don't inflate.",
      `- Write in ${spelling} English.`,
      "- marketingInsights come from what the PROSPECT said: pain points, objections, buying signals, topics, and a few verbatim prospect quotes. Use empty lists if the prospect said little.",
    ].join("\n"),
    `=== OUTPUT ===\nReturn ONLY JSON: {"summary":"2-3 sentences","stages":[{"name":"stage name exactly as listed","criteria":[{"name":"criterion exactly as listed","score":0-10,"feedback":["..."],"examples":["verbatim quote"],"improvement":"..."}]}],"marketingInsights":{"painPoints":["..."],"objections":["..."],"buyingSignals":["..."],"topics":["..."],"quotes":["verbatim prospect quote"]}}`,
  ].filter(Boolean).join("\n\n");
}

/** Turns the model's JSON into the stored result: names pinned to the framework, scores clamped, quotes checked against the transcript. */
function shapeResult(raw, type, transcript) {
  const haystack = norm(transcript);
  const verbatim = (list) => (Array.isArray(list) ? list : []).map((q) => String(q || "").trim()).filter((q) => q.length > 5 && haystack.includes(norm(q))).slice(0, 3);
  const strings = (list, n) => (Array.isArray(list) ? list : []).map((s) => text(s, 300)).filter(Boolean).slice(0, n);
  const given = Array.isArray(raw.stages) ? raw.stages : [];
  const stages = FRAMEWORKS[type].stages.map(([name, criteriaNames]) => {
    const found = given.find((s) => norm(s?.name) === norm(name));
    const foundCriteria = Array.isArray(found?.criteria) ? found.criteria : [];
    const criteria = criteriaNames.map((cname) => {
      const c = foundCriteria.find((x) => norm(x?.name) === norm(cname));
      return c
        ? { name: cname, score: clamp(c.score), feedback: strings(c.feedback, 3), examples: verbatim(c.examples), improvement: text(c.improvement, 700) }
        : { name: cname, score: 0, feedback: ["The model gave no assessment for this point."], examples: [], improvement: "" };
    });
    return { name, score: round1(criteria.reduce((a, c) => a + c.score, 0) / criteria.length), criteria };
  });
  const insights = raw.marketingInsights || {};
  const prospectQuotes = (Array.isArray(insights.quotes) ? insights.quotes : []).map((q) => String(q || "").trim()).filter((q) => q.length > 5 && haystack.includes(norm(q))).slice(0, 6);
  const allCriteria = stages.flatMap((s) => s.criteria);
  return {
    summary: text(raw.summary, 1200),
    stages,
    totalScore: round1(stages.reduce((a, s) => a + s.score, 0) / stages.length),
    averageScore: round1(allCriteria.reduce((a, c) => a + c.score, 0) / allCriteria.length),
    marketingInsights: {
      painPoints: strings(insights.painPoints, 8), objections: strings(insights.objections, 8),
      buyingSignals: strings(insights.buyingSignals, 8), topics: strings(insights.topics, 10), quotes: prospectQuotes,
    },
  };
}

async function create(workspaceId, userId, body) {
  const type = String(body.type || "");
  if (!TYPES.includes(type)) throw bad("Pick a call type: discovery, sales, interview or podcast.");
  const transcript = text(body.transcript, MAX_CHARS + 1);
  if (transcript.length < MIN_CHARS) throw bad(`Paste the full transcript (at least ${MIN_CHARS} characters). Short snippets can't be scored fairly.`);
  if (transcript.length > MAX_CHARS) throw bad(`Transcripts can be up to ${MAX_CHARS.toLocaleString()} characters.`);
  if (!/^[^:\n]{1,40}:\s*\S/m.test(transcript)) throw bad("Add speaker labels so we can tell who is talking, for example \"Host:\" and \"Prospect:\".");
  const email = text(body.prospectEmail, 320).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad("Enter a valid prospect email, or leave it empty.");
  let callDate = text(body.callDate, 10) || null;
  if (callDate && (!/^\d{4}-\d{2}-\d{2}$/.test(callDate) || Number.isNaN(Date.parse(callDate)))) throw bad("Enter the call date as YYYY-MM-DD.");
  const settings = await prefs.getWorkspaceSettings(workspaceId);
  const { rows } = await db.query(
    `INSERT INTO call_analyses (workspace_id, user_id, call_type, prospect_name, prospect_email, prospect_company, prospect_role, call_date, transcript, language)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [workspaceId, userId, type, text(body.prospectName, 160) || null, email || null, text(body.company, 200) || null, text(body.role, 160) || null, callDate, transcript, settings.callAnalyzer.language]
  );
  const id = Number(rows[0].id);
  runInBackground(id);
  return get(workspaceId, id);
}

const running = new Set();
function runInBackground(id) {
  setImmediate(() => analyze(id).catch((error) => console.error("Call analysis crashed:", error)));
}

/** Runs the analysis for one stored call and records the outcome. Safe to call twice: the second call is a no-op. */
async function analyze(id) {
  if (running.has(id)) return;
  running.add(id);
  try {
    const { rows } = await db.query(`SELECT * FROM call_analyses WHERE id = $1 AND status = 'processing'`, [id]);
    const row = rows[0];
    if (!row) return;
    try {
      const settings = await prefs.getWorkspaceSettings(row.workspace_id);
      const transcript = row.transcript.length > MODEL_CHARS ? `${row.transcript.slice(0, MODEL_CHARS)}\n[transcript shortened]` : row.transcript;
      const system = buildPrompt({ type: row.call_type, language: row.language, custom: settings.callAnalyzer.frameworks?.[row.call_type] || "", brain: await brainContext(row.workspace_id) });
      const { json, model } = await llm.completeJson({ workspaceId: row.workspace_id, system, messages: [{ role: "user", content: `TRANSCRIPT:\n${transcript}` }], action: "call_analysis", maxTokens: 8000 });
      const result = shapeResult(json, row.call_type, row.transcript);
      await db.query(`UPDATE call_analyses SET status = 'completed', result = $2::jsonb, model = $3, error = NULL, completed_at = NOW() WHERE id = $1`, [id, JSON.stringify(result), model]);
    } catch (error) {
      await db.query(`UPDATE call_analyses SET status = 'failed', error = $2, completed_at = NOW() WHERE id = $1`, [id, text(error.message, 400)]);
    }
  } finally {
    running.delete(id);
  }
}

async function failStale(workspaceId) {
  await db.query(`UPDATE call_analyses SET status = 'failed', error = 'The analysis was interrupted. Re-analyze to try again.', completed_at = NOW() WHERE workspace_id = $1 AND status = 'processing' AND started_at < NOW() - ($2 || ' minutes')::interval`, [workspaceId, String(STALE_MINUTES)]);
}

async function list(workspaceId, query = {}) {
  await failStale(workspaceId);
  const { page: pg, limit } = page(query);
  const where = ["c.workspace_id = $1"];
  const params = [workspaceId];
  if (TYPES.includes(query.type)) { params.push(query.type); where.push(`c.call_type = $${params.length}`); }
  if (["processing", "completed", "failed"].includes(query.status)) { params.push(query.status); where.push(`c.status = $${params.length}`); }
  if (query.search) { params.push(`%${String(query.search).trim().slice(0, 80)}%`); where.push(`(c.prospect_name ILIKE $${params.length} OR c.prospect_company ILIKE $${params.length} OR c.prospect_email ILIKE $${params.length})`); }
  const clause = where.join(" AND ");
  const total = Number((await db.query(`SELECT COUNT(*) AS n FROM call_analyses c WHERE ${clause}`, params)).rows[0].n);
  const rows = (await db.query(`${SELECT} WHERE ${clause} ORDER BY c.id DESC LIMIT ${limit} OFFSET ${(pg - 1) * limit}`, params)).rows;
  return { items: rows.map((r) => mapRow(r)), page: pg, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)), types: await typeStats(workspaceId) };
}

/** Per-type summary cards. Averages need at least two finished calls of that type. */
async function typeStats(workspaceId) {
  const { rows } = await db.query(`SELECT call_type, (result->>'totalScore')::numeric AS score FROM call_analyses WHERE workspace_id = $1 AND status = 'completed' ORDER BY id`, [workspaceId]);
  return TYPES.map((type) => {
    const scores = rows.filter((r) => r.call_type === type).map((r) => Number(r.score));
    return { type, label: FRAMEWORKS[type].label, calls: scores.length, enough: scores.length >= 2, average: scores.length >= 2 ? round1(scores.reduce((a, b) => a + b, 0) / scores.length) : null, latest: scores.length ? scores[scores.length - 1] : null };
  });
}

async function get(workspaceId, id) {
  if (!/^\d+$/.test(String(id))) throw bad("Call not found.", 404);
  const { rows } = await db.query(`${SELECT} WHERE c.id = $1 AND c.workspace_id = $2`, [id, workspaceId]);
  if (!rows[0]) throw bad("Call not found.", 404);
  return mapRow(rows[0], { withTranscript: true });
}

async function reanalyze(workspaceId, id) {
  const call = await get(workspaceId, id);
  if (call.status === "processing") throw bad("This call is already being analyzed.", 409);
  await db.query(`UPDATE call_analyses SET status = 'processing', error = NULL, result = NULL, completed_at = NULL, started_at = NOW() WHERE id = $1`, [call.id]);
  runInBackground(call.id);
  return get(workspaceId, id);
}

async function remove(workspaceId, id) {
  const call = await get(workspaceId, id);
  await db.query(`DELETE FROM call_analyses WHERE id = $1`, [call.id]);
  return { deleted: true };
}

module.exports = { FRAMEWORKS, TYPES, create, analyze, list, get, reanalyze, remove, shapeResult, buildPrompt };
