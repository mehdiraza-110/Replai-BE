// Verifies the campaign overview and analytics numbers against hand-computed data in a throwaway workspace.
// Run from the workspace root:  ./dev-local.sh node scripts/campaign-insights-test.js
const BE = require("path").resolve(__dirname, "..");
const assert = require("assert");
const db = require(`${BE}/config/db.config`);
const insights = require(`${BE}/services/campaignInsights.service`);

let pass = 0, fail = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log("  PASS", name); }, (e) => { fail++; console.log("  FAIL", name, "->", e.message); });
const stamp = Date.now();

(async () => {
  const ws = (await db.query(`INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id`, [`Insights ${stamp}`, `insights-${stamp}`])).rows[0].id;
  const other = (await db.query(`INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id`, [`Insights other ${stamp}`, `insights-o-${stamp}`])).rows[0].id;
  const domain = (await db.query(`INSERT INTO domains (domain, status, workspace_id) VALUES ($1, 'Verified', $2) RETURNING id`, [`ins${stamp}.invalid`, ws])).rows[0].id;
  const mailbox = (await db.query(`INSERT INTO mailboxes (domain_id, email, local_part, workspace_id, provider) VALUES ($1, $2, 'a', $3, 'Test') RETURNING id`, [domain, `a@ins${stamp}.invalid`, ws])).rows[0].id;

  // Campaign A: 200 emails sent, 10 replies, 4 positive threads of which 1 booked; campaign B: nothing sent.
  const A = (await db.query(`INSERT INTO campaigns (name, subject, body, workspace_id, status, sent_total, reply_count, started_at) VALUES ('Alpha outreach', 's', 'b', $1, 'Active', 200, 10, NOW() - INTERVAL '3 days') RETURNING id`, [ws])).rows[0].id;
  const B = (await db.query(`INSERT INTO campaigns (name, subject, body, workspace_id, status, sent_total, reply_count, started_at) VALUES ('Beta 100% promo', 's', 'b', $1, 'Paused', 0, 0, NOW() - INTERVAL '60 days') RETURNING id`, [ws])).rows[0].id;
  const W = (await db.query(`INSERT INTO campaigns (name, subject, body, workspace_id, is_warmup, sent_total) VALUES ('Warm', 's', 'b', $1, TRUE, 999) RETURNING id`, [ws])).rows[0].id;
  await db.query(`INSERT INTO campaigns (name, subject, body, workspace_id, sent_total) VALUES ('Other workspace', 's', 'b', $1, 777)`, [other]);
  await db.query(`INSERT INTO campaign_followups (campaign_id, workspace_id, step_order, delay_days, body) VALUES ($1, $2, 1, 3, 'f1'), ($1, $2, 2, 3, 'f2')`, [A, ws]);

  // leads at different points of the sequence: 5 sent only, 3 got follow-up 1, 2 got both
  const mkLead = async (i, step) => (await db.query(`INSERT INTO campaign_leads (campaign_id, email, status, workspace_id, sent_at, followup_step, mailbox_id) VALUES ($1, $2, 'Sent', $3, NOW(), $4, $5) RETURNING id`, [A, `l${i}${stamp}@p.invalid`, ws, step, mailbox])).rows[0].id;
  const leads = []; for (let i = 0; i < 5; i++) leads.push(await mkLead(i, 0)); for (let i = 5; i < 8; i++) leads.push(await mkLead(i, 1)); for (let i = 8; i < 10; i++) leads.push(await mkLead(i, 2));
  await db.query(`INSERT INTO campaign_leads (campaign_id, email, status, workspace_id) VALUES ($1, $2, 'Pending', $3)`, [A, `pending${stamp}@p.invalid`, ws]); // uploaded but never contacted

  // 6 replied threads: interest very_high x2 (one booked), high x2, medium x1, none x1
  const mkThread = async (i, interest, outcome) => {
    const tid = `${mailbox}:t${i}${stamp}@p.invalid`;
    await db.query(`INSERT INTO messages (mailbox_id, direction, campaign_id, thread_id, from_address, to_address, subject, body_text, workspace_id) VALUES ($1,'outbound',$2,$3,'a','p','s','hi',$4)`, [mailbox, A, tid, ws]);
    await db.query(`INSERT INTO messages (mailbox_id, direction, campaign_id, thread_id, from_address, to_address, subject, body_text, workspace_id) VALUES ($1,'inbound',$2,$3,'p','a','s','reply',$4)`, [mailbox, A, tid, ws]);
    await db.query(`INSERT INTO sdr_thread_state (workspace_id, mailbox_id, thread_id, interest, outcome) VALUES ($1, $2, $3, $4, $5)`, [ws, mailbox, tid, interest, outcome]);
    return tid;
  };
  await mkThread(1, "very_high", "meeting_booked"); await mkThread(2, "very_high", "none"); await mkThread(3, "high", "none"); await mkThread(4, "high", "none"); await mkThread(5, "medium", "none"); await mkThread(6, "none", "none");
  // a thread booked through the calendar (booking row, outcome still "none") also counts as booked, and is positive
  const t7 = await mkThread(7, "high", "none"); await db.query(`INSERT INTO sdr_bookings (workspace_id, mailbox_id, thread_id, scheduled_start, scheduled_end) VALUES ($1, $2, $3, NOW() + INTERVAL '1 day', NOW() + INTERVAL '1 day 30 minutes')`, [ws, mailbox, t7]);
  // positive thread of the warm-up campaign must never count anywhere
  const wt = `${mailbox}:warm${stamp}@p.invalid`; await db.query(`INSERT INTO messages (mailbox_id, direction, campaign_id, thread_id, from_address, to_address, subject, body_text, workspace_id) VALUES ($1,'inbound',$2,$3,'p','a','s','r',$4)`, [mailbox, W, wt, ws]); await db.query(`INSERT INTO sdr_thread_state (workspace_id, mailbox_id, thread_id, interest) VALUES ($1,$2,$3,'very_high')`, [ws, mailbox, wt]);

  console.log("\n[1] overview");
  const o = await insights.overview(ws, {});
  await check("only this workspace's real campaigns are listed (no warm-up, no other workspace)", () => { assert.equal(o.total, 2); assert.deepEqual(o.items.map((i) => i.name).sort(), ["Alpha outreach", "Beta 100% promo"]); });
  await check("header: contacted is the sum of emails sent; positive = high/very_high replied threads", () => { assert.equal(o.summary.contactedLeads, 200); assert.equal(o.summary.positiveReplies, 5); });
  await check("header rates: positive/contacted and booked/positive", () => { assert.equal(o.summary.positiveReplyRate, 2.5); assert.equal(o.summary.callsBooked, 2); assert.equal(o.summary.bookedCallRate, 40); });
  const alpha = o.items.find((i) => i.name === "Alpha outreach");
  await check("row: replies, rates against the displayed 'leads contacted', booked counts both outcome and calendar bookings", () => { assert.equal(alpha.leadsContacted, 200); assert.equal(alpha.replies, 10); assert.equal(alpha.replyRate, 5); assert.equal(alpha.positiveReplies, 5); assert.equal(alpha.positiveReplyRate, 2.5); assert.equal(alpha.callsBooked, 2); });
  await check("a campaign with nothing sent shows zeros, not NaN", () => { const beta = o.items.find((i) => i.name.startsWith("Beta")); assert.deepEqual([beta.leadsContacted, beta.replyRate, beta.positiveReplyRate, beta.callsBooked], [0, 0, 0, 0]); });
  await check("status filter", async () => { const r = await insights.overview(ws, { status: "Paused" }); assert.deepEqual(r.items.map((i) => i.name), ["Beta 100% promo"]); assert.equal(r.summary.contactedLeads, 0); });
  await check("date range filter drops the old campaign (and its numbers)", async () => { const r = await insights.overview(ws, { range: "30d" }); assert.deepEqual(r.items.map((i) => i.name), ["Alpha outreach"]); });
  await check("search matches by name and a literal % or _ matches nothing special", async () => { assert.equal((await insights.overview(ws, { search: "alpha" })).total, 1); assert.equal((await insights.overview(ws, { search: "100%" })).total, 1); assert.equal((await insights.overview(ws, { search: "%" })).total, 1); assert.equal((await insights.overview(ws, { search: "_" })).total, 0); });
  await check("bad filters are rejected", async () => { await assert.rejects(() => insights.overview(ws, { status: "Nope" }), /status/i); await assert.rejects(() => insights.overview(ws, { range: "1y" }), /range/i); });
  await check("pagination", async () => { const r = await insights.overview(ws, { limit: 1, page: 2 }); assert.equal(r.items.length, 1); assert.equal(r.totalPages, 2); });

  console.log("\n[2] campaign analytics");
  const a = await insights.analytics(ws, A);
  await check("headline numbers", () => { assert.equal(a.leadsUploaded, 11); assert.equal(a.leadsContacted, 200); assert.equal(a.replies, 10); assert.equal(a.positiveReplies, 5); assert.equal(a.bookedCalls, 2); assert.equal(a.bookedCallRate, 40); });
  await check("default targets, then saved targets", async () => { assert.deepEqual(a.targets, { positiveRate: 1, bookedRate: 25 }); await insights.saveTargets(ws, A, { positiveRate: 3.5, bookedRate: 30 }); assert.deepEqual((await insights.analytics(ws, A)).targets, { positiveRate: 3.5, bookedRate: 30 }); });
  await check("per-step sends: 10 initial, 5 reached follow-up 1, 2 reached follow-up 2", () => { assert.deepEqual(a.steps.map((s) => [s.label, s.sent]), [["Initial Outreach", 10], ["Follow-up 1", 5], ["Follow-up 2", 2]]); });
  await check("daily series covers every day of the window, zero-filled, and today's activity shows", () => { assert.equal(a.series.length, 30); const today = a.series.at(-1); assert.equal(today.replied, 7); assert.ok(today.positive >= 5); assert.ok(a.series.every((p) => /^\d{4}-\d\d-\d\d$/.test(p.date))); });
  await check("window length is clamped", async () => { assert.equal((await insights.analytics(ws, A, { days: 1 })).series.length, 7); assert.equal((await insights.analytics(ws, A, { days: 9999 })).series.length, 365); });
  await check("target validation", async () => { await assert.rejects(() => insights.saveTargets(ws, A, { positiveRate: 101, bookedRate: 10 }), /between 0 and 100/); await assert.rejects(() => insights.saveTargets(ws, A, { positiveRate: "abc", bookedRate: 10 }), /between 0 and 100/); });
  await check("delivery: counted from the leads themselves, per inbox, and spam placement is null without warm-up tests", async () => {
    const d = (await insights.analytics(ws, A)).delivery; const b = (await insights.analytics(ws, A));
    const leads = (await db.query(`SELECT status, COUNT(*)::int n FROM campaign_leads WHERE campaign_id = $1 GROUP BY status`, [A])).rows; const n = (st) => leads.filter((r) => r.status === st).reduce((x, r) => x + r.n, 0);
    assert.equal(d.bounced, n("Bounced")); assert.equal(d.pending, n("Pending")); assert.equal(d.sent, n("Sent") + n("Replied") + n("Bounced")); assert.equal(d.delivered, d.sent - d.bounced);
    assert.equal(d.bounceRate, d.sent ? Math.round((d.bounced / d.sent) * 10000) / 100 : 0); assert.ok(Array.isArray(b.byInbox)); assert.equal(b.placement, null);
    assert.ok((await insights.overview(ws)).items.every((r) => typeof r.bounced === "number" && typeof r.bounceRate === "number"));
  });
  await check("tenant isolation: another workspace cannot read or change this campaign", async () => { await assert.rejects(() => insights.analytics(other, A), /not found/i); await assert.rejects(() => insights.saveTargets(other, A, { positiveRate: 1, bookedRate: 1 }), /not found/i); await assert.rejects(() => insights.analytics(ws, W), /not found/i); await assert.rejects(() => insights.analytics(ws, "abc"), /not found/i); });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
