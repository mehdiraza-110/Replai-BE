// Verifies the admin Domains list warm-up columns, filters and sorting in the LOCAL sandbox (database only).
// Run from the workspace root:  ./dev-local.sh node scripts/domain-readiness-test.js
const BE = require("path").resolve(__dirname, "..");
const assert = require("assert");
const db = require(`${BE}/config/db.config`);
const svc = require(`${BE}/services/adminDomains.service`);

let pass = 0, fail = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log("  PASS", name); }, (e) => { fail++; console.log("  FAIL", name, "->", e.message); });
const stamp = Date.now();
const day = (n) => new Date(Date.now() - n * 86400000);

(async () => {
  const ws = (await db.query(`INSERT INTO workspaces (name, slug) VALUES ($1,$2) RETURNING id`, [`Ready ${stamp}`, `ready-${stamp}`])).rows[0].id;
  const seed = (await db.query(`INSERT INTO warmnet_seeds (email, display_name, provider, imap_host, smtp_host, username, password_encrypted) VALUES ($1,'S','gmail','i','s',$1,'x') RETURNING id`, [`seed-${stamp}@x.invalid`])).rows[0].id;
  const ids = { domains: [], mailboxes: [] };
  // name, provider, dns ok, [mailbox states], inbox/placed in last 5 days, ramp day, warmup age days
  const mk = async (name, provider, dnsOk, states, inbox, placed, ramp, age) => {
    const d = (await db.query(`INSERT INTO domains (domain, registrar, dns_provider, provider, status, spf_status, dkim_status, dmarc_status, mx_status, workspace_id) VALUES ($1,'P','P',$2,'Verified','Success',$3,'Success','Success',$4) RETURNING id`, [`${name}-${stamp}.invalid`, provider, dnsOk ? "Success" : "Pending", ws])).rows[0].id;
    ids.domains.push(d);
    for (let i = 0; i < states.length; i++) {
      const m = (await db.query(`INSERT INTO mailboxes (domain_id, email, local_part, display_name, status, daily_limit, warmup_stage, provider, workspace_id, market_daily_limit, warmup_started_at) VALUES ($1,$2,$3,'P','Active',10,'Steady State',$4,$5,100,$6) RETURNING id`, [d, `u${i}@${name}-${stamp}.invalid`, `u${i}`, provider, ws, age == null ? null : day(age)])).rows[0].id;
      ids.mailboxes.push(m);
      if (states[i]) await db.query(`INSERT INTO warmnet_mailboxes (mailbox_id, state, ramp_day, started_at) VALUES ($1,$2,$3,$4)`, [m, states[i], ramp, day(ramp)]);
      if (i === 0) for (let k = 0; k < placed; k++) await db.query(`INSERT INTO warmnet_messages (mailbox_id, seed_id, direction, kind, thread_key, rfc_message_id, subject, status, placement, sent_at) VALUES ($1,$2,'to_seed','initial',$3,$4,'x','sent',$5, NOW() - INTERVAL '1 day')`, [m, seed, `t${m}${k}`.slice(0, 60), `<${m}-${k}-${stamp}@t>`, k < inbox ? "inbox" : "spam"]);
    }
    return d;
  };
  const only = (q) => svc.list({ workspaceId: ws, limit: 100, ...q }).then((r) => r.items.map((i) => i.domain.replace(`-${stamp}.invalid`, "")));
  try {
    await mk("great", "postal", true, ["ready", "ready"], 24, 25, 9, 16);   // ready, 96%, sendable (postal, DNS ok, 16d)
    await mk("almost", "postal", true, ["warming"], 18, 25, 6, 6);          // warming, 72%, not sendable yet (6d < 14d)
    await mk("weak", "postal", true, ["warming"], 10, 25, 4, 4);            // warming, 40%
    await mk("held", "postal", true, ["paused"], 5, 10, 3, 3);              // paused
    await mk("fresh", "maildoso", true, [null], 0, 0, 0, null);             // not enrolled; maildoso is sendable
    await mk("nodns", "postal", false, ["ready"], 20, 20, 9, 16);           // ready but DNS failing: not sendable
    await mk("partial", "postal", true, ["ready", "warming"], 20, 25, 8, 10); // one of two ready

    const all = await svc.list({ workspaceId: ws, limit: 100 });
    const by = Object.fromEntries(all.items.map((i) => [i.domain.replace(`-${stamp}.invalid`, ""), i.warmnet]));
    console.log("numbers");
    await check("states per domain", () => { assert.equal(by.great.state, "ready"); assert.equal(by.almost.state, "warming"); assert.equal(by.held.state, "paused"); assert.equal(by.fresh.state, "not_started"); assert.equal(by.partial.state, "warming"); assert.equal(by.partial.ready, 1); assert.equal(by.partial.enrolled, 2); });
    await check("inbox rate and sample size", () => { assert.equal(Math.round(by.great.inbox_rate_5d * 100), 96); assert.equal(by.great.placed_5d, 25); assert.equal(by.fresh.inbox_rate_5d, null); assert.equal(by.almost.ramp_day, 6); });
    await check("sendable counts the campaign gates", () => { assert.equal(by.great.sendable_mailboxes, 2); assert.equal(by.almost.sendable_mailboxes, 0); assert.equal(by.nodns.sendable_mailboxes, 0); assert.equal(by.fresh.sendable_mailboxes, 1); });
    await check("counts match across list and detail", async () => { const g = all.items.find((i) => i.domain.startsWith("great-")); const det = await svc.get(g.id); assert.equal(det.warmnet.state, "ready"); assert.equal(det.mailboxes.length, 2); assert.equal(det.mailboxes[0].warmnet_state, "ready"); assert.equal(Math.round(det.mailboxes[0].warmnet_inbox_rate_5d * 100), 96); });

    console.log("filters and sorting");
    await check("ready filter", async () => assert.deepEqual((await only({ readiness: "ready" })).sort(), ["great", "nodns"]));
    await check("warming filter", async () => assert.deepEqual((await only({ readiness: "warming" })).sort(), ["almost", "partial", "weak"]));
    await check("not started and paused filters", async () => { assert.deepEqual(await only({ readiness: "not_started" }), ["fresh"]); assert.deepEqual(await only({ readiness: "paused" }), ["held"]); });
    await check("minimum inbox rate", async () => { assert.deepEqual((await only({ minInbox: "70" })).sort(), ["almost", "great", "nodns", "partial"]); assert.deepEqual((await only({ minInbox: "95" })).sort(), ["great", "nodns"]); });
    await check("filters combine", async () => assert.deepEqual(await only({ readiness: "warming", minInbox: "70", sort: "inbox" }), ["partial", "almost"]));
    await check("can send now", async () => assert.deepEqual((await only({ canSend: "1" })).sort(), ["fresh", "great"]));
    await check("sort by inbox rate puts best first, unknown last", async () => { const o = await only({ sort: "inbox" }); assert.deepEqual(o.slice(0, 2), ["nodns", "great"]); assert.equal(o[o.length - 1], "fresh"); });
    await check("sort by warm-up days", async () => { const o = await only({ sort: "days" }); assert.deepEqual(o.slice(0, 2).sort(), ["great", "nodns"]); });
    await check("total matches the filter, not the page", async () => { const r = await svc.list({ workspaceId: ws, readiness: "ready", limit: 1 }); assert.equal(r.total, 2); assert.equal(r.items.length, 1); });
    await check("bad values are rejected", async () => { await assert.rejects(() => svc.list({ readiness: "nope" }), /Unknown warm-up filter/); await assert.rejects(() => svc.list({ minInbox: "150" }), /between 0 and 100/); });
  } finally {
    await db.query(`DELETE FROM warmnet_messages WHERE seed_id = $1`, [seed]);
    await db.query(`DELETE FROM warmnet_seeds WHERE id = $1`, [seed]);
    await db.query(`DELETE FROM warmnet_mailboxes WHERE mailbox_id = ANY($1::int[])`, [ids.mailboxes]);
    await db.query(`DELETE FROM mailboxes WHERE id = ANY($1::int[])`, [ids.mailboxes]);
    await db.query(`DELETE FROM domains WHERE id = ANY($1::int[])`, [ids.domains]);
    await db.query(`DELETE FROM workspaces WHERE id = $1`, [ws]);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
