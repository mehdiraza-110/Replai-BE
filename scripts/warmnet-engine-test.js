// Verifies the warm-up engine (ramp, daily caps, seed limits, blocklisted IPs, failures, hold, ready) and the background
// re-check of Postal domains in the LOCAL sandbox. The sender is stubbed: nothing is sent anywhere.
//   ./dev-local.sh node scripts/warmnet-engine-test.js
const BE = require("path").resolve(__dirname, "..");
const assert = require("assert");
const mailTransport = require(`${BE}/services/mailTransport.service`);
let sent = [], failWith = null;
mailTransport.sendRawEmail = async ({ mailbox, to }) => { if (failWith) throw new Error(failWith); sent.push({ from: mailbox.email, to }); return "id"; };
const db = require(`${BE}/config/db.config`);
const engine = require(`${BE}/services/warmnetEngine.service`);
const domainService = require(`${BE}/services/domain.service`);
const postalDns = require(`${BE}/services/postalDns.service`);
const postalAdmin = require(`${BE}/services/postalAdmin.service`);

let pass = 0, fail = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log("  PASS", name); }, (e) => { fail++; console.log("  FAIL", name, "->", e.message); });
const stamp = Date.now();
const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

(async () => {
  const before = (await db.query(`SELECT enabled, config FROM warmnet_settings WHERE id = 1`)).rows[0];
  const ws = (await db.query(`INSERT INTO workspaces (name, slug) VALUES ($1,$2) RETURNING id`, [`Warm ${stamp}`, `warm-${stamp}`])).rows[0].id;
  const mkIp = async (ip, clean) => (await db.query(`INSERT INTO warmnet_ips (ip, clean) VALUES ($1,$2) RETURNING id`, [ip, clean])).rows[0].id;
  const mkDomain = async (name, { status = "Verified", ipId = null, provider = "Postal" } = {}) => {
    const d = (await db.query(`INSERT INTO domains (domain, registrar, dns_provider, provider, status, spf_status, dkim_status, dmarc_status, mx_status, workspace_id) VALUES ($1,'Porkbun','Porkbun',$2,$3,'Success','Success','Success','Success',$4) RETURNING id`, [name, provider, status, ws])).rows[0].id;
    await db.query(`INSERT INTO warmnet_domains (domain_id, ip_id) VALUES ($1,$2)`, [d, ipId]);
    return d;
  };
  const mkBox = async (domainId, local, domain, { state = "warming", ramp = 1, today = null, started = day(1), mbStatus = "Paused" } = {}) => {
    const id = (await db.query(`INSERT INTO mailboxes (domain_id, email, local_part, display_name, status, daily_limit, warmup_stage, provider, workspace_id, market_daily_limit) VALUES ($1,$2,$3,$4,$5,0,'Paused','postal',$6,0) RETURNING id`, [domainId, `${local}@${domain}`, local, `Person ${local}`, mbStatus, ws])).rows[0].id;
    await db.query(`INSERT INTO warmnet_mailboxes (mailbox_id, state, ramp_day, started_at, today_date) VALUES ($1,$2,$3,$4,$5)`, [id, state, ramp, started, today]);
    return id;
  };
  const mkSeed = async (email, cap) => (await db.query(`INSERT INTO warmnet_seeds (email, display_name, provider, imap_host, smtp_host, username, password_encrypted, daily_receive_cap) VALUES ($1,'Seed Person','gmail','imap.example','smtp.example',$1,'x',$2) RETURNING id`, [email, cap])).rows[0].id;
  const place = async (box, seed, n, inbox) => { for (let i = 0; i < n; i++) await db.query(`INSERT INTO warmnet_messages (mailbox_id, seed_id, direction, kind, thread_key, rfc_message_id, subject, status, placement, sent_at) VALUES ($1,$2,'to_seed','initial',$3,$4,'x','sent',$5, NOW() - INTERVAL '2 days')`, [box, seed, `t${box}${i}${Math.random()}`.slice(0, 60), `<${box}-${i}-${stamp}-${Math.random()}@t>`, i < inbox ? "inbox" : "spam"]); };

  await db.query(`UPDATE warmnet_settings SET enabled = TRUE, config = '{}'::jsonb WHERE id = 1`);
  const settings = await engine.getSettings();
  const local = engine.localParts(settings.timezone);
  const progress = () => Math.min(1, Math.max(0, (engine.localParts(settings.timezone).hours - settings.windowStartHour) / (settings.windowEndHour - settings.windowStartHour)) + 0.08);
  const tickAll = async () => { for (let i = 0; i < 40; i++) { const r = await engine.runTick({ force: true }); if (!r.sent && !r.failed) break; } };

  const cleanIp = await mkIp(`10.${stamp % 200}.1.1`, true), dirtyIp = await mkIp(`10.${stamp % 200}.1.2`, false);
  const good = `good-${stamp}.example`, bad = `bad-${stamp}.example`, pend = `pend-${stamp}.example`;
  const dGood = await mkDomain(good, { ipId: cleanIp }), dBad = await mkDomain(bad, { ipId: dirtyIp }), dPend = await mkDomain(pend, { status: "Pending Verification", ipId: cleanIp });
  const s1 = await mkSeed(`s1-${stamp}@seed.example`, 4), s2 = await mkSeed(`s2-${stamp}@seed.example`, 500);

  console.log("\n[1] the daily ramp");
  await check("target: start 3, +1 a day, capped at 25, halved at weekends, 5 a day once released", () => {
    const wk = { weekday: "Tue" }, we = { weekday: "Sat" };
    assert.equal(engine.dailyTarget({ state: "warming", ramp_day: 1 }, settings, wk), 3); assert.equal(engine.dailyTarget({ state: "warming", ramp_day: 5 }, settings, wk), 7);
    assert.equal(engine.dailyTarget({ state: "warming", ramp_day: 60 }, settings, wk), 25); assert.equal(engine.dailyTarget({ state: "warming", ramp_day: 10 }, settings, we), Math.round(12 * 0.5));
    assert.equal(engine.dailyTarget({ state: "released", ramp_day: 60 }, settings, wk), 5);
  });

  console.log("\n[2] what gets sent");
  const bGood = await mkBox(dGood, "anna", good, { ramp: 1 }), bRamp = await mkBox(dGood, "ben", good, { ramp: 12 }), bDirty = await mkBox(dBad, "cara", bad), bPend = await mkBox(dPend, "dan", pend), bPaused = await mkBox(dGood, "eve", good, { state: "paused" });
  await check("switched off -> nothing happens", async () => {
    await db.query(`UPDATE warmnet_settings SET enabled = FALSE WHERE id = 1`); const r = await engine.runTick(); assert.equal(r.skipped, "disabled"); assert.equal(sent.length, 0);
    await db.query(`UPDATE warmnet_settings SET enabled = TRUE WHERE id = 1`);
  });
  await check("each warming mailbox sends up to its target (more on a higher ramp day), only to seeds", async () => {
    sent = []; await tickAll();
    const row = async (id) => (await db.query(`SELECT today_sent, total_sent FROM warmnet_mailboxes WHERE mailbox_id = $1`, [id])).rows[0];
    const tA = engine.dailyTarget({ state: "warming", ramp_day: 1 }, settings, local), tB = engine.dailyTarget({ state: "warming", ramp_day: 12 }, settings, local);
    assert.equal((await row(bGood)).today_sent, Math.min(tA, Math.ceil(tA * progress())), "ramp day 1"); assert.equal((await row(bRamp)).today_sent, Math.min(tB, Math.ceil(tB * progress())), "ramp day 12");
    assert.ok(tB > tA); assert.ok(sent.every((m) => /@seed\.example$/.test(m.to)), "only seed inboxes receive warm-up mail");
  });
  await check("a blocklisted IP, an unverified domain and a paused mailbox send nothing", async () => {
    for (const id of [bDirty, bPend, bPaused]) assert.equal((await db.query(`SELECT total_sent FROM warmnet_mailboxes WHERE mailbox_id = $1`, [id])).rows[0].total_sent, 0);
  });
  await check("a seed never receives more than its daily cap", async () => {
    const n = Number((await db.query(`SELECT COUNT(*) n FROM warmnet_messages WHERE seed_id = $1 AND direction = 'to_seed' AND sent_at >= date_trunc('day', NOW())`, [s1])).rows[0].n); assert.ok(n <= 4, `seed 1 got ${n}`);
  });
  await check("every send is recorded", async () => {
    const n = Number((await db.query(`SELECT COUNT(*) n FROM warmnet_messages WHERE mailbox_id = ANY($1) AND status = 'sent'`, [[bGood, bRamp]])).rows[0].n); assert.equal(n, sent.filter((m) => m.from.endsWith(`@${good}`)).length);
  });

  console.log("\n[3] failures");
  await check("failed sends are recorded; five in a row pause the mailbox with the reason", async () => {
    const d2 = await mkDomain(`fail-${stamp}.example`, { ipId: cleanIp }); const b = await mkBox(d2, "fay", `fail-${stamp}.example`, { ramp: 20 });
    failWith = "554 Blocked - Proofpoint"; for (let i = 0; i < 6; i++) await engine.runTick({ force: true }); failWith = null;
    const wm = (await db.query(`SELECT state, pause_reason, consecutive_failures FROM warmnet_mailboxes WHERE mailbox_id = $1`, [b])).rows[0];
    assert.equal(wm.state, "paused"); assert.match(wm.pause_reason, /5 failed sends in a row.*Proofpoint/);
    assert.ok(Number((await db.query(`SELECT COUNT(*) n FROM warmnet_messages WHERE mailbox_id = $1 AND status = 'failed'`, [b])).rows[0].n) >= 5);
  });

  console.log("\n[4] day roll-over: advance, hold, ready");
  const dRoll = await mkDomain(`roll-${stamp}.example`, { ipId: cleanIp });
  const mkYesterday = async (name, ramp, todaySent, extra = {}) => { const id = await mkBox(dRoll, name, `roll-${stamp}.example`, { ramp, today: day(1), ...extra }); await db.query(`UPDATE warmnet_mailboxes SET today_sent = $2 WHERE mailbox_id = $1`, [id, todaySent]); return id; };
  await check("a mailbox that hit its target moves up a day; one that didn't is held", async () => {
    const hit = await mkYesterday("hit", 4, 10), miss = await mkYesterday("miss", 4, 0);
    await engine.runTick({ force: true });
    const r = async (id) => (await db.query(`SELECT ramp_day, held_days FROM warmnet_mailboxes WHERE mailbox_id = $1`, [id])).rows[0];
    assert.deepEqual(await r(hit), { ramp_day: 5, held_days: 0 }); assert.deepEqual(await r(miss), { ramp_day: 4, held_days: 1 });
  });
  await check("poor inbox placement (under 50% over 10+ tests) holds the ramp even when the target was hit", async () => {
    const id = await mkYesterday("poor", 6, 12); await place(id, s2, 12, 3);
    await engine.runTick({ force: true }); const r = (await db.query(`SELECT ramp_day, held_days FROM warmnet_mailboxes WHERE mailbox_id = $1`, [id])).rows[0];
    assert.deepEqual(r, { ramp_day: 6, held_days: 1 });
  });
  await check("21 days, 30+ placed tests and 85%+ inbox -> ready; the same with poor placement -> not ready", async () => {
    const ok = await mkYesterday("ready", 20, 25, { started: day(22) }); await place(ok, s2, 34, 32);
    const no = await mkYesterday("notyet", 20, 25, { started: day(22) }); await place(no, s2, 34, 20);
    const young = await mkYesterday("young", 20, 25, { started: day(5) }); await place(young, s2, 34, 34);
    await engine.runTick({ force: true });
    const st = async (id) => (await db.query(`SELECT state FROM warmnet_mailboxes WHERE mailbox_id = $1`, [id])).rows[0].state;
    assert.equal(await st(ok), "ready"); assert.equal(await st(no), "warming"); assert.equal(await st(young), "warming");
  });

  console.log("\n[5] background re-check of own-server domains (stubbed DNS and mail server)");
  postalAdmin.setRunner(async () => { throw new Error("mail server not reachable in this test"); });
  const dns = { mx: true, spf: true };
  postalDns.setResolver({ resolveMx: async () => (dns.mx ? [{ priority: 10, exchange: "mta.kovalr.com" }] : [{ priority: 10, exchange: "other.net" }]), resolveTxt: async (h) => { if (h.startsWith("_dmarc")) return [["v=DMARC1; p=none;"]]; return dns.spf ? [["v=spf1 a mx include:spf.postal.kovalr.com ~all"]] : [["v=spf1 -all"]]; }, resolveCname: async () => ["rp.postal.kovalr.com"] });
  process.env.POSTAL_SSH_HOST = "x.test";
  await check("an unverified domain whose DNS is now right becomes Verified by itself, and then warm-up picks it up", async () => {
    const r = await domainService.refreshDuePostalDomains({ limit: 200, workspaceId: ws });
    assert.ok(r.checked >= 1 && r.nowVerified >= 1, JSON.stringify(r));
    assert.equal((await db.query(`SELECT status FROM domains WHERE id = $1`, [dPend])).rows[0].status, "Verified");
    sent = []; await tickAll(); assert.ok((await db.query(`SELECT total_sent FROM warmnet_mailboxes WHERE mailbox_id = $1`, [bPend])).rows[0].total_sent > 0, "the mailbox on the newly verified domain starts warming");
  });
  await check("verified domains are left alone for a day, then re-read; a removed record is noticed", async () => {
    const stamp0 = (await db.query(`SELECT last_checked_at::text t FROM domains WHERE id = $1`, [dGood])).rows[0].t;
    await domainService.refreshDuePostalDomains({ limit: 200, workspaceId: ws }); assert.equal((await db.query(`SELECT last_checked_at::text t FROM domains WHERE id = $1`, [dGood])).rows[0].t, stamp0, "a verified domain checked moments ago is not re-read");
    let r;
    await db.query(`UPDATE domains SET last_checked_at = NOW() - INTERVAL '2 days' WHERE id = $1`, [dGood]); dns.mx = false;
    r = await domainService.refreshDuePostalDomains({ limit: 200, workspaceId: ws }); assert.ok(r.checked >= 1 && r.failed >= 1, JSON.stringify(r));
    assert.equal((await db.query(`SELECT status FROM domains WHERE id = $1`, [dGood])).rows[0].status, "Failed"); dns.mx = true;
  });
  await check("a domain on Maildoso is never touched by this job", async () => {
    const m = await mkDomain(`md-${stamp}.example`, { provider: "Maildoso", status: "Pending Verification" });
    await domainService.refreshDuePostalDomains({ limit: 200, workspaceId: ws }); assert.equal((await db.query(`SELECT status FROM domains WHERE id = $1`, [m])).rows[0].status, "Pending Verification");
  });

  // cleanup
  await db.query(`UPDATE warmnet_settings SET enabled = $1, config = $2::jsonb WHERE id = 1`, [before.enabled, JSON.stringify(before.config || {})]);
  await db.query(`DELETE FROM warmnet_messages WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE workspace_id = $1)`, [ws]);
  await db.query(`DELETE FROM warmnet_mailboxes WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE workspace_id = $1)`, [ws]);
  await db.query(`DELETE FROM warmnet_domains WHERE domain_id IN (SELECT id FROM domains WHERE workspace_id = $1)`, [ws]);
  await db.query(`DELETE FROM mailboxes WHERE workspace_id = $1`, [ws]); await db.query(`DELETE FROM domains WHERE workspace_id = $1`, [ws]);
  await db.query(`DELETE FROM warmnet_seeds WHERE id = ANY($1)`, [[s1, s2]]); await db.query(`DELETE FROM warmnet_ips WHERE id = ANY($1)`, [[cleanIp, dirtyIp]]); await db.query(`DELETE FROM workspaces WHERE id = $1`, [ws]);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
