// Verifies own-server (Postal) domain handling in the LOCAL sandbox: real-DNS checks (resolver stubbed), inbox creation,
// required-records view and the Porkbun apply step (transport stubbed). Nothing leaves the machine.
//   ./dev-local.sh node scripts/postal-domains-test.js
const BE = require("path").resolve(__dirname, "..");
const assert = require("assert");
const db = require(`${BE}/config/db.config`);
const postalDns = require(`${BE}/services/postalDns.service`);
const porkbun = require(`${BE}/services/porkbun.service`);
const domainService = require(`${BE}/services/domain.service`);
const mailboxService = require(`${BE}/services/mailbox.service`);
const emailAccounts = require(`${BE}/services/emailAccounts.service`);

let pass = 0, fail = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log("  PASS", name); }, (e) => { fail++; console.log("  FAIL", name, "->", e.message); });
const stamp = Date.now();

const MX = "mta.kovalr.com", SPF_INC = "spf.postal.kovalr.com", RP = "rp.postal.kovalr.com";
// A fake internet: records[host][type] = value. Missing host/type -> ENODATA. `broken` hosts time out.
let zone = {}, broken = new Set();
const answer = (host, type) => {
  if (broken.has(host)) throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
  const v = zone[host]?.[type];
  if (v === undefined) throw Object.assign(new Error("no data"), { code: "ENODATA" });
  return v;
};
postalDns.setResolver({ resolveMx: async (h) => answer(h, "MX"), resolveTxt: async (h) => answer(h, "TXT"), resolveCname: async (h) => answer(h, "CNAME") });
const goodZone = (d, sel) => ({
  [d]: { MX: [{ priority: 10, exchange: `${MX}.` }], TXT: [[`v=spf1 a mx include:${SPF_INC} ~all`]] },
  [`_dmarc.${d}`]: { TXT: [["v=DMARC1; p=none"]] },
  [`psrp.${d}`]: { CNAME: [RP] },
  ...(sel ? { [`${sel}._domainkey.${d}`]: { TXT: [["v=DKIM1; k=rsa; p=MIGfMA0"]] } } : {}),
});

