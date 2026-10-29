// Verifies the AI Consultant chat, Sales Call Analyzer and report generators in the LOCAL sandbox.
// The model is replaced by a stub, so nothing leaves the machine. Run from the workspace root:
//   ./dev-local.sh node scripts/ai-modules-test.js
const BE = require("path").resolve(__dirname, "..");
const assert = require("assert");
const db = require(`${BE}/config/db.config`);
const llm = require(`${BE}/services/ai/llm.service`);
const chat = require(`${BE}/services/ai/chat.service`);
const calls = require(`${BE}/services/ai/callAnalyzer.service`);
const reports = require(`${BE}/services/ai/reports.service`);
const prefs = require(`${BE}/services/settings/preferences.service`);

let pass = 0, fail = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log("  PASS", name); }, (e) => { fail++; console.log("  FAIL", name, "->", e.message); });
const stamp = Date.now();
const mkWs = async (tag) => (await db.query(`INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id`, [`AI ${tag} ${stamp}`, `ai-${tag}-${stamp}`])).rows[0].id;
const mkUser = async (tag, ws) => {
  const id = (await db.query(`INSERT INTO users (first_name, last_name, email, password_hash) VALUES ($1, 'Tester', $2, 'x') RETURNING id`, [tag, `${tag}-${stamp}@ai.invalid`])).rows[0].id;
  await db.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'member')`, [ws, id]);
  return id;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label) { for (let i = 0; i < 60; i++) { const v = await fn(); if (v) return v; await sleep(50); } throw new Error(`timed out: ${label}`); }

const TRANSCRIPT = [
  "Host: Hi Kent, thanks for jumping on. Today I want to understand how your staffing firm finds new clients.",
  "Kent: Honestly we rely on referrals. It's feast or famine and we have no real outbound process at the moment.",
  "Host: Got it. What does a slow month cost you in revenue, roughly?",
  "Kent: A slow month means about thirty thousand less in placements. That hurts our cash flow a lot.",
  "Host: Understood. We run outbound for firms like yours. Would a short follow-up call next week work?",
  "Kent: Sure, send me something, though I worry about spam complaints from our domain.",
].join("\n");

// What the stub model says, by action. Tests replace `reply` per case.
let seen = [];
let reply = null;
llm.setTransport(async (req) => { seen.push(req); const r = await reply(req); if (r instanceof Error) throw r; return r; });
const chatReply = () => { reply = async () => "Here is **advice**."; };

const analysisJson = (over = {}) => JSON.stringify({
  summary: "A decent first call.",
  stages: [
    { name: "Intro", criteria: [{ name: "Rapport", score: 7, feedback: ["Warm opening."], examples: ["Hi Kent, thanks for jumping on."], improvement: "Host: Hi [Name]!" }, { name: "Agenda and frame", score: 99, feedback: ["Clear."], examples: ["I never said this exact sentence at all."], improvement: "" }] },
    { name: "Situation", criteria: [{ name: "Current process", score: 8, feedback: ["Good."], examples: ["What does a slow month cost you in revenue, roughly?"] }, { name: "Goals and priorities", score: 4 }] },
    { name: "Problem", criteria: [{ name: "Pain uncovered", score: 9 }, { name: "Impact quantified", score: 8 }] },
  ],
  marketingInsights: { painPoints: ["Feast or famine pipeline"], objections: ["Spam complaints"], buyingSignals: ["Asked to be sent something"], topics: ["Referrals"], quotes: ["We rely on referrals", "Kent said a completely made up line here"] },
  ...over,
});

(async () => {
  const ws = await mkWs("a"), other = await mkWs("b");
  const ann = await mkUser("Ann", ws), bob = await mkUser("Bob", ws), zed = await mkUser("Zed", other);

  console.log("\n[1] chat");
  let t1;
  await check("new chat stores both messages and a title; persona kept", async () => {
    chatReply();
    const r = await chat.send(ws, ann, { message: "  How do I price an agency retainer?  ", persona: "copywriter" });
    t1 = r.thread.id;
    assert.equal(r.thread.title, "How do I price an agency retainer?"); assert.equal(r.thread.persona, "copywriter");
    assert.equal(r.reply.content, "Here is **advice**."); assert.equal(r.reply.role, "assistant");
    assert.match(seen.at(-1).system, /copywriter/i);
  });
  await check("follow-up sends the earlier turns and keeps alternation", async () => {
    await chat.send(ws, ann, { threadId: t1, message: "And for a smaller client?" });
    const m = seen.at(-1).messages;
    assert.deepEqual(m.map((x) => x.role), ["user", "assistant", "user"]);
    assert.equal(m.at(-1).content, "And for a smaller client?");
  });
  await check("the business brain reaches the system prompt", async () => {
    await db.query(`INSERT INTO workspace_brain (workspace_id, company_name, what_you_sell) VALUES ($1,'Acme Staffing','Temp staffing') ON CONFLICT (workspace_id) DO UPDATE SET company_name = EXCLUDED.company_name, what_you_sell = EXCLUDED.what_you_sell`, [ws]);
    await chat.send(ws, ann, { threadId: t1, message: "Another one" });
    assert.match(seen.at(-1).system, /Acme Staffing/);
  });
  await check("empty and over-long messages are refused", async () => {
    await assert.rejects(() => chat.send(ws, ann, { message: "   " }), /message/i);
    await assert.rejects(() => chat.send(ws, ann, { message: "x".repeat(8001) }), /8,000/);
  });
  await check("a failed first message leaves no empty chat behind", async () => {
    const before = (await chat.listThreads(ws, ann)).threads.length;
    reply = async () => new Error("boom");
    await assert.rejects(() => chat.send(ws, ann, { message: "Will fail" }), (e) => e.code === "AI_CALL_FAILED" && e.statusCode === 503);
    assert.equal((await chat.listThreads(ws, ann)).threads.length, before); chatReply();
  });
  await check("chats are private to their owner and workspace", async () => {
    await assert.rejects(() => chat.getThread(ws, bob, t1), /not found/i);
    await assert.rejects(() => chat.getThread(other, zed, t1), /not found/i);
    await assert.rejects(() => chat.send(ws, bob, { threadId: t1, message: "hi" }), /not found/i);
    await assert.rejects(() => chat.deleteThread(ws, bob, t1), /not found/i);
    assert.equal((await chat.getThread(ws, ann, t1)).messages.length, 6);
  });
  await check("deleting a chat while its answer is being written gives a clear error, not a crash", async () => {
    const made = await chat.send(ws, ann, { message: "temp chat" });
    reply = async () => { await chat.deleteThread(ws, ann, made.thread.id); return "late answer"; };
    await assert.rejects(() => chat.send(ws, ann, { threadId: made.thread.id, message: "again" }), (e) => e.statusCode === 409 && /deleted/i.test(e.message));
    chatReply();
  });
  await check("each model call counts against the AI request limit", async () => {
    const n = Number((await db.query(`SELECT COUNT(*) AS n FROM workspace_usage_events WHERE workspace_id = $1 AND kind = 'ai_requests'`, [ws])).rows[0].n);
    assert.ok(n >= 3, `counted ${n}`);
  });
  await check("delete removes the chat and its messages", async () => {
    await chat.deleteThread(ws, ann, t1);
    assert.equal((await chat.listThreads(ws, ann)).threads.find((t) => t.id === t1), undefined);
    assert.equal(Number((await db.query(`SELECT COUNT(*) AS n FROM ai_chat_messages WHERE thread_id = $1`, [t1])).rows[0].n), 0);
  });

  console.log("\n[2] no AI configured");
  await check("without any key the user is told AI isn't set up (503), not a crash", async () => {
    llm.setTransport(null);
    await assert.rejects(() => chat.send(ws, ann, { message: "hello" }), (e) => e.code === "AI_NOT_CONFIGURED" && e.statusCode === 503);
    llm.setTransport(async (req) => { seen.push(req); const r = await reply(req); if (r instanceof Error) throw r; return r; });
  });

  console.log("\n[3] call analyzer");
  await check("input checks: type, length, speaker labels, email, date", async () => {
    await assert.rejects(() => calls.create(ws, ann, { type: "demo", transcript: TRANSCRIPT }), /call type/i);
    await assert.rejects(() => calls.create(ws, ann, { type: "discovery", transcript: "Host: hi" }), /at least 300/);
    await assert.rejects(() => calls.create(ws, ann, { type: "discovery", transcript: "word ".repeat(100) }), /speaker labels/i);
    await assert.rejects(() => calls.create(ws, ann, { type: "discovery", transcript: TRANSCRIPT, prospectEmail: "nope" }), /valid prospect email/i);
    await assert.rejects(() => calls.create(ws, ann, { type: "discovery", transcript: TRANSCRIPT, callDate: "13/09/2026" }), /YYYY-MM-DD/);
  });
  let c1;
  await check("analysis completes: stages pinned to the framework, scores clamped, missing parts scored 0", async () => {
    reply = async () => analysisJson();
    await prefs.updateWorkspaceSettings(ws, ann, { callAnalyzer: { language: "en-GB", frameworks: { discovery: "Always ask about budget." } } });
    const created = await calls.create(ws, ann, { type: "discovery", prospectName: "Kent Housler", company: "Personnel World", prospectEmail: "Kent@PersonnelWorld.com", callDate: "2026-09-14", transcript: TRANSCRIPT });
    assert.equal(created.status, "processing"); c1 = created.id;
    const done = await until(async () => { const c = await calls.get(ws, c1); return c.status !== "processing" && c; }, "analysis");
    assert.equal(done.status, "completed", done.error);
    const names = done.result.stages.map((s) => s.name);
    assert.deepEqual(names, ["Intro", "Situation", "Problem", "Fit", "Objections", "Next steps"]);
    const intro = done.result.stages[0];
    assert.equal(intro.criteria[1].score, 10, "99 is clamped to 10");
    assert.equal(intro.score, 8.5);
    const fit = done.result.stages[3];
    assert.equal(fit.score, 0); assert.ok(fit.criteria.every((c) => c.score === 0));
    assert.equal(done.result.stages[1].criteria[1].score, 4);
    assert.equal(done.totalScore, +(done.result.stages.reduce((a, s) => a + s.score, 0) / 6).toFixed(1));
    assert.equal(done.prospectEmail, "kent@personnelworld.com"); assert.equal(done.callDate, "2026-09-14");
  });
  await check("quotes are kept only when they appear in the transcript", async () => {
    const c = await calls.get(ws, c1);
    assert.deepEqual(c.result.stages[0].criteria[0].examples, ["Hi Kent, thanks for jumping on."]);
    assert.deepEqual(c.result.stages[0].criteria[1].examples, []);
    assert.deepEqual(c.result.marketingInsights.quotes, ["We rely on referrals"]);
    assert.deepEqual(c.result.marketingInsights.objections, ["Spam complaints"]);
  });
  await check("workspace framework text, language and brain reach the prompt", async () => {
    const sys = seen.filter((r) => r.action === "call_analysis").at(-1).system;
    assert.match(sys, /Always ask about budget/); assert.match(sys, /British/); assert.match(sys, /Acme Staffing/); assert.match(sys, /Rapport; Agenda and frame/);
  });
  await check("type cards need two finished calls before showing an average", async () => {
    let l = await calls.list(ws);
    let d = l.types.find((t) => t.type === "discovery");
    assert.equal(d.calls, 1); assert.equal(d.enough, false); assert.equal(d.average, null);
    const second = await calls.create(ws, ann, { type: "discovery", transcript: TRANSCRIPT });
    await until(async () => (await calls.get(ws, second.id)).status === "completed", "second");
    l = await calls.list(ws); d = l.types.find((t) => t.type === "discovery");
    assert.equal(d.calls, 2); assert.equal(d.enough, true); assert.equal(typeof d.average, "number");
    assert.equal(l.types.find((t) => t.type === "sales").calls, 0);
  });
  await check("a model failure marks the call failed with a reason; re-analyze can recover it", async () => {
    reply = async () => new Error("down");
    const f = await calls.create(ws, ann, { type: "sales", prospectName: "Zhanna", transcript: TRANSCRIPT });
    const failed = await until(async () => { const c = await calls.get(ws, f.id); return c.status === "failed" && c; }, "failed");
    assert.match(failed.error, /couldn't answer/i);
    reply = async () => analysisJson();
    const again = await calls.reanalyze(ws, f.id);
    assert.equal(again.status, "processing");
    const ok = await until(async () => { const c = await calls.get(ws, f.id); return c.status === "completed" && c; }, "recovered");
    assert.equal(ok.result.stages[0].name, "Opening");
    await assert.rejects(() => calls.reanalyze(ws, "x1"), /not found/i);
  });
  await check("unreadable model output fails cleanly after one retry", async () => {
    reply = async () => "I think the call went well!";
    const before = seen.length;
    const f = await calls.create(ws, ann, { type: "podcast", transcript: TRANSCRIPT });
    const failed = await until(async () => { const c = await calls.get(ws, f.id); return c.status === "failed" && c; }, "unreadable");
    assert.match(failed.error, /couldn't read/i); assert.equal(seen.length - before, 2);
  });
  await check("filters: type, status, search; pagination", async () => {
    assert.ok((await calls.list(ws, { type: "sales" })).items.every((c) => c.type === "sales"));
    assert.ok((await calls.list(ws, { status: "failed" })).items.every((c) => c.status === "failed"));
    assert.equal((await calls.list(ws, { search: "kent" })).items.length, 1);
    const p = await calls.list(ws, { limit: 2 });
    assert.equal(p.items.length, 2); assert.ok(p.totalPages >= 2);
  });
  await check("a call stuck processing for a long time is shown as failed", async () => {
    const id = (await db.query(`INSERT INTO call_analyses (workspace_id, user_id, call_type, transcript, status, started_at) VALUES ($1,$2,'discovery',$3,'processing', NOW() - INTERVAL '2 hours') RETURNING id`, [ws, ann, TRANSCRIPT])).rows[0].id;
    await calls.list(ws);
    assert.equal((await calls.get(ws, id)).status, "failed");
  });
  await check("calls are workspace-private; delete works", async () => {
    await assert.rejects(() => calls.get(other, c1), /not found/i);
    await assert.rejects(() => calls.remove(other, c1), /not found/i);
    assert.equal((await calls.list(other)).total, 0);
    await calls.remove(ws, c1);
    await assert.rejects(() => calls.get(ws, c1), /not found/i);
  });
  await check("shapeResult tolerates a model that returns junk shapes", async () => {
    const r = calls.shapeResult({ stages: "nope", marketingInsights: null }, "podcast", TRANSCRIPT);
    assert.equal(r.stages.length, 4); assert.equal(r.totalScore, 0); assert.deepEqual(r.marketingInsights.quotes, []);
  });

  console.log("\n[4] reports");
  const report = (title = "T") => JSON.stringify({ title, sections: [{ heading: "Summary", body: "Short." }, { heading: "Niche: Legal", bullets: ["a", "b"] }, { heading: "", body: "dropped" }] });
  await check("input checks for each report type", async () => {
    await assert.rejects(() => reports.create(ws, ann, "market_research", {}), /few of the fields/i);
    await assert.rejects(() => reports.create(ws, ann, "offer", { results: "hi" }), /results, skills/i);
    await assert.rejects(() => reports.create(ws, ann, "growth_plan", { prospectCompany: "Acme", notes: "just notes here, plenty long" }), /goals or the challenges/i);
    await assert.rejects(() => reports.create(ws, ann, "growth_plan", { goals: "Grow revenue to a million", prospectEmail: "bad" }), /valid prospect email/i);
    await assert.rejects(() => reports.create(ws, ann, "offer", { transcript: "short" }), /too short/i);
    await assert.rejects(() => reports.create(ws, ann, "bogus", { goals: "x".repeat(40) }), /Unknown/);
    await assert.rejects(() => reports.create(ws, ann, "market_research", { background: "x".repeat(4001) }), /too long/);
  });
  let m1, o1, g1;
  await check("market research completes; empty sections are dropped; model title kept", async () => {
    reply = async () => report("Niche report");
    const c = await reports.create(ws, ann, "market_research", { background: "10 years in HR and recruiting", skills: "Sales, hiring", problems: "Small firms can't hire" });
    m1 = c.id; assert.equal(c.status, "processing");
    const d = await until(async () => { const r = await reports.get(ws, "market_research", m1); return r.status !== "processing" && r; }, "mr");
    assert.equal(d.status, "completed", d.error); assert.equal(d.output.sections.length, 2); assert.equal(d.title, "Niche report");
    assert.match(seen.at(-1).system, /roughly/); assert.match(seen.at(-1).system, /10 years in HR/); assert.doesNotMatch(seen.at(-1).system, /Acme Staffing/, "the Brain must not steer a report");
  });
  await check("offer from a transcript completes and the transcript reaches the prompt", async () => {
    const c = await reports.create(ws, ann, "offer", { transcript: TRANSCRIPT.repeat(5) });
    o1 = c.id;
    const d = await until(async () => { const r = await reports.get(ws, "offer", o1); return r.status !== "processing" && r; }, "offer");
    assert.equal(d.status, "completed"); assert.match(seen.at(-1).system, /TRANSCRIPT OF A CALL/); assert.match(seen.at(-1).system, /Only results|ONLY results/);
  });
  await check("growth plan keeps its own title and records who asked", async () => {
    const c = await reports.create(ws, ann, "growth_plan", { prospectName: "Brian", prospectCompany: "Talbott Bookkeeping", goals: "Get ten new clients a month", challenges: "No outbound" });
    g1 = c.id;
    const d = await until(async () => { const r = await reports.get(ws, "growth_plan", g1); return r.status !== "processing" && r; }, "gp");
    assert.equal(d.title, "Growth plan for Talbott Bookkeeping"); assert.equal(d.createdBy, "Ann Tester"); assert.equal(d.prospectCompany, "Talbott Bookkeeping");
    assert.match(seen.at(-1).system, /Assumption:/);
    assert.doesNotMatch(seen.at(-1).system, /Acme Staffing/, "the user's own business must not leak into a plan about the prospect"); assert.match(seen.at(-1).system, /Never present the user's own company/);
    const named = await reports.create(ws, ann, "growth_plan", { prospectName: "Kent", goals: "Ten clients a quarter" });
    assert.equal(named.title, "Growth plan for Kent");
  });
  await check("a bad model answer fails the report; retry regenerates it", async () => {
    reply = async () => JSON.stringify({ title: "x", sections: [] });
    const c = await reports.create(ws, ann, "offer", { results: "Placed 40 candidates in a year", skills: "Recruiting" });
    const f = await until(async () => { const r = await reports.get(ws, "offer", c.id); return r.status === "failed" && r; }, "fail");
    assert.match(f.error, /empty/i);
    reply = async () => report();
    await reports.retry(ws, "offer", c.id);
    const ok = await until(async () => { const r = await reports.get(ws, "offer", c.id); return r.status === "completed" && r; }, "retry");
    assert.equal(ok.error, null);
    await assert.rejects(() => reports.get(ws, "growth_plan", c.id), /not found/i);
  });
  await check("history lists only that report type, newest first, filterable", async () => {
    const l = await reports.list(ws, "offer");
    assert.ok(l.items.every((r) => r.kind === "offer")); assert.ok(l.items[0].id > l.items.at(-1).id);
    assert.ok((await reports.list(ws, "offer", { status: "completed" })).items.every((r) => r.status === "completed"));
    assert.equal((await reports.list(other, "offer")).total, 0);
    assert.equal((await reports.list(ws, "growth_plan", { limit: 1 })).items.length, 1);
  });
  await check("reports are workspace-private; delete works", async () => {
    await assert.rejects(() => reports.get(other, "market_research", m1), /not found/i);
    await assert.rejects(() => reports.remove(other, "market_research", m1), /not found/i);
    await reports.remove(ws, "market_research", m1);
    await assert.rejects(() => reports.get(ws, "market_research", m1), /not found/i);
  });
  await check("growth plan prefill: needs a real transcript with speaker labels; invented emails are dropped", async () => {
    const long = TRANSCRIPT.repeat(5);
    await assert.rejects(() => reports.prefillGrowthPlan(ws, "short"), /too short/i);
    await assert.rejects(() => reports.prefillGrowthPlan(ws, "no labels here ".repeat(100)), /speaker labels/i);
    reply = async () => JSON.stringify({ prospectName: "Kent Housler", prospectCompany: "Personnel World", prospectEmail: "kent@invented.com", goals: "Steady outbound pipeline", challenges: "Feast or famine", budget: "" });
    const r = await reports.prefillGrowthPlan(ws, long);
    assert.equal(r.fields.prospectName, "Kent Housler"); assert.equal(r.fields.prospectEmail, ""); assert.equal(r.fields.budget, ""); assert.equal(r.filled, 4);
    reply = async () => JSON.stringify({ prospectEmail: "kent@personnelworld.com" });
    assert.equal((await reports.prefillGrowthPlan(ws, `${long}\nKent: mail me at kent@personnelworld.com`)).fields.prospectEmail, "kent@personnelworld.com");
  });

  // cleanup
  for (const w of [ws, other]) {
    await db.query(`DELETE FROM workspace_brain WHERE workspace_id = $1`, [w]);
    await db.query(`DELETE FROM workspace_usage_events WHERE workspace_id = $1`, [w]);
    await db.query(`DELETE FROM workspace_members WHERE workspace_id = $1`, [w]);
    await db.query(`DELETE FROM workspaces WHERE id = $1`, [w]);
  }
  await db.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${stamp}@ai.invalid`]);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
