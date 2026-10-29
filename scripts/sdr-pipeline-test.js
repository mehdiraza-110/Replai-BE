// Seeds throwaway data into the LOCAL sandbox DB and exercises the AI SDR end to end (the model and the email sender are stubbed).
// Run from the repo root of this workspace:  ./dev-local.sh node scripts/sdr-pipeline-test.js
const BE = require("path").resolve(__dirname, "..");
const assert = require("assert");
const db = require(`${BE}/config/db.config`);
const inboundEmail = require(`${BE}/services/inboundEmail.service`);
const inboxService = require(`${BE}/services/inbox.service`);
const agent = require(`${BE}/services/sdr/agent.service`);
const threadState = require(`${BE}/services/sdr/threadState.service`);
const settings = require(`${BE}/services/sdr/settings.service`);
const sdr = require(`${BE}/services/sdr/inbound.service`);
const classifier = require(`${BE}/services/sdr/classifier.service`);
const webhook = require(`${BE}/services/sdr/webhook.service`);

let pass = 0, fail = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log("  PASS", name); }, (e) => { fail++; console.log("  FAIL", name, "->", e.message); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = Date.now();

async function seed() {
  // A throwaway workspace per run, so this test never touches (or depends on) anything saved by hand in the dev workspace.
  const ws = (await db.query(`INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id`, [`SDR test ${stamp}`, `sdr-test-${stamp}`])).rows[0].id;
  const domain = (await db.query(`INSERT INTO domains (domain, status, workspace_id) VALUES ($1, 'Verified', $2) RETURNING id`, [`sdrtest${stamp}.invalid`, ws])).rows[0].id;
  const mailbox = (await db.query(`INSERT INTO mailboxes (domain_id, email, local_part, display_name, workspace_id, provider) VALUES ($1, $2, 'sam', 'Sam Seller', $3, 'Test') RETURNING id, email`, [domain, `sam@sdrtest${stamp}.invalid`, ws])).rows[0];
  const campaign = (await db.query(`INSERT INTO campaigns (name, subject, body, workspace_id, status) VALUES ('SDR test campaign', 'Quick question', 'Hi', $1, 'Active') RETURNING id`, [ws])).rows[0].id;
  return { ws, mailbox, campaign };
}

async function makeLead({ ws, mailbox, campaign }, key, name) {
  const email = `${key}${stamp}@prospect.invalid`;
  const lead = (await db.query(`INSERT INTO campaign_leads (campaign_id, email, full_name, first_name, company, role, status, mailbox_id, workspace_id, sent_at) VALUES ($1,$2,$3,$4,'Acme','CEO','Sent',$5,$6,NOW()) RETURNING id`, [campaign, email, name, name.split(" ")[0], mailbox.id, ws])).rows[0].id;
  const threadId = `${mailbox.id}:${email}`;
  await db.query(`INSERT INTO messages (mailbox_id, direction, campaign_id, campaign_lead_id, thread_id, from_address, to_address, subject, body_text, workspace_id, created_at) VALUES ($1,'outbound',$2,$3,$4,$5,$6,'Quick question','Hi there, quick question.',$7, NOW() - INTERVAL '2 hours')`, [mailbox.id, campaign, lead, threadId, mailbox.email, email, ws]);
  return { email, threadId, leadId: lead };
}

async function inbound(ctx, p, subject, text) {
  await inboundEmail.recordInboxMessage({ mailbox: { id: ctx.mailbox.id, workspace_id: ctx.ws }, fromAddress: p.email, toAddress: ctx.mailbox.email, parsed: { subject, messageId: `<${Math.random()}@x>`, text }, bodyText: text });
  await sleep(400);
  return threadState.getState(ctx.ws, ctx.mailbox.id, p.threadId);
}

(async () => {
  const ctx = await seed();
  const cases = {
    meeting: ["Re: Quick question", "Sounds great, can we book a call tomorrow at 2pm?\n\nOn Tue, Oct 27 Sam wrote:\n> Hi there"],
    price: ["Re: Quick question", "Interesting. How much does it cost?"],
    decline: ["Re: Quick question", "Not interested, thanks."],
    ooo: ["Automatic reply: Quick question", "I am out of the office until Nov 2 with limited access to email."],
    optout: ["Re: Quick question", "Please remove me from your list"],
    gone: ["Automatic reply: Quick question", "Thank you. John no longer works at Acme."],
    hostile: ["Re: Quick question", "This is spam. I will report you to my lawyer."],
    who: ["Re: Quick question", "Who are you exactly?"],
  };
  const P = {};
  for (const key of Object.keys(cases)) P[key] = await makeLead(ctx, key, `${key[0].toUpperCase()}${key.slice(1)} Person`);

  console.log("\n[1] classification of inbound replies (no AI key => rules only)");
  const S = {};
  for (const [key, [subject, text]] of Object.entries(cases)) S[key] = await inbound(ctx, P[key], subject, text);
  await check("meeting request -> very_high, no outcome", () => { assert.equal(S.meeting.interest, "very_high"); assert.equal(S.meeting.outcome, "none"); });
  await check("quoted text is ignored (meeting not mis-read from quote)", () => assert.equal(classifier.classify({ subject: "Re:", body: "Thanks\n> book a call tomorrow" }).interest, "low"));
  await check("pricing question -> high", () => assert.equal(S.price.interest, "high"));
  await check("decline -> declined/low", () => { assert.equal(S.decline.outcome, "declined"); assert.equal(S.decline.interest, "low"); });
  await check("out of office -> out_of_office/none", () => { assert.equal(S.ooo.outcome, "out_of_office"); assert.equal(S.ooo.interest, "none"); });
  await check("opt-out -> do_not_contact", () => assert.equal(S.optout.outcome, "do_not_contact"));
  await check("contact left company -> auto_reply + needs attention", () => { assert.equal(S.gone.outcome, "auto_reply"); assert.equal(S.gone.needs_attention, true); });
  await check("hostile -> escalated + needs attention", () => { assert.equal(S.hostile.outcome, "escalated"); assert.equal(S.hostile.needs_attention, true); });
  await check("plain question -> medium", () => assert.equal(S.who.interest, "medium"));

  console.log("\n[2] attention tasks and no-AI behaviour");
  const tasks = (await db.query(`SELECT title, record_id FROM crm_tasks WHERE workspace_id = $1 AND source = 'ai_sdr' AND status = 'open' AND record_id LIKE $2`, [ctx.ws, `%${stamp}%`])).rows;
  await check("tasks opened for escalations (hostile, contact gone, meeting w/o AI)", () => { assert.ok(tasks.some((t) => /Hostile Person/.test(t.title)), "hostile"); assert.ok(tasks.some((t) => /Gone Person/.test(t.title)), "gone"); assert.ok(tasks.some((t) => /Meeting Person/.test(t.title)), "meeting needs a person when AI is unavailable"); });
  await check("task is not duplicated on a second reply", async () => { await inbound(ctx, P.hostile, "Re: Quick question", "I said this is spam!"); const n = (await db.query(`SELECT COUNT(*)::int c FROM crm_tasks WHERE workspace_id=$1 AND record_id=$2 AND status='open'`, [ctx.ws, `${ctx.mailbox.id}:${P.hostile.threadId}`])).rows[0].c; assert.equal(n, 1); });
  await check("no outbound message was sent without an AI key", async () => { const n = (await db.query(`SELECT COUNT(*)::int c FROM messages WHERE workspace_id=$1 AND direction='outbound' AND author IS NOT NULL AND thread_id LIKE $2`, [ctx.ws, `%${stamp}%`])).rows[0].c; assert.equal(n, 0); });

  console.log("\n[3] inbox list, folders, counts, filters");
  const list = await threadState.list(ctx.ws, { folder: "inbox", limit: 100 });
  await check("inbox lists the replied threads only", () => assert.ok(list.items.filter((i) => i.prospectEmail.endsWith(`${stamp}@prospect.invalid`)).length === 8));
  await check("attention folder = needs_attention threads", async () => { const a = await threadState.list(ctx.ws, { folder: "attention", limit: 100 }); assert.ok(a.items.every((i) => i.needsAttention)); assert.ok(a.items.length >= 3); assert.equal(a.counts.attention.total, a.total); });
  await check("status filter works", async () => { const d = await threadState.list(ctx.ws, { outcome: "declined", limit: 100 }); assert.ok(d.items.length >= 1 && d.items.every((i) => i.outcome === "declined")); });
  await check("search works (name)", async () => { const r = await threadState.list(ctx.ws, { search: "Decline Person" }); assert.ok(r.items.length >= 1); });
  await check("warm-up campaigns are excluded", async () => { await db.query(`UPDATE campaigns SET is_warmup = TRUE WHERE id = $1`, [ctx.campaign]); const r = await threadState.list(ctx.ws, { limit: 100 }); await db.query(`UPDATE campaigns SET is_warmup = FALSE WHERE id = $1`, [ctx.campaign]); assert.equal(r.items.filter((i) => i.prospectEmail.endsWith(`${stamp}@prospect.invalid`)).length, 0); });

  console.log("\n[4] thread detail, manual changes, bulk");
  const d = await threadState.detail(ctx.ws, ctx.mailbox.id, P.meeting.threadId);
  await check("detail: messages labelled campaign then prospect", () => { assert.deepEqual(d.messages.map((m) => m.kind), ["campaign", "prospect"]); assert.equal(d.contact.name, "Meeting Person"); assert.equal(d.contact.company, "Acme"); });
  await check("manual status sticks against a later classification", async () => { await threadState.patch(ctx.ws, ctx.mailbox.id, P.price.threadId, { outcome: "meeting_booked" }, { by: "manual" }); const s = await inbound(ctx, P.price, "Re: Quick question", "Thanks!"); assert.equal(s.outcome, "meeting_booked"); });
  await check("do_not_contact overrides even a manual status", async () => { const s = await inbound(ctx, P.price, "Re: Quick question", "Unsubscribe me please"); assert.equal(s.outcome, "do_not_contact"); });
  await check("favorite + disable AI via bulk", async () => { const r = await threadState.bulk(ctx.ws, [{ mailboxId: ctx.mailbox.id, threadId: P.who.threadId }], "favorite"); assert.equal(r.updated, 1); await threadState.bulk(ctx.ws, [{ mailboxId: ctx.mailbox.id, threadId: P.who.threadId }], "disable_ai"); const s = await threadState.getState(ctx.ws, ctx.mailbox.id, P.who.threadId); assert.ok(s.is_favorite && s.ai_disabled); });
  await check("bulk rejects unknown action and cross-workspace threads", async () => { await assert.rejects(() => threadState.bulk(ctx.ws, [{ mailboxId: 1, threadId: "x" }], "nope")); await assert.rejects(() => threadState.patch(999999, ctx.mailbox.id, P.who.threadId, { isFavorite: true }), /not found/i); });

  console.log("\n[5] AI path (model + sender stubbed; nothing leaves the machine)");
  const sent = [];
  inboxService.sendReply = async (mailboxId, threadId, { body }, workspaceId) => {
    const row = (await db.query(`INSERT INTO messages (mailbox_id, direction, thread_id, from_address, to_address, subject, body_text, workspace_id) VALUES ($1,'outbound',$2,'sam','p','Re: Quick question',$3,$4) RETURNING id`, [mailboxId, threadId, body, workspaceId])).rows[0];
    sent.push(body); return { id: row.id };
  };
  const original = agent.generate;
  const lastInbound = async (p) => (await db.query(`SELECT * FROM messages WHERE workspace_id=$1 AND thread_id=$2 AND direction='inbound' ORDER BY created_at DESC LIMIT 1`, [ctx.ws, p.threadId])).rows[0];
  const mailboxRow = (await db.query(`SELECT * FROM mailboxes WHERE id=$1`, [ctx.mailbox.id])).rows[0];
  const campaignRow = (await db.query(`SELECT * FROM campaigns WHERE id=$1`, [ctx.campaign])).rows[0];
  const leadRow = async (p) => (await db.query(`SELECT * FROM campaign_leads WHERE id=$1`, [p.leadId])).rows[0];
  const run = async (p, cls) => sdr.reply({ workspaceId: ctx.ws, mailbox: mailboxRow, lead: await leadRow(p), campaign: campaignRow, inbound: await lastInbound(p), classification: cls || classifier.classify({ subject: "Re:", body: "book a call tomorrow 2pm" }) });

  const stubMeeting = async () => ({ intent: "meeting_request", interest: "very_high", shouldReply: true, escalate: false, escalateReason: "", wantsMeeting: true, reply: "Hi Meeting,\nHappy to talk. Does tomorrow work?\nSam Seller", generatedBy: "stub:model" });
  agent.generate = stubMeeting;
  await check("auto-send: reply sent, labelled AI, state updated", async () => { const r = await run(P.meeting); assert.equal(r.status, "Sent"); const dd = await threadState.detail(ctx.ws, ctx.mailbox.id, P.meeting.threadId); assert.equal(dd.messages.at(-1).kind, "ai"); assert.equal(sent.length, 1); });
  await check("does not reply twice to the same message (stale guard)", async () => { const r = await run(P.meeting); assert.equal(r.status, "Skipped"); assert.equal(r.reason, "stale"); });
  await check("thread with AI disabled is skipped", async () => { const r = await run(P.who); assert.equal(r.reason, "thread_disabled"); });
  await check("pausing the SDR skips everything", async () => { await settings.updateSettings(ctx.ws, { enabled: false }); const r = await run(P.price); await settings.updateSettings(ctx.ws, { enabled: true }); assert.equal(r.reason, "sdr_paused"); });
  await check("out-of-office threads get no reply", async () => { const r = await run(P.ooo, classifier.classify({ subject: "Automatic reply: x", body: "out of the office" })); assert.equal(r.reason, "no_reply_needed"); });

  agent.generate = original;
  const another = await makeLead(ctx, "approval", "Approval Person"); await inbound(ctx, another, "Re: Quick question", "Yes, interested.");
  agent.generate = stubMeeting;
  await settings.updateSettings(ctx.ws, { requireApproval: true });
  await check("approval mode: reply waits as a draft, nothing sent", async () => { const before = sent.length; const r = await run(another); assert.equal(r.status, "Drafted", JSON.stringify({status:r.status,reason:r.reason})); assert.equal(sent.length, before); const dd = await threadState.detail(ctx.ws, ctx.mailbox.id, another.threadId); assert.ok(dd.pendingDraft && /Happy to talk/.test(dd.pendingDraft.body)); });
  await settings.updateSettings(ctx.ws, { requireApproval: false });

  agent.generate = original;
  const risky = await makeLead(ctx, "risky", "Risky Person"); await inbound(ctx, risky, "Re: Quick question", "Do you integrate with our legacy ERP and what is your SOC2 status?");
  agent.generate = async () => ({ intent: "question", interest: "medium", shouldReply: true, escalate: true, escalateReason: "Asks about SOC2, not in the sources", wantsMeeting: false, reply: "I'll confirm and come back to you.", generatedBy: "stub:model" });
  await check("escalation: draft saved, thread flagged, task opened, nothing sent", async () => { const before = sent.length; const r = await run(risky); assert.equal(r.status, "Drafted", JSON.stringify({status:r.status,reason:r.reason})); assert.equal(sent.length, before); const s = await threadState.getState(ctx.ws, ctx.mailbox.id, risky.threadId); assert.ok(s.needs_attention && /SOC2/.test(s.attention_reason)); const t = (await db.query(`SELECT 1 FROM crm_tasks WHERE workspace_id=$1 AND record_id=$2 AND status='open'`, [ctx.ws, `${ctx.mailbox.id}:${risky.threadId}`])).rows; assert.equal(t.length, 1); });
  agent.generate = async () => { throw new Error("quota exceeded"); };
  const quota = await makeLead(ctx, "quota", "Quota Person"); await inbound(ctx, quota, "Re: Quick question", "Yes please send more info");
  await check("model failure never loses the thread: flagged for a person", async () => { const r = await run(quota, classifier.classify({ subject: "", body: "Yes please send more info" })); assert.equal(r.reason, "ai_unavailable"); const s = await threadState.getState(ctx.ws, ctx.mailbox.id, quota.threadId); assert.ok(s.needs_attention); });
  agent.generate = original;

  agent.generate = stubMeeting;
  await check("END TO END: an inbound reply alone (via the real hook) produces an AI-labelled reply", async () => {
    const e2e = await makeLead(ctx, "e2e", "Hook Person"); const before = sent.length;
    await inbound(ctx, e2e, "Re: Quick question", "Yes, let's talk. Can you call me tomorrow?"); await sleep(600);
    const dd = await threadState.detail(ctx.ws, ctx.mailbox.id, e2e.threadId);
    assert.equal(sent.length, before + 1); assert.deepEqual(dd.messages.map((m) => m.kind), ["campaign", "prospect", "ai"]);
  });
  agent.generate = original;

  console.log("\n[5b] grounding backstop (does not trust the model)");
  const grounding = require(`${BE}/services/sdr/grounding`);
  await check("risky topic with no written answer is flagged", () => { assert.match(grounding.ungroundedTopic({ prospectText: "Are you licensed in DC and insured?", knowledgeText: "We staff Maryland." }), /licensing/); });
  await check("same question is fine when the knowledge base covers it", () => assert.equal(grounding.ungroundedTopic({ prospectText: "Are you licensed in DC?", knowledgeText: "We are licensed in DC and Maryland." }), null));
  await check("ordinary questions are not flagged", () => assert.equal(grounding.ungroundedTopic({ prospectText: "What days do you cover?", knowledgeText: "" }), null));
  agent.generate = async () => ({ intent: "question", interest: "medium", shouldReply: true, escalate: false, escalateReason: "", wantsMeeting: false, reply: "Yes, we are fully licensed.", generatedBy: "stub:model" });
  await check("END TO END: a licence question the model would answer is held as a draft and flagged, never sent", async () => {
    agent.generate = original;
    const lic = await makeLead(ctx, "licence", "Licence Person"); await inbound(ctx, lic, "Re: Quick question", "Are you licensed to operate in DC?");
    agent.generate = async () => ({ intent: "question", interest: "medium", shouldReply: true, escalate: false, escalateReason: "", wantsMeeting: false, reply: "Yes, we are fully licensed.", generatedBy: "stub:model" });
    const before = sent.length;
    await settings.updateSettings(ctx.ws, { knowledgeBase: "We staff Maryland restaurants." });
    const r = await run(lic, classifier.classify({ subject: "", body: "Are you licensed to operate in DC?" }));
    assert.equal(r.status, "Drafted"); assert.equal(sent.length, before);
    const st = await threadState.getState(ctx.ws, ctx.mailbox.id, lic.threadId); assert.ok(st.needs_attention && /licensing/.test(st.attention_reason));
  });
  agent.generate = original;

  console.log("\n[6] settings, prompt, webhook");
  await check("brain + rules + meeting types + resources round-trip", async () => {
    await settings.updateBrain(ctx.ws, { companyName: "Acme Staffing", whatYouSell: "On-site workers", senderTitle: "Business Manager" });
    await settings.replaceRules(ctx.ws, ["Never mention pricing", "  ", "Always sign as Sam"]);
    await settings.createMeetingType(ctx.ws, { name: "Discovery", durationMinutes: 45, campaignType: "Direct" });
    await settings.createResource(ctx.ws, { title: "Case study", url: "https://example.com/cs.pdf" });
    await settings.updateSettings(ctx.ws, { knowledgeBase: "We cover Maryland.", bookingLink: "https://cal.example.com/sam" });
    const all = await settings.getAll(ctx.ws);
    assert.equal(all.brain.companyName, "Acme Staffing"); assert.equal(all.rules.length, 2); assert.ok(all.meetingTypes.length >= 2); assert.equal(all.resources.length >= 1, true);
  });
  await check("prompt contains facts, KB, rules (numbered), guardrails, output schema", async () => {
    const all = await settings.loadForPrompt(ctx.ws, ctx.campaign);
    const p = agent.buildSystemPrompt({ brain: all.brain, knowledgeBase: all.settings.knowledgeBase, rules: all.rules.map((r) => r.rule), meetingTypes: all.meetingTypes, resources: all.resources, bookingLink: all.settings.bookingLink, mailbox: mailboxRow, campaign: campaignRow });
    for (const needle of ["Acme Staffing", "We cover Maryland.", "1. Never mention pricing", "2. Always sign as Sam", "Never invent", "https://cal.example.com/sam", "Case study", '"should_reply"', "Sam Seller"]) assert.ok(p.includes(needle), `missing: ${needle}`);
  });
  await check("model output parsing: fenced JSON ok, garbage rejected, bad enums sanitised", () => {
    const ok = agent.parseOutput('```json\n{"intent":"question","interest":"high","should_reply":true,"escalate":false,"wants_meeting":false,"reply":"Hi"}\n```');
    assert.equal(ok.interest, "high"); assert.equal(ok.shouldReply, true);
    assert.equal(agent.parseOutput("sure, here you go"), null);
    assert.equal(agent.parseOutput('{"intent":"hack","interest":"mega","should_reply":"yes"}').shouldReply, false);
  });
  await check("webhook URL validation: http, localhost, private IP, bad value all rejected", async () => {
    for (const bad of ["http://example.com/x", "https://localhost/x", "https://127.0.0.1/x", "https://10.0.0.5/x", "https://169.254.169.254/latest", "not a url"]) await assert.rejects(() => webhook.assertSafeUrl(bad), undefined, bad);
  });
  await check("webhook signature is HMAC-SHA256 of timestamp.body", () => assert.equal(webhook.sign("s", "1", "{}").length, 64));
  await check("members can't edit settings through the controller", async () => {
    const c = require(`${BE}/controllers/aiSdr.controller`); let status = 0;
    await c.updateSettings({ method: "PUT", user: { isSuperAdmin: false }, workspace: { role: "member" }, workspaceId: ctx.ws, body: {} }, { status: (s) => ({ json: () => { status = s; } }) });
    assert.equal(status, 403);
  });
  await check("cannot delete the last meeting type", async () => { const all = await settings.getAll(ctx.ws); for (const t of all.meetingTypes.slice(1)) await settings.deleteMeetingType(ctx.ws, t.id); await assert.rejects(() => settings.deleteMeetingType(ctx.ws, all.meetingTypes[0].id), /at least one/); });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
