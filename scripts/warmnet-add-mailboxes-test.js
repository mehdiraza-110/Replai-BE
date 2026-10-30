// Verifies adding inboxes to a domain that is already in the warm-up network, in the LOCAL sandbox. Nothing is sent anywhere.
//   ./dev-local.sh node scripts/warmnet-add-mailboxes-test.js
const BE = require("path").resolve(__dirname, "..");
const assert = require("assert");
const db = require(`${BE}/config/db.config`);
const warmnet = require(`${BE}/services/warmnet.service`);

let pass = 0, fail = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log("  PASS", name); }, (e) => { fail++; console.log("  FAIL", name, "->", e.message); });
const stamp = Date.now();

(async () => {
  const ws = (await db.query(`INSERT INTO workspaces (name, slug) VALUES ($1,$2) RETURNING id`, [`AddBox ${stamp}`, `addbox-${stamp}`])).rows[0].id;
  const reg = await warmnet.registerDomains(1, { domains: [{ domain: `add-${stamp}.example`, ip: "10.77.0.1", hostname: "h", pool: "ip-x" }, { domain: `other-${stamp}.example` }], mailboxesPerDomain: 0, workspaceId: ws });
  const [d1, d2] = reg.results.map((r) => r.domainId);

  console.log("[1] adding inboxes");
  let first;
  await check("adds the requested number, Paused and queued (nothing starts), with unique names", async () => {
    first = await warmnet.addMailboxes(1, { domainId: d1, count: 2 });
    assert.equal(first.created, 2); assert.equal(first.total, 2);
    const { rows } = await db.query(`SELECT m.status, m.warmup_stage, m.provider, m.warmup_started_at, m.market_daily_limit, wm.state FROM mailboxes m JOIN warmnet_mailboxes wm ON wm.mailbox_id = m.id WHERE m.domain_id = $1`, [d1]);
    assert.equal(rows.length, 2);
    for (const r of rows) { assert.equal(r.status, "Paused"); assert.equal(r.warmup_stage, "Paused"); assert.equal(r.provider, "postal"); assert.equal(r.state, "queued"); assert.equal(r.warmup_started_at, null); assert.equal(r.market_daily_limit, 0); }
    assert.equal(new Set(first.mailboxes.map((m) => m.displayName)).size, 2);
    assert.ok(first.mailboxes.every((m) => m.email.endsWith(`@add-${stamp}.example`)));
  });
  await check("more can be added later, and names never repeat across the workspace", async () => {
    const second = await warmnet.addMailboxes(1, { domainId: d1, count: 3 });
    assert.equal(second.total, 5);
    const other = await warmnet.addMailboxes(1, { domainId: d2, count: 4 });
    const names = (await db.query(`SELECT display_name FROM mailboxes WHERE workspace_id = $1`, [ws])).rows.map((r) => r.display_name);
    assert.equal(new Set(names).size, names.length);
    assert.equal(other.total, 4);
  });
  await check("autoStart enrols them as warming", async () => {
    const r = await warmnet.addMailboxes(1, { domainId: d2, count: 1, autoStart: true });
    const { rows } = await db.query(`SELECT state FROM warmnet_mailboxes WHERE mailbox_id = $1`, [r.mailboxes[0].id]);
    assert.equal(rows[0].state, "warming");
  });

  console.log("[2] refusals");
  await check("at most 10 inboxes per domain (and nothing is added when over)", async () => {
    await assert.rejects(() => warmnet.addMailboxes(1, { domainId: d1, count: 6 }), /at most 10/);
    assert.equal((await db.query(`SELECT count(*)::int n FROM mailboxes WHERE domain_id = $1`, [d1])).rows[0].n, 5);
  });
  await check("bad counts and unknown domains are refused", async () => {
    for (const count of [0, -1, 11, "x"]) await assert.rejects(() => warmnet.addMailboxes(1, { domainId: d1, count }), /between 1 and 10/);
    await assert.rejects(() => warmnet.addMailboxes(1, { domainId: 99999999, count: 1 }), /isn't in the warm-up network/);
    await assert.rejects(() => warmnet.addMailboxes(1, { domainId: "abc", count: 1 }), /could not be found/);
  });
  await check("Maildoso domains are refused", async () => {
    const md = (await db.query(`INSERT INTO domains (domain, registrar, dns_provider, provider, status, workspace_id) VALUES ($1,'Porkbun','Porkbun','Maildoso','Verified',$2) RETURNING id`, [`md-${stamp}.example`, ws])).rows[0].id;
    await db.query(`INSERT INTO warmnet_domains (domain_id, ip_id) VALUES ($1, NULL)`, [md]);
    await assert.rejects(() => warmnet.addMailboxes(1, { domainId: md, count: 1 }), /our own mail server/);
  });

  await db.query(`DELETE FROM workspaces WHERE id = $1`, [ws]).catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
