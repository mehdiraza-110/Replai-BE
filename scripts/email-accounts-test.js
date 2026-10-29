// Verifies the Email Accounts service in the LOCAL sandbox: health score, account types, filters, paging, pause/resume
// rules, domains and the 500-domain bulk registration (database only, nothing is sent anywhere).
// Run from the workspace root:  ./dev-local.sh node scripts/email-accounts-test.js
const BE = require("path").resolve(__dirname, "..");
const assert = require("assert");
const db = require(`${BE}/config/db.config`);
const svc = require(`${BE}/services/emailAccounts.service`);

let pass = 0, fail = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log("  PASS", name); }, (e) => { fail++; console.log("  FAIL", name, "->", e.message); });
const stamp = Date.now();
const base = { status: "Active", reputation_status: "Healthy", domain_bounce_rate: 0, domain_complaint_rate: 0, domain_status: "Verified", spf_status: "Success", dkim_status: "Success", dmarc_status: "Success", wn_pause_reason: null, wn_consecutive_failures: 0 };

(async () => {
  console.log("\n[1] health score (pure)");
  await check("a clean inbox scores 100 with no reasons", () => { const h = svc.healthOf(base); assert.equal(h.score, 100); assert.deepEqual(h.reasons, []); assert.equal(h.label, "Excellent"); });
  await check("missing signals cost nothing (null rates)", () => assert.equal(svc.healthOf({ ...base, domain_bounce_rate: null, domain_complaint_rate: null }).score, 100));
  await check("bounce rate tiers: 1% -8, 2% -20, 5% -35", () => { assert.equal(svc.healthOf({ ...base, domain_bounce_rate: 1 }).score, 92); assert.equal(svc.healthOf({ ...base, domain_bounce_rate: 2.5 }).score, 80); assert.equal(svc.healthOf({ ...base, domain_bounce_rate: 5 }).score, 65); assert.equal(svc.healthOf({ ...base, domain_bounce_rate: 0.9 }).score, 100); });
  await check("complaint rate tiers: 0.1% -15, 0.3% -35", () => { assert.equal(svc.healthOf({ ...base, domain_complaint_rate: 0.1 }).score, 85); assert.equal(svc.healthOf({ ...base, domain_complaint_rate: 0.3 }).score, 65); });
  await check("error state, reputation, unverified domain, failing auth, paused/failing warm-up", () => {
    assert.equal(svc.healthOf({ ...base, status: "Error" }).score, 50);
    assert.equal(svc.healthOf({ ...base, reputation_status: "At Risk" }).score, 70);
    assert.equal(svc.healthOf({ ...base, reputation_status: "Watch" }).score, 88);
    assert.equal(svc.healthOf({ ...base, domain_status: "Pending Verification" }).score, 70);
    assert.equal(svc.healthOf({ ...base, spf_status: "Failed", dkim_status: "Pending" }).score, 80);
    assert.equal(svc.healthOf({ ...base, wn_pause_reason: "bounced" }).score, 85);
    assert.equal(svc.healthOf({ ...base, wn_consecutive_failures: 3 }).score, 85);
    assert.equal(svc.healthOf({ ...base, wn_consecutive_failures: 2 }).score, 100);
  });
  await check("penalties stack but the score never goes below 0, and every reason is listed", () => { const h = svc.healthOf({ ...base, status: "Error", reputation_status: "At Risk", domain_bounce_rate: 9, domain_complaint_rate: 1, domain_status: "Failed" }); assert.equal(h.score, 0); assert.equal(h.reasons.length, 5); assert.equal(h.label, "Poor"); });

  console.log("\n[2] account type (pure)");
  await check("own-server inboxes by warm-up state; Maildoso is pre-warmed; others external", () => {
    assert.equal(svc.typeOf({ provider: "postal", wn_state: "ready" }).kind, "warmed");
    assert.equal(svc.typeOf({ provider: "postal", wn_state: "released" }).kind, "warmed");
    assert.equal(svc.typeOf({ provider: "postal", wn_state: "warming" }).label, "Warming up");
    assert.equal(svc.typeOf({ provider: "postal", wn_state: "queued" }).kind, "queued");
    assert.equal(svc.typeOf({ provider: "postal", wn_state: "paused" }).kind, "paused");
    assert.equal(svc.typeOf({ provider: "Maildoso" }).label, "Pre-warmed");
    assert.equal(svc.typeOf({ provider: "SES" }).kind, "external");
  });

  console.log("\n[3] listing, filters, sorting, paging");
  const ws = (await db.query(`INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id`, [`Inboxes ${stamp}`, `inboxes-${stamp}`])).rows[0].id;
  const other = (await db.query(`INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id`, [`Inboxes other ${stamp}`, `inboxes-o-${stamp}`])).rows[0].id;
  const dom = async (name, props = {}, workspace = ws) => (await db.query(`INSERT INTO domains (domain, status, provider, workspace_id, spf_status, dkim_status, dmarc_status, bounce_rate, complaint_rate) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`, [`${name}${stamp}.invalid`, props.status || "Verified", props.provider || "Postal", workspace, props.spf || "Success", props.dkim || "Success", props.dmarc || "Success", props.bounce ?? 0, props.complaint ?? 0])).rows[0].id;
  const box = async (domainId, local, props = {}, workspace = ws) => { const id = (await db.query(`INSERT INTO mailboxes (domain_id, email, local_part, display_name, status, daily_limit, sent_today, provider, reputation_status, workspace_id, is_deleted) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`, [domainId, `${local}@d${domainId}.invalid`, local, props.name || local, props.status || "Active", props.limit ?? 30, props.sent ?? 0, props.provider || "postal", props.reputation || "Healthy", workspace, props.deleted || false])).rows[0].id; if (props.wn) await db.query(`INSERT INTO warmnet_mailboxes (mailbox_id, state, total_sent, ramp_day, pause_reason, consecutive_failures) VALUES ($1, $2, $3, $4, $5, $6)`, [id, props.wn, props.wnSent ?? 0, props.ramp ?? 1, props.pause || null, props.fails || 0]); return id; };
  const dGood = await dom("good"); const dBad = await dom("bad", { bounce: 6, complaint: 0.4 }); const dMd = await dom("md", { provider: "Maildoso" }); const dPending = await dom("pend", { status: "Pending Verification", spf: "Pending" });
  const ids = {
    ready: await box(dGood, "ready", { wn: "ready", wnSent: 480, sent: 12, name: "Ann Ready" }),
    warming: await box(dGood, "warming", { wn: "warming", wnSent: 90, ramp: 7, status: "Paused", limit: 0 }),
    queued: await box(dGood, "queued", { wn: "queued", status: "Paused", limit: 0 }),
    bad: await box(dBad, "bad", { wn: "ready", wnSent: 300, name: "Bob Bounce" }),
    md: await box(dMd, "md", { provider: "Maildoso", sent: 20 }),
    err: await box(dGood, "err", { status: "Error", provider: "SES" }),
    pend: await box(dPending, "pend", { provider: "SES" }),
    deleted: await box(dGood, "gone", { deleted: true }),
    theirs: await box(await dom("other", {}, other), "theirs", {}, other),
  };
  const all = await svc.listInboxes(ws, {});
  await check("lists this workspace's live inboxes only (no deleted, no other workspace)", () => { assert.equal(all.total, 7); assert.ok(!all.items.some((i) => i.email.startsWith("gone@") || i.email.startsWith("theirs@"))); });
  await check("each row carries name, sent/limit, warm-up count, health and type", () => { const r = all.items.find((i) => i.id === ids.ready); assert.deepEqual([r.name, r.sentToday, r.dailyLimit, r.warmupSent, r.health.score, r.accountType.kind], ["Ann Ready", 12, 30, 480, 100, "warmed"]); const b = all.items.find((i) => i.id === ids.bad); assert.equal(b.health.score, 30); assert.equal(all.items.find((i) => i.id === ids.pend).health.score, 60); });
  await check("summary counts and average health", () => { assert.deepEqual([all.summary.total, all.summary.active, all.summary.paused, all.summary.error, all.summary.warming], [7, 4, 2, 1, 2]); assert.ok(all.summary.needAttention >= 3); assert.equal(typeof all.summary.averageHealth, "number"); });
  await check("filters: status, type, health, search by email and by name", async () => {
    assert.equal((await svc.listInboxes(ws, { status: "Paused" })).total, 2);
    assert.equal((await svc.listInboxes(ws, { type: "warmed" })).total, 2);
    assert.equal((await svc.listInboxes(ws, { type: "prewarmed" })).total, 1);
    assert.ok((await svc.listInboxes(ws, { health: "attention" })).items.every((i) => i.health.score < 75));
    assert.ok((await svc.listInboxes(ws, { health: "healthy" })).items.every((i) => i.health.score >= 75));
    assert.equal((await svc.listInboxes(ws, { search: "bob bounce" })).total, 1);
    assert.equal((await svc.listInboxes(ws, { search: "READY@" })).total, 1);
  });
  await check("sorting by health, both directions; stable ties", async () => { const asc = await svc.listInboxes(ws, { sort: "health", dir: "asc" }); const desc = await svc.listInboxes(ws, { sort: "health", dir: "desc" }); assert.equal(asc.items[0].health.score, Math.min(...all.items.map((i) => i.health.score))); assert.equal(desc.items[0].health.score, Math.max(...all.items.map((i) => i.health.score))); const again = await svc.listInboxes(ws, { sort: "health", dir: "asc" }); assert.deepEqual(asc.items.map((i) => i.id), again.items.map((i) => i.id)); });
  await check("paging", async () => { const p = await svc.listInboxes(ws, { limit: 3, page: 3 }); assert.equal(p.items.length, 1); assert.equal(p.totalPages, 3); });
  await check("bad filters and sorts are rejected", async () => { await assert.rejects(() => svc.listInboxes(ws, { status: "x" }), /status/i); await assert.rejects(() => svc.listInboxes(ws, { sort: "password" }), /sort/i); await assert.rejects(() => svc.listInboxes(ws, { health: "?" }), /health/i); });

  console.log("\n[4] pause, resume, rename");
  await check("pausing an active inbox works", async () => { const r = await svc.updateInbox(ws, ids.ready, { status: "Paused" }); assert.equal(r.status, "Paused"); });
  await check("resuming a healthy paused inbox works", async () => { const r = await svc.updateInbox(ws, ids.ready, { status: "Active" }); assert.equal(r.status, "Active"); });
  await check("an inbox still warming up cannot be resumed by hand (would skip the ramp)", () => assert.rejects(() => svc.updateInbox(ws, ids.warming, { status: "Active" }), /still warming/));
  await check("an errored inbox and one on an unverified domain cannot be resumed", async () => { await assert.rejects(() => svc.updateInbox(ws, ids.err, { status: "Active" }), /error state/); await db.query(`UPDATE mailboxes SET status='Paused' WHERE id=$1`, [ids.pend]); await assert.rejects(() => svc.updateInbox(ws, ids.pend, { status: "Active" }), /not verified/); });
  await check("only Active or Paused may be set; rename needs a name; nothing-to-change is refused", async () => { await assert.rejects(() => svc.updateInbox(ws, ids.ready, { status: "Error" }), /Active or Paused/); await assert.rejects(() => svc.updateInbox(ws, ids.ready, { displayName: "   " }), /name/i); await assert.rejects(() => svc.updateInbox(ws, ids.ready, {}), /Nothing/); assert.equal((await svc.updateInbox(ws, ids.ready, { displayName: "Ann Renamed" })).name, "Ann Renamed"); });
  await check("cannot touch another workspace's inbox, or a bad id", async () => { await assert.rejects(() => svc.updateInbox(ws, ids.theirs, { status: "Paused" }), /not found/i); await assert.rejects(() => svc.updateInbox(ws, "abc", { status: "Paused" }), /not found/i); assert.equal((await db.query(`SELECT status FROM mailboxes WHERE id=$1`, [ids.theirs])).rows[0].status, "Active"); });

  console.log("\n[5] domains");
  await check("domains list with inbox counts and authentication", async () => { const d = await svc.listDomains(ws, {}); assert.equal(d.total, 4); const good = d.items.find((x) => x.domain.startsWith("good")); assert.deepEqual([good.inboxes, good.warmingInboxes], [4, 2]); const bad = d.items.find((x) => x.domain.startsWith("bad")); assert.deepEqual([bad.bounceRate, bad.complaintRate], [6, 0.4]); assert.equal(d.items.find((x) => x.domain.startsWith("pend")).spf, "Pending"); });
  await check("domain search and status filter; literal % and _ are not wildcards", async () => { assert.equal((await svc.listDomains(ws, { search: "good" })).total, 1); assert.equal((await svc.listDomains(ws, { status: "Pending Verification" })).total, 1); assert.equal((await svc.listDomains(ws, { search: "%" })).total, 0); assert.equal((await svc.listDomains(ws, { search: "_" })).total, 0); });

  console.log("\n[6] scale: 1,500 inboxes");
  const big = (await db.query(`INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id`, [`Inboxes big ${stamp}`, `inboxes-big-${stamp}`])).rows[0].id;
  await db.query(`INSERT INTO domains (domain, status, provider, workspace_id, spf_status, dkim_status, dmarc_status) SELECT 'big' || g || '-${stamp}.invalid', 'Verified', 'Postal', $1, 'Success', 'Success', 'Success' FROM generate_series(1, 500) g`, [big]);
  await db.query(`INSERT INTO mailboxes (domain_id, email, local_part, display_name, status, daily_limit, provider, workspace_id) SELECT d.id, 'u' || n || '@' || d.domain, 'u' || n, 'User ' || n, 'Active', 30, 'postal', $1 FROM domains d, generate_series(1, 3) n WHERE d.workspace_id = $1`, [big]);
  await check("1,500 inboxes list, sort by health and page in under a second", async () => { const t = Date.now(); const r = await svc.listInboxes(big, { sort: "health", limit: 50 }); const ms = Date.now() - t; assert.equal(r.total, 1500); assert.equal(r.items.length, 50); assert.ok(ms < 1000, `took ${ms}ms`); console.log(`         (${ms} ms)`); });
  await check("500 domains list pages correctly", async () => { const r = await svc.listDomains(big, { limit: 200, page: 3 }); assert.equal(r.total, 500); assert.equal(r.items.length, 100); });

  console.log("\n[7] bulk registration (database only)");
  const target = (await db.query(`INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id`, [`Bulk ${stamp}`, `bulk-${stamp}`])).rows[0].id;
  const mk = (n, tag) => Array.from({ length: n }, (_, i) => `${tag}${i}-${stamp}.invalid`);
  await check("refuses an empty list and more than 500", async () => { await assert.rejects(() => svc.bulkRegisterDomains(null, { domains: [], workspaceId: target }), /at least one/i); await assert.rejects(() => svc.bulkRegisterDomains(null, { domains: mk(501, "toomany"), workspaceId: target }), /at most 500/); });
  await check("invalid, duplicate and already-taken domains fail individually; the rest register", async () => {
    await svc.bulkRegisterDomains(null, { domains: [`taken-${stamp}.invalid`], workspaceId: target, mailboxesPerDomain: 2 });
    const r = await svc.bulkRegisterDomains(null, { domains: [`ok1-${stamp}.invalid`, `OK1-${stamp}.invalid`, "not a domain", `taken-${stamp}.invalid`, `ok2-${stamp}.invalid`], workspaceId: target, mailboxesPerDomain: 2 });
    assert.equal(r.requested, 4); assert.equal(r.registered, 2); assert.equal(r.failed, 2); assert.equal(r.inboxesCreated, 4);
    assert.match(r.results.find((x) => x.domain.startsWith("taken")).error, /already in the system/);
    assert.ok(r.results.some((x) => x.domain === "not a domain" && !x.ok));
  });
  await check("registered inboxes are queued for warm-up, paused, on the own server, in the right workspace", async () => { const { rows } = await db.query(`SELECT m.status, m.provider, m.daily_limit, m.workspace_id, w.state FROM mailboxes m JOIN warmnet_mailboxes w ON w.mailbox_id = m.id JOIN domains d ON d.id = m.domain_id WHERE d.domain = $1`, [`ok1-${stamp}.invalid`]); assert.equal(rows.length, 2); rows.forEach((r) => assert.deepEqual([r.status, r.provider, r.daily_limit, r.workspace_id, r.state], ["Paused", "postal", 0, target, "queued"])); });
  await check("autoStart begins warming immediately", async () => { await svc.bulkRegisterDomains(null, { domains: [`auto-${stamp}.invalid`], workspaceId: target, mailboxesPerDomain: 1, autoStart: true }); const { rows } = await db.query(`SELECT w.state FROM warmnet_mailboxes w JOIN mailboxes m ON m.id = w.mailbox_id JOIN domains d ON d.id = m.domain_id WHERE d.domain = $1`, [`auto-${stamp}.invalid`]); assert.equal(rows[0].state, "warming"); });
  await check("320 domains go through in three chunks and every one registers (inbox names stay unique)", async () => {
    const t = Date.now(); const r = await svc.bulkRegisterDomains(null, { domains: mk(320, "chunk"), workspaceId: target, mailboxesPerDomain: 5 });
    console.log(`         (${Date.now() - t} ms)`);
    assert.equal(r.registered, 320, `registered ${r.registered}: ${JSON.stringify(r.results.find((x) => !x.ok))}`); assert.equal(r.inboxesCreated, 1600);
    const { rows } = await db.query(`SELECT COUNT(DISTINCT display_name)::int AS names, COUNT(*)::int AS total FROM mailboxes WHERE workspace_id = $1`, [target]); assert.equal(rows[0].names, rows[0].total, `${rows[0].names} distinct names for ${rows[0].total} inboxes`);
  });
  await check("a workspace that does not exist fails every domain cleanly instead of throwing", async () => { const r = await svc.bulkRegisterDomains(null, { domains: [`nows-${stamp}.invalid`], workspaceId: 99999999 }); assert.equal(r.registered, 0); assert.equal(r.failed, 1); assert.match(r.results[0].error, /could not be found/); });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
