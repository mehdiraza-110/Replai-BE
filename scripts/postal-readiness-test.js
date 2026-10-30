// Verifies the guards for sending from our own mail servers in the LOCAL sandbox: the readiness gate (domain DNS verified + 14 warm
// days), the per-IP daily cap that rises with IP age, and bounce events for return-path addresses. The transport is stubbed:
// nothing is sent anywhere.
//   ./dev-local.sh node scripts/postal-readiness-test.js
const BE = require("path").resolve(__dirname, "..");
const assert = require("assert");
const mailTransport = require(`${BE}/services/mailTransport.service`);
let sent = [];
mailTransport.sendRawEmail = async ({ mailbox, to }) => { sent.push({ from: mailbox.email, to }); return "id"; };
const db = require(`${BE}/config/db.config`);
const campaignSend = require(`${BE}/services/campaignSend.service`);
const postalEvents = require(`${BE}/services/postalEvents.service`);

let pass = 0, fail = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log("  PASS", name); }, (e) => { fail++; console.log("  FAIL", name, "->", e.message); });
const stamp = Date.now();
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

(async () => {
  // Pacing is by time of day; keep clear of the first minute of the (all-day) window so every mailbox is allowed to send.
  const now = new Date();
  if (now.getUTCHours() === 0 && now.getUTCMinutes() === 0) await new Promise((r) => setTimeout(r, 61000));

  const ws = (await db.query(`INSERT INTO workspaces (name, slug) VALUES ($1,$2) RETURNING id`, [`Ready ${stamp}`, `ready-${stamp}`])).rows[0].id;
  const mkIp = async (ip, ageDays) => (await db.query(`INSERT INTO warmnet_ips (ip, created_at) VALUES ($1, $2) RETURNING id`, [ip, daysAgo(ageDays)])).rows[0].id;
  const mkDomain = async (name, { ipId = null, provider = "Postal", dkim = "Success", dmarc = "Success" } = {}) => {
    const d = (await db.query(`INSERT INTO domains (domain, registrar, dns_provider, provider, status, spf_status, dkim_status, dmarc_status, mx_status, workspace_id) VALUES ($1,'Porkbun','Porkbun',$2,'Verified','Success',$3,$4,'Success',$5) RETURNING id`, [name, provider, dkim, dmarc, ws])).rows[0].id;
    await db.query(`INSERT INTO warmnet_domains (domain_id, ip_id) VALUES ($1,$2)`, [d, ipId]);
    return d;
  };
  const mkBox = async (domainId, local, domain, { provider = "postal", started = 20 } = {}) =>
    (await db.query(`INSERT INTO mailboxes (domain_id, email, local_part, display_name, status, daily_limit, warmup_stage, provider, workspace_id, market_daily_limit, warmup_started_at) VALUES ($1,$2,$3,$4,'Active',20,'Steady State',$5,$6,1000,$7) RETURNING id`, [domainId, `${local}@${domain}`, local, `Person ${local}`, provider, ws, started === null ? null : daysAgo(started)])).rows[0].id;
  const sendable = async (campaign = {}) => (await campaignSend.getSendableMailboxes({ workspace_id: ws, mailbox_mode: "all", is_warmup: false, ...campaign })).map((m) => m.email);

  console.log("[1] the daily cap for a sending IP");
  await check("starts small and rises with the IP's age, up to a ceiling", () => {
    assert.equal(campaignSend.ipDailyCap(0), 10);
    assert.equal(campaignSend.ipDailyCap(5), 20);
    assert.equal(campaignSend.ipDailyCap(25), 60);
    assert.equal(campaignSend.ipDailyCap(400), 60);
  });

  console.log("[2] readiness gate for Postal mailboxes");
  const dOk = await mkDomain(`ok-${stamp}.example`), dBadDkim = await mkDomain(`dkim-${stamp}.example`, { dkim: "Failed" }), dNoDmarc = await mkDomain(`dmarc-${stamp}.example`, { dmarc: "Failed" }), dMd = await mkDomain(`md-${stamp}.example`, { provider: "Maildoso" });
  await mkBox(dOk, "mature", `ok-${stamp}.example`, { started: 20 });
  await mkBox(dOk, "young", `ok-${stamp}.example`, { started: 3 });
  await mkBox(dOk, "never", `ok-${stamp}.example`, { started: null });
  await mkBox(dBadDkim, "mature", `dkim-${stamp}.example`, { started: 30 });
  await mkBox(dNoDmarc, "mature", `dmarc-${stamp}.example`, { started: 30 });
  await mkBox(dMd, "young", `md-${stamp}.example`, { provider: "maildoso", started: 1 });
  await check("campaign mail: only mailboxes with verified DNS (incl. DKIM and DMARC) and 14+ warm days are allowed", async () => {
    const got = await sendable();
    assert.deepEqual(got.filter((e) => e.endsWith(`ok-${stamp}.example`)), [`mature@ok-${stamp}.example`]);
    assert.ok(!got.includes(`mature@dkim-${stamp}.example`), "failed DKIM must block");
    assert.ok(!got.includes(`mature@dmarc-${stamp}.example`), "failed DMARC must block");
  });
  await check("a mailbox that never started warming up is blocked", async () => assert.ok(!(await sendable()).includes(`never@ok-${stamp}.example`)));
  await check("other providers (Maildoso) are not held by the Postal gate", async () => assert.ok((await sendable()).includes(`young@md-${stamp}.example`)));
  await check("warm-up mail is never gated, or nothing could ever warm up", async () => {
    const got = await sendable({ is_warmup: true });
    assert.ok(got.includes(`young@ok-${stamp}.example`) && got.includes(`mature@dkim-${stamp}.example`));
  });
  await check("the minimum is adjustable (POSTAL_MIN_WARMUP_DAYS)", async () => {
    process.env.POSTAL_MIN_WARMUP_DAYS = "2";
    try { assert.ok((await sendable()).includes(`young@ok-${stamp}.example`)); } finally { delete process.env.POSTAL_MIN_WARMUP_DAYS; }
  });

  console.log("[3] per-IP daily cap on campaign sends");
  const ipNew = await mkIp(`10.99.${stamp % 200}.1`, 0), ipOld = await mkIp(`10.99.${stamp % 200}.2`, 10);
  const dA = await mkDomain(`ipa-${stamp}.example`, { ipId: ipNew }), dB = await mkDomain(`ipb-${stamp}.example`, { ipId: ipOld });
  const boxesA = [], boxesB = [];
  for (const l of ["a1", "a2", "a3", "a4"]) boxesA.push(await mkBox(dA, l, `ipa-${stamp}.example`));
  for (const l of ["b1", "b2", "b3", "b4"]) boxesB.push(await mkBox(dB, l, `ipb-${stamp}.example`));
  const camp = (await db.query(`INSERT INTO campaigns (name, subject, body, workspace_id, status, mailbox_mode, mailbox_ids, window_start, window_end, timezone) VALUES ('cap test','s','Hi',$1,'Active','specific',$2,'00:00','23:59','UTC') RETURNING *`, [ws, [...boxesA, ...boxesB]])).rows[0];
  for (let i = 0; i < 90; i++) await db.query(`INSERT INTO campaign_leads (campaign_id, email, workspace_id) VALUES ($1,$2,$3)`, [camp.id, `lead${i}-${stamp}@target.example`, ws]);
  sent = [];
  for (let tick = 0; tick < 40; tick++) await campaignSend.tickCampaign((await db.query(`SELECT * FROM campaigns WHERE id = $1`, [camp.id])).rows[0]);
  const fromDomain = (d) => sent.filter((s) => s.from.endsWith(`@${d}`)).length;
  await check("a brand-new IP stops at its day-0 cap (10), even with 4 mailboxes ready to send", () => assert.equal(fromDomain(`ipa-${stamp}.example`), 10));
  await check("a 10-day-old IP gets a higher cap (30)", () => assert.equal(fromDomain(`ipb-${stamp}.example`), 30));
  await check("the cap counts what was really sent today (re-running sends nothing more)", async () => {
    const before = sent.length;
    for (let tick = 0; tick < 5; tick++) await campaignSend.tickCampaign((await db.query(`SELECT * FROM campaigns WHERE id = $1`, [camp.id])).rows[0]);
    assert.equal(sent.length, before);
  });

  console.log("[4] bounce events for return-path addresses");
  const domainName = `ev-${stamp}.example`;
  const dEv = await mkDomain(domainName);
  await mkBox(dEv, "sender", domainName);
  await check("an event about our own return-path address is ignored quietly", async () => {
    const r = await postalEvents.handleEvent({ event: "MessageDeliveryFailed", payload: { status: "HardFail", message: { to: `abc123@psrp.${domainName}`, id: 1 }, output: "550" } });
    assert.equal(r.status, "Ignored");
  });
  await check("a real hard bounce is matched to its workspace through the psrp envelope sender and suppresses the recipient", async () => {
    const r = await postalEvents.handleEvent({ event: "MessageDeliveryFailed", payload: { status: "HardFail", message: { to: `gone-${stamp}@target.example`, id: 2, mail_from: `abc123@psrp.${domainName}`, from: null }, output: "550 no such user" } });
    assert.equal(r.status, "Processed");
    const { rows } = await db.query(`SELECT workspace_id, reason FROM suppressions WHERE email = $1`, [`gone-${stamp}@target.example`]);
    assert.equal(rows[0]?.workspace_id, ws);
    assert.equal(rows[0]?.reason, "hard_bounce");
  });

  await db.query(`DELETE FROM workspaces WHERE id = $1`, [ws]).catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