(async () => {
  const ws = (await db.query(`INSERT INTO workspaces (name, slug) VALUES ($1,$2) RETURNING id`, [`Postal ${stamp}`, `postal-${stamp}`])).rows[0].id;
  const other = (await db.query(`INSERT INTO workspaces (name, slug) VALUES ($1,$2) RETURNING id`, [`Postal2 ${stamp}`, `postal2-${stamp}`])).rows[0].id;
  const mkDomain = async (name, { provider = "Postal", registrar = "Porkbun", status = "Verified", w = ws } = {}) =>
    (await db.query(`INSERT INTO domains (domain, registrar, dns_provider, provider, status, spf_status, dkim_status, dmarc_status, mx_status, workspace_id) VALUES ($1,$2,$2,$3,$4,'Success','Success','Success','Success',$5) RETURNING *`, [name, registrar, provider, status, w])).rows[0];

  console.log("\n[1] live DNS checks");
  const d1 = `good-${stamp}.example`;
  await check("everything in place -> Success everywhere, Verified", async () => {
    zone = goodZone(d1, "postal-abc");
    const r = await postalDns.check(d1, { dkimSelector: "postal-abc" });
    assert.deepEqual(r.statuses, { mx: "Success", spf: "Success", dmarc: "Success", dkim: "Success", returnPath: "Success" });
    assert.equal(r.unreliable, false); assert.equal(postalDns.overall(r.statuses), "Verified");
  });
  await check("DKIM is 'Not started' until a selector is known", async () => {
    zone = goodZone(d1); assert.equal((await postalDns.check(d1)).statuses.dkim, "Not started");
  });
  await check("MX pointing elsewhere or SPF without our include is Failed", async () => {
    zone = goodZone(d1); zone[d1].MX = [{ priority: 10, exchange: "mail.other.com" }];
    let r = await postalDns.check(d1); assert.equal(r.statuses.mx, "Failed"); assert.equal(postalDns.overall(r.statuses), "Failed");
    zone = goodZone(d1); zone[d1].TXT = [["v=spf1 include:_spf.google.com ~all"]];
    r = await postalDns.check(d1); assert.equal(r.statuses.spf, "Failed");
  });
  await check("no records at all -> Failed (not a crash); DMARC missing alone keeps it Verified", async () => {
    zone = {}; const r = await postalDns.check(d1); assert.equal(r.statuses.mx, "Failed"); assert.equal(r.unreliable, false);
    zone = goodZone(d1); delete zone[`_dmarc.${d1}`]; const g = await postalDns.check(d1);
    assert.equal(g.statuses.dmarc, "Failed"); assert.equal(postalDns.overall(g.statuses), "Verified");
  });
  await check("a lookup that times out is 'unreliable', never 'Failed'", async () => {
    zone = goodZone(d1); broken = new Set([d1]);
    const r = await postalDns.check(d1); assert.equal(r.unreliable, true); assert.equal(r.statuses.mx, "Unknown");
    broken = new Set();
  });
  await check("the required-records list names the mail server and the selector", async () => {
    const recs = postalDns.expectedRecords("acme.com", { dkimSelector: "postal-x" });
    assert.equal(recs.find((r) => r.key === "mx").value, `10 ${MX}`);
    assert.match(recs.find((r) => r.key === "spf").value, new RegExp(SPF_INC));
    assert.equal(recs.find((r) => r.key === "dkim").name, "postal-x._domainkey.acme.com");
    assert.equal(recs.find((r) => r.key === "returnPath").name, "psrp.acme.com");
  });

  console.log("\n[2] re-check a Postal domain (no SES involved)");
  await check("Re-check updates the statuses from real DNS", async () => {
    const d = await mkDomain(`p1-${stamp}.example`, { status: "Pending Verification" });
    zone = goodZone(d.domain); 
    const out = await domainService.refreshDomainStatus(d.domain, ws);
    assert.equal(out.status, "Verified");
    const row = (await db.query(`SELECT * FROM domains WHERE id = $1`, [d.id])).rows[0];
    assert.deepEqual([row.mx_status, row.spf_status, row.dmarc_status, row.dkim_status], ["Success", "Success", "Success", "Not started"]);
    assert.equal(row.last_error, null); assert.ok(row.last_checked_at);
  });
  await check("a broken MX marks it Failed with a reason a person can act on", async () => {
    const d = await mkDomain(`p2-${stamp}.example`);
    zone = goodZone(d.domain); zone[d.domain].MX = [{ priority: 10, exchange: "elsewhere.net" }];
    await domainService.refreshDomainStatus(d.domain, ws);
    const row = (await db.query(`SELECT status, last_error FROM domains WHERE id = $1`, [d.id])).rows[0];
    assert.equal(row.status, "Failed"); assert.match(row.last_error, /MX/);
  });
  await check("a DNS outage keeps the old status (sending isn't stopped by a blip)", async () => {
    const d = await mkDomain(`p3-${stamp}.example`);
    zone = goodZone(d.domain); broken = new Set([d.domain]);
    await domainService.refreshDomainStatus(d.domain, ws); broken = new Set();
    const row = (await db.query(`SELECT status, mx_status, last_error FROM domains WHERE id = $1`, [d.id])).rows[0];
    assert.equal(row.status, "Verified"); assert.equal(row.mx_status, "Success"); assert.match(row.last_error, /try again/i);
  });
  await check("Re-check all copes with Postal and Maildoso domains side by side", async () => {
    const m = await mkDomain(`m1-${stamp}.example`, { provider: "Maildoso", registrar: "Maildoso", w: other });
    const p = await mkDomain(`p4-${stamp}.example`, { w: other }); zone = goodZone(p.domain);
    const results = await domainService.refreshAllDomains(other);
    assert.equal(results.length, 2); assert.ok(results.every((r) => !r.error), JSON.stringify(results));
    assert.equal(m.status, "Verified");
  });
  await check("one workspace can't re-check another's domain", async () => {
    await assert.rejects(() => domainService.refreshDomainStatus(`p1-${stamp}.example`, other), /not onboarded/i);
  });

  console.log("\n[3] inboxes on a Postal domain");
  const pd = await mkDomain(`mail-${stamp}.example`);
  await check("created Paused, on the own server, queued for warm-up", async () => {
    const out = await mailboxService.createMailboxes({ domain: pd.domain, localParts: ["Anna.Lee", "bob"], displayName: "Sales Team", createdBy: null, workspaceId: ws });
    assert.deepEqual(out.map((r) => r.status), ["Created", "Created"]);
    const { rows } = await db.query(`SELECT m.email, m.provider, m.status, m.daily_limit, w.state FROM mailboxes m LEFT JOIN warmnet_mailboxes w ON w.mailbox_id = m.id WHERE m.domain_id = $1 ORDER BY m.email`, [pd.id]);
    assert.deepEqual(rows.map((r) => [r.email, r.provider, r.status, r.daily_limit, r.state]), [[`anna.lee@${pd.domain}`, "postal", "Paused", 0, "queued"], [`bob@${pd.domain}`, "postal", "Paused", 0, "queued"]]);
    assert.equal(out[0].record.displayName, "Sales Team");
  });
  await check("duplicates and invalid names fail individually without blocking the rest", async () => {
    const out = await mailboxService.createMailboxes({ domain: pd.domain, localParts: ["bob", "new.one", "bad name!"], workspaceId: ws });
    const by = Object.fromEntries(out.map((r) => [r.email.split("@")[0], r]));
    assert.equal(by["new.one"].status, "Created"); assert.match(by.bob.error, /already exists/); assert.match(by["bad name!"].error, /Invalid/);
  });
  await check("each new inbox counts against the workspace mailbox usage", async () => {
    const { rows } = await db.query(`SELECT COALESCE(SUM(quantity),0)::int AS n FROM workspace_usage_events WHERE workspace_id = $1 AND kind = 'mailboxes'`, [ws]);
    assert.equal(rows[0].n, 3);
  });
  await check("another workspace can't create inboxes on this domain", async () => {
    await assert.rejects(() => mailboxService.createMailboxes({ domain: pd.domain, localParts: ["x"], workspaceId: other }), /hasn't been onboarded/);
  });

  console.log("\n[4] the DNS records screen");
  await check("Postal domain: required records with live status, and whether Porkbun can apply them", async () => {
    zone = goodZone(pd.domain); porkbun.setTransport(null);
    const r = await emailAccounts.domainDns(ws, pd.id);
    assert.equal(r.managed, true); assert.equal(r.records.find((x) => x.key === "mx").status, "Success"); assert.equal(r.canAutoApply, false);
  });
  await check("Maildoso domain: not managed here, with a pointer to Sync Maildoso", async () => {
    const m = await mkDomain(`md-${stamp}.example`, { provider: "Maildoso", registrar: "Maildoso" });
    const r = await emailAccounts.domainDns(ws, m.id); assert.equal(r.managed, false); assert.match(r.note, /Sync Maildoso/);
  });
  await check("DKIM selector: validated, saved, and then checked", async () => {
    await assert.rejects(() => emailAccounts.setDkimSelector(ws, pd.id, "bad selector!"), /letters, numbers/);
    zone = goodZone(pd.domain, "postal-q9");
    const r = await emailAccounts.setDkimSelector(ws, pd.id, "Postal-Q9");
    assert.equal(r.dkimSelector, "postal-q9"); assert.equal(r.records.find((x) => x.key === "dkim").status, "Success");
    assert.equal((await emailAccounts.setDkimSelector(ws, pd.id, "")).dkimSelector, null);
    await assert.rejects(() => emailAccounts.setDkimSelector(other, pd.id, "x"), /not found/i);
  });

  console.log("\n[5] applying records at Porkbun");
  let calls, existing;
  const stub = async (path, body) => {
    calls.push({ path, body });
    if (path.startsWith("/dns/retrieve")) return { status: "SUCCESS", records: existing };
    if (path.startsWith("/dns/create")) { existing = [...existing, { type: body.type, name: body.name ? `${body.name}.${decodeURIComponent(path.split("/").pop())}` : decodeURIComponent(path.split("/").pop()), content: body.content }]; return { status: "SUCCESS", id: "1" }; }
    return { status: "ERROR", message: "unknown" };
  };
  const ad = await mkDomain(`apply-${stamp}.example`);
  await check("refuses when Porkbun isn't configured, or the domain is registered elsewhere", async () => {
    porkbun.setTransport(null); await assert.rejects(() => emailAccounts.applyDns(ws, ad.id), /isn't configured/);
    porkbun.setTransport(stub); const o = await mkDomain(`other-reg-${stamp}.example`, { registrar: "GoDaddy" });
    calls = []; existing = []; await assert.rejects(() => emailAccounts.applyDns(ws, o.id), /not Porkbun/); assert.equal(calls.length, 0);
  });
  await check("adds the missing records (MX with priority, SPF, return path, DMARC) and never DKIM", async () => {
    calls = []; existing = []; porkbun.setTransport(stub); zone = {};
    const r = await emailAccounts.applyDns(ws, ad.id);
    assert.deepEqual(r.added.sort(), ["dmarc", "mx", "returnPath", "spf"]);
    const mx = calls.find((c) => c.body.type === "MX"); assert.equal(mx.body.content, MX); assert.equal(mx.body.prio, "10"); assert.equal(mx.body.name, "");
    assert.ok(calls.find((c) => c.body.name === `_dmarc`)); assert.ok(calls.find((c) => c.body.name === "psrp" && c.body.type === "CNAME"));
    assert.ok(!calls.some((c) => /_domainkey/i.test(JSON.stringify(c.body))));
  });
  await check("running it again adds nothing", async () => {
    calls = []; const r = await emailAccounts.applyDns(ws, ad.id);
    assert.deepEqual(r.added, []); assert.equal(r.alreadyThere.length, 4); assert.equal(calls.filter((c) => c.path.startsWith("/dns/create")).length, 0);
  });
  await check("an existing different SPF or DMARC is reported as a conflict and left alone", async () => {
    const c = await mkDomain(`conflict-${stamp}.example`);
    existing = [{ type: "TXT", name: c.domain, content: '"v=spf1 include:_spf.google.com ~all"' }, { type: "TXT", name: `_dmarc.${c.domain}`, content: "v=DMARC1; p=reject" }];
    calls = []; const r = await emailAccounts.applyDns(ws, c.id);
    assert.deepEqual(r.conflicts.map((x) => x.key).sort(), ["dmarc", "spf"]); assert.deepEqual(r.added.sort(), ["mx", "returnPath"]);
    assert.ok(!calls.some((x) => x.path.startsWith("/dns/delete") || x.path.startsWith("/dns/edit")));
  });
  await check("a Porkbun error is reported, not swallowed", async () => {
    porkbun.setTransport(async () => ({ status: "ERROR", message: "Invalid API key" }));
    const c = await mkDomain(`err-${stamp}.example`); await assert.rejects(() => emailAccounts.applyDns(ws, c.id), /Invalid API key/);
  });

  console.log("\n[6] bulk registration checks real DNS");
  await check("DNS in place -> Verified; DNS missing -> Pending Verification (still registered)", async () => {
    porkbun.setTransport(null);
    const ok = `reg-ok-${stamp}.example`, no = `reg-no-${stamp}.example`;
    zone = goodZone(ok);
    const r = await emailAccounts.bulkRegisterDomains(null, { domains: [ok, no], workspaceId: ws, mailboxesPerDomain: 1 });
    assert.equal(r.registered, 2, JSON.stringify(r.results));
    const rows = Object.fromEntries((await db.query(`SELECT domain, status, mx_status, dkim_selector, last_error FROM domains WHERE domain = ANY($1)`, [[ok, no]])).rows.map((x) => [x.domain, x]));
    assert.equal(rows[ok].status, "Verified"); assert.equal(rows[ok].mx_status, "Success");
    assert.equal(rows[no].status, "Pending Verification"); assert.match(rows[no].last_error, /DNS isn't ready/);
  });

  // cleanup
  for (const w of [ws, other]) {
    await db.query(`DELETE FROM warmnet_mailboxes WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE workspace_id = $1)`, [w]);
    await db.query(`DELETE FROM warmnet_domains WHERE domain_id IN (SELECT id FROM domains WHERE workspace_id = $1)`, [w]);
    await db.query(`DELETE FROM mailboxes WHERE workspace_id = $1`, [w]);
    await db.query(`DELETE FROM domains WHERE workspace_id = $1`, [w]);
    await db.query(`DELETE FROM workspace_usage_events WHERE workspace_id = $1`, [w]);
    await db.query(`DELETE FROM workspaces WHERE id = $1`, [w]);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
