// Seeds throwaway data into the LOCAL sandbox DB and exercises the Replier (per reply-type modes + instructions).
// The model and the email sender are stubbed. Run:  ./dev-local.sh node scripts/replier-test.js
const BE = require("path").resolve(__dirname, "..");
const assert = require("assert");
const db = require(`${BE}/config/db.config`);
const inboundEmail = require(`${BE}/services/inboundEmail.service`);
const inboxService = require(`${BE}/services/inbox.service`);
const agent = require(`${BE}/services/sdr/agent.service`);
const threadState = require(`${BE}/services/sdr/threadState.service`);
const sdr = require(`${BE}/services/sdr/inbound.service`);
const classifier = require(`${BE}/services/sdr/classifier.service`);
const replier = require(`${BE}/services/replier.service`);

let pass = 0, fail = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log("  PASS", name); }, (e) => { fail++; console.log("  FAIL", name, "->", e.message); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = Date.now();

(async () => {
  const mkWs = async (n) => (await db.query(`INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id`, [`Replier test ${n} ${stamp}`, `replier-test-${n}-${stamp}`])).rows[0].id;
  const ws = await mkWs("a");
  const other = await mkWs("b");
  const domain = (await db.query(`INSERT INTO domains (domain, status, workspace_id) VALUES ($1, 'Verified', $2) RETURNING id`, [`rptest${stamp}.invalid`, ws])).rows[0].id;
  const mailbox = (await db.query(`INSERT INTO mailboxes (domain_id, email, local_part, display_name, workspace_id, provider) VALUES ($1, $2, 'sam', 'Sam Seller', $3, 'Test') RETURNING id, email`, [domain, `sam@rptest${stamp}.invalid`, ws])).rows[0];
  const campaign = (await db.query(`INSERT INTO campaigns (name, subject, body, workspace_id, status) VALUES ('RP campaign', 'Quick question', 'Hi', $1, 'Active') RETURNING id`, [ws])).rows[0].id;
  const mailboxRow = (await db.query(`SELECT * FROM mailboxes WHERE id=$1`, [mailbox.id])).rows[0];
  const campaignRow = (await db.query(`SELECT * FROM campaigns WHERE id=$1`, [campaign])).rows[0];

  console.log("\n[1] service: defaults, save, validation, isolation");
  await check("defaults: unsubscribe/out_of_office no_reply, complaint escalate, rest default", async () => {
    const list = await replier.list(ws, null);
    const m = Object.fromEntries(list.map((t) => [t.intent, t.mode]));
    assert.equal(m.unsubscribe, "no_reply"); assert.equal(m.out_of_office, "no_reply"); assert.equal(m.complaint, "escalate"); assert.equal(m.interested, "default");
  });
  await check("save persists mode + instruction and returns the merged list", async () => {
    const list = await replier.save(ws, null, [{ intent: "question", mode: "draft", instruction: "Answer briefly, then offer a call." }, { intent: "interested", mode: "auto" }]);
    const q = list.find((t) => t.intent === "question");
    assert.equal(q.mode, "draft"); assert.equal(q.instruction, "Answer briefly, then offer a call."); assert.ok(q.customised);
    assert.equal(list.find((t) => t.intent === "interested").mode, "auto");
  });
  await check("rows equal to the default are not stored", async () => {
    await replier.save(ws, null, [{ intent: "other", mode: "default", instruction: "" }]);
    const n = (await db.query(`SELECT COUNT(*)::int c FROM sdr_reply_types WHERE workspace_id=$1`, [ws])).rows[0].c; assert.equal(n, 0);
  });
  await check("rejects unknown intent, unknown mode, and answering an unsubscribe", async () => {
    await assert.rejects(() => replier.save(ws, null, [{ intent: "nope", mode: "auto" }]), /Unknown reply type/);
    await assert.rejects(() => replier.save(ws, null, [{ intent: "question", mode: "yolo" }]), /Unknown mode/);
    await assert.rejects(() => replier.save(ws, null, [{ intent: "unsubscribe", mode: "auto" }]), /never be answered/);
  });
  await check("another workspace's agent is not reachable (404) and settings are isolated", async () => {
    const a = (await db.query(`INSERT INTO ai_agents (name, role, persona, company_name, objective, ai_provider, ai_model, workspace_id) VALUES ('Other agent','r','p','c','o','openai','gpt-4o',$1) RETURNING id`, [other])).rows[0].id;
    await assert.rejects(() => replier.list(ws, a), /not found/i);
    await replier.save(ws, null, [{ intent: "question", mode: "escalate" }]);
    assert.equal((await replier.list(other, null)).find((t) => t.intent === "question").mode, "default");
  });
  await check("per-agent rules are separate from the AI SDR rules; deleting the agent cascades", async () => {
    const a = (await db.query(`INSERT INTO ai_agents (name, role, persona, company_name, objective, ai_provider, ai_model, workspace_id) VALUES ('Agent A','r','p','c','o','openai','gpt-4o',$1) RETURNING id`, [ws])).rows[0].id;
    await replier.save(ws, a, [{ intent: "objection", mode: "draft", instruction: "Acknowledge." }]);
    assert.equal((await replier.list(ws, null)).find((t) => t.intent === "objection").mode, "default");
    assert.equal((await replier.list(ws, a)).find((t) => t.intent === "objection").mode, "draft");
    await db.query(`DELETE FROM ai_agents WHERE id=$1`, [a]);
    assert.equal((await db.query(`SELECT COUNT(*)::int c FROM sdr_reply_types WHERE agent_id=$1`, [a])).rows[0].c, 0);
  });
  await check("campaign coverage: assign and clear an agent, workspace-scoped", async () => {
    const a = (await db.query(`INSERT INTO ai_agents (name, role, persona, company_name, objective, ai_provider, ai_model, workspace_id) VALUES ('Agent C','r','p','c','o','openai','gpt-4o',$1) RETURNING id`, [ws])).rows[0].id;
    let cov = await replier.assignCampaign(ws, campaign, a); assert.equal(cov.find((c) => c.id === campaign).agentName, "Agent C");
    cov = await replier.assignCampaign(ws, campaign, null); assert.equal(cov.find((c) => c.id === campaign).agentId, null);
    await assert.rejects(() => replier.assignCampaign(other, campaign, null), /not found/i);
  });
  await check("deleting an agent hands its campaigns back to the AI SDR", async () => {
    const a = (await db.query(`INSERT INTO ai_agents (name, role, persona, company_name, objective, ai_provider, ai_model, workspace_id) VALUES ('Agent D','r','p','c','o','openai','gpt-4o',$1) RETURNING id`, [ws])).rows[0].id;
    await replier.assignCampaign(ws, campaign, a);
    await require(`${BE}/services/aiAgent.service`).deleteAgent(ws, a);
    assert.equal((await replier.coverage(ws)).find((c) => c.id === campaign).agentId, null);
  });
  await replier.save(ws, null, []);

  console.log("\n[2] prompt carries the playbook");
  await check("buildSystemPrompt includes the reply playbook only when given", () => {
    const base = { brain: {}, knowledgeBase: "", rules: [], meetingTypes: [], resources: [], bookingLink: "", mailbox: null, campaign: null };
    assert.ok(!/REPLY PLAYBOOK/.test(agent.buildSystemPrompt(base)));
    assert.ok(/REPLY PLAYBOOK[\s\S]*Be brief/.test(agent.buildSystemPrompt({ ...base, replyPlaybook: '- When the prospect\'s reply is "question": Be brief' })));
  });

  console.log("\n[3] SDR honours the mode per reply type (model and sender stubbed)");
  const sent = [];
  inboxService.sendReply = async (mailboxId, threadId, { body }, workspaceId) => {
    const row = (await db.query(`INSERT INTO messages (mailbox_id, direction, thread_id, from_address, to_address, subject, body_text, workspace_id) VALUES ($1,'outbound',$2,'sam','p','Re: Quick question',$3,$4) RETURNING id`, [mailboxId, threadId, body, workspaceId])).rows[0];
    sent.push(body); return { id: row.id };
  };
  const stub = (intent, extra = {}) => async (args) => { stub.last = args; return { intent, interest: "medium", shouldReply: true, escalate: false, escalateReason: "", wantsMeeting: false, reply: "Thanks for your note.\nSam Seller", generatedBy: "stub:model", ...extra }; };
  let n = 0;
  const attempt = async (intent, text, extra = {}) => {
    n += 1;
    const email = `p${n}${stamp}@prospect.invalid`;
    const lead = (await db.query(`INSERT INTO campaign_leads (campaign_id, email, full_name, first_name, company, role, status, mailbox_id, workspace_id, sent_at) VALUES ($1,$2,'Pat Person','Pat','Acme','CEO','Sent',$3,$4,NOW()) RETURNING *`, [campaign, email, mailbox.id, ws])).rows[0];
    const threadId = `${mailbox.id}:${email}`;
    await db.query(`INSERT INTO messages (mailbox_id, direction, campaign_id, campaign_lead_id, thread_id, from_address, to_address, subject, body_text, workspace_id, created_at) VALUES ($1,'outbound',$2,$3,$4,$5,$6,'Quick question','Hi',$7, NOW() - INTERVAL '2 hours')`, [mailbox.id, campaign, lead.id, threadId, mailbox.email, email, ws]);
    const original = agent.generate; agent.generate = async () => null;
    await inboundEmail.recordInboxMessage({ mailbox: { id: mailbox.id, workspace_id: ws }, fromAddress: email, toAddress: mailbox.email, parsed: { subject: "Re: Quick question", messageId: `<${Math.random()}@x>`, text }, bodyText: text });
    await sleep(400); agent.generate = original;
    const inbound = (await db.query(`SELECT * FROM messages WHERE workspace_id=$1 AND thread_id=$2 AND direction='inbound' ORDER BY id DESC LIMIT 1`, [ws, threadId])).rows[0];
    agent.generate = stub(intent, extra);
    const before = sent.length;
    const result = await sdr.reply({ workspaceId: ws, mailbox: mailboxRow, lead, campaign: campaignRow, inbound, classification: classifier.classify({ subject: "Re:", body: text }) });
    return { result, sentNow: sent.length - before, threadId };
  };
  const setSdr = (patch) => db.query(`INSERT INTO sdr_settings (workspace_id) VALUES ($1) ON CONFLICT DO NOTHING`, [ws]).then(() => db.query(`UPDATE sdr_settings SET require_approval = $2, enabled = TRUE WHERE workspace_id = $1`, [ws, patch.requireApproval]));

  await setSdr({ requireApproval: false });
  await check("no rule saved: existing behaviour (auto-send)", async () => { const r = await attempt("question", "What does it cost exactly in the first year?"); assert.equal(r.result.status, "Sent"); assert.equal(r.sentNow, 1); });
  await replier.save(ws, null, [{ intent: "question", mode: "draft", instruction: "Answer in two sentences." }]);
  await check("draft: reply waits for review, nothing sent", async () => { const r = await attempt("question", "How does onboarding work for your team?"); assert.equal(r.result.status, "Drafted"); assert.equal(r.sentNow, 0); });
  await check("draft: the instruction reaches the model", async () => { assert.ok(/Answer in two sentences/.test(stub.last.context.replyPlaybook)); });
  await replier.save(ws, null, [{ intent: "question", mode: "no_reply" }]);
  await check("no_reply: nothing sent, nothing drafted", async () => { const r = await attempt("question", "Which regions do you cover today?"); assert.equal(r.result.status, "NoReply"); assert.equal(r.sentNow, 0); });
  await replier.save(ws, null, [{ intent: "question", mode: "escalate" }]);
  await check("escalate: no reply, thread flagged, task opened", async () => {
    const r = await attempt("question", "Do you support single sign-on for our staff?"); assert.equal(r.result.status, "NoReply"); assert.equal(r.sentNow, 0);
    const s = await threadState.getState(ws, mailbox.id, r.threadId); assert.ok(s.needs_attention && /escalate/i.test(s.attention_reason));
    assert.equal((await db.query(`SELECT COUNT(*)::int c FROM crm_tasks WHERE workspace_id=$1 AND record_id=$2 AND status='open'`, [ws, `${mailbox.id}:${r.threadId}`])).rows[0].c, 1);
  });
  await replier.save(ws, null, [{ intent: "question", mode: "auto" }]);
  await setSdr({ requireApproval: true });
  await check("auto: sends even though the workspace requires approval", async () => { const r = await attempt("question", "Can you share a rough price range please?"); assert.equal(r.result.status, "Sent"); assert.equal(r.sentNow, 1); });
  await check("auto never overrides a model escalation", async () => { const r = await attempt("question", "Is it certified for medical data, and what is your SOC2 status?", { escalate: true, escalateReason: "SOC2 not in sources" }); assert.equal(r.result.status, "Drafted"); assert.equal(r.sentNow, 0); });
  await check("a different type is unaffected by the question rule (approval still applies)", async () => { const r = await attempt("interested", "Yes this sounds interesting, tell me more."); assert.equal(r.result.status, "Drafted"); assert.equal(r.sentNow, 0); });
  await replier.save(ws, null, []);
  await setSdr({ requireApproval: false });

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.query(`DELETE FROM ai_agents WHERE workspace_id = ANY($1)`, [[ws, other]]).catch(() => null);
  await db.query(`DELETE FROM workspaces WHERE id = ANY($1)`, [[ws, other]]).catch(() => null); // throwaway workspaces stay in the sandbox DB, like the other SDR tests
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
