// Offline checks of the sequence generator's validation, plus (with SDR_REAL_AI=1) a real-model run on a fictional business.
// Run from the workspace root:  [SDR_REAL_AI=1] ./dev-local.sh node scripts/sequence-generator-test.js
const BE = require("path").resolve(__dirname, "..");
const assert = require("assert");
const db = require(`${BE}/config/db.config`);
const gen = require(`${BE}/services/sdr/sequenceGenerator.service`);
const settings = require(`${BE}/services/sdr/settings.service`);

let pass = 0, fail = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log("  PASS", name); }, (e) => { fail++; console.log("  FAIL", name, "->", e.message); });
const good = (over = {}) => JSON.stringify({ steps: [{ subject: "Quick idea for {{company}}", body: "Hi {{firstName}},\n\nWe place on-site staff in Baltimore.\n\nBest,\n{{senderName}}", delayDays: 0 }, { subject: "", body: "Hi {{firstName}},\n\nOne more thought on staffing for {{company}}.\n\n{{senderName}}", delayDays: 3 }], ...over });
const words = (t) => t.replace(/<[^>]+>/g, " ").trim().split(/\s+/).filter(Boolean).length;

(async () => {
  console.log("\n[1] validation (offline)");
  await check("a good answer becomes HTML paragraphs with the first email's subject and a zero delay", () => { const s = gen.parseSteps(good(), 3); assert.equal(s.length, 2); assert.equal(s[0].subject, "Quick idea for {{company}}"); assert.equal(s[0].delayDays, 0); assert.equal(s[1].delayDays, 3); assert.match(s[0].body, /^<p>Hi \{\{firstName\}\},<\/p><p>We place/); assert.ok(s[0].body.includes("<br>")); });
  await check("fenced JSON is accepted", () => assert.equal(gen.parseSteps("```json\n" + good() + "\n```", 3).length, 2));
  await check("an unknown variable is rejected (the send engine would refuse that lead)", () => assert.throws(() => gen.parseSteps(good({ steps: [{ subject: "Hi {{first_initial}}", body: "Hi {{firstName}}, this is a long enough body for the check.", delayDays: 0 }] }), 3), /unknown variable/));
  await check("an unknown variable in a body is rejected too", () => assert.throws(() => gen.parseSteps(good({ steps: [{ subject: "x", body: "Hi {{firstName}}, we saw {{website}} and liked it a lot.", delayDays: 0 }] }), 3), /unknown variable website/));
  await check("half-open braces are rejected", () => assert.throws(() => gen.parseSteps(good({ steps: [{ subject: "x", body: "Hi {{firstName}, this is a long enough body for the check.", delayDays: 0 }] }), 3), /malformed/));
  await check("a missing first subject, an empty body and non-JSON are rejected", () => { assert.throws(() => gen.parseSteps(good({ steps: [{ subject: "", body: "A long enough body for the first email here.", delayDays: 0 }] }), 3), /subject/); assert.throws(() => gen.parseSteps(good({ steps: [{ subject: "x", body: "short", delayDays: 0 }] }), 3), /empty/); assert.throws(() => gen.parseSteps("sure, here you go", 3), /not json/); assert.throws(() => gen.parseSteps('{"steps":[]}', 3), /no steps/); });
  await check("more steps than asked are dropped; delays are clamped to 1-30 days", () => { const many = { steps: [0, 1, 2, 3, 4].map((i) => ({ subject: i === 0 ? "s" : "", body: "Hi {{firstName}}, body number long enough here.", delayDays: i === 2 ? 99 : i === 3 ? -5 : 2 })) }; const s = gen.parseSteps(JSON.stringify(many), 3); assert.equal(s.length, 3); assert.equal(s[2].delayDays, 30); });
  await check("HTML in the model's text is escaped, not executed", () => { const s = gen.parseSteps(good({ steps: [{ subject: "x", body: "Hi {{firstName}}, <script>alert(1)</script> is not allowed here at all.", delayDays: 0 }] }), 3); assert.ok(!s[0].body.includes("<script>")); assert.ok(s[0].body.includes("&lt;script&gt;")); });

  console.log("\n[2] preconditions");
  const ws = (await db.query(`INSERT INTO workspaces (name, slug, platform_ai_enabled) VALUES ($1, $2, TRUE) RETURNING id`, [`SeqGen ${Date.now()}`, `seqgen-${Date.now()}`])).rows[0].id;
  await check("refuses without a campaign name", () => assert.rejects(() => gen.generate(ws, { name: "  " }), /name/i));
  await check("refuses (with guidance) when the Brain and knowledge base are empty", () => assert.rejects(() => gen.generate(ws, { name: "Test" }), /Brain/));

  if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY && !process.env.GEMINI_API_KEY) {
    console.log("\n[3] real model: skipped (run with SDR_REAL_AI=1)");
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }

  console.log("\n[3] real model, fictional business");
  const FACTS = ["Acme Staffing", "Baltimore", "20 or more", "6 hours", "waitstaff", "kitchen"]; // numbers allowed to appear
  await settings.updateBrain(ws, { companyName: "Acme Staffing", whoYouSellTo: "Restaurants and hotels in the Baltimore area with 20 or more on-site employees", whatYouSell: "Reliable on-site waitstaff and kitchen workers, supplied on demand", senderFirstName: "Yuri", senderTitle: "Owner" });
  await settings.updateSettings(ws, { knowledgeBase: "Offer: a new client's first worker comes with their first 6 hours free. Yuri Kovalenko owns Acme Staffing and runs every intro call." });
  for (let run = 1; run <= 2; run++) {
    const out = await gen.generate(ws, { name: "Baltimore restaurants", audience: "General managers of busy restaurants", steps: 3 });
    console.log(`\n--- run ${run} (${out.generatedBy})`);
    out.steps.forEach((s, i) => console.log(`  [${i + 1}] ${s.subject ? `Subject: ${s.subject}\n      ` : ""}${s.body.replace(/<\/p><p>/g, "\n      ").replace(/<br>/g, "\n      ").replace(/<[^>]+>/g, "")}   (+${s.delayDays}d)`));
    await check(`run ${run}: three emails, valid variables only`, () => assert.equal(out.steps.length, 3));
    await check(`run ${run}: first subject at most 7 words; every email under 90 words`, () => { assert.ok(words(out.steps[0].subject) <= 7, out.steps[0].subject); out.steps.forEach((s) => assert.ok(words(s.body) < 90, `${words(s.body)} words`)); });
    await check(`run ${run}: opens with Hi {{firstName}}, ends with {{senderName}}`, () => out.steps.forEach((s) => { assert.ok(s.body.includes("Hi {{firstName}}")); assert.ok(s.body.includes("{{senderName}}")); }));
    await check(`run ${run}: no markdown, no exclamation marks, no opt-out line`, () => out.steps.forEach((s) => { const t = s.body.replace(/<[^>]+>/g, ""); assert.ok(!/[*#`]/.test(t), "markdown"); assert.ok(!t.includes("!"), "exclamation"); assert.ok(!/opt[- ]?out|unsubscribe/i.test(t), "opt-out"); }));
    await check(`run ${run}: no unsupported promises or praise`, () => out.steps.forEach((s) => { const t = s.body.replace(/<br>|<\/p><p>/g, "\n").replace(/<[^>]+>/g, "").replace(/^[^\n]{1,25}[,.]\s*$/gm, ""); const hit = t.match(/\b(best|guarantee[ds]?|seamless(ly)?|efficient(ly)?|top-notch|trusted|proven|leading|exceptional|world-class)\b/i); assert.ok(!hit, `unsupported claim word: ${hit && hit[0]}`); }));
    await check(`run ${run}: every number in the copy comes from the facts`, () => out.steps.forEach((s) => { const nums = (s.body.replace(/<[^>]+>/g, "").replace(/\{\{[^}]+\}\}/g, "").match(/\d+/g) || []); nums.forEach((n) => assert.ok(["20", "6"].includes(n), `invented number ${n}`)); }));
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
