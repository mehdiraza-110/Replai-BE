// Verifies onboarding domains onto the own (Hetzner/Postal) mail server in the LOCAL sandbox: the Postal console is stubbed
// (it receives the Ruby script and returns what Postal would print), Porkbun is stubbed, DNS is stubbed. Nothing leaves the machine.
//   ./dev-local.sh node scripts/postal-onboarding-test.js
const BE = require("path").resolve(__dirname, "..");
const assert = require("assert");
const db = require(`${BE}/config/db.config`);
const postalAdmin = require(`${BE}/services/postalAdmin.service`);
const porkbun = require(`${BE}/services/porkbun.service`);
const postalDns = require(`${BE}/services/postalDns.service`);
const onboarding = require(`${BE}/services/postalOnboarding.service`);
const domainService = require(`${BE}/services/domain.service`);

let pass = 0, fail = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log("  PASS", name); }, (e) => { fail++; console.log("  FAIL", name, "->", e.message); });
const stamp = Date.now();

process.env.POSTAL_SSH_HOST = "postal.test";
const json = (o) => `noise\n__JSON_BEGIN__${JSON.stringify(o)}__JSON_END__\nnoise`;
const recordsFor = (name, id) => ({ verification: `postal-verification TOK${id}`, spf: "v=spf1 a mx include:spf.postal.kovalr.com ~all", dkim_name: `postal-${id}._domainkey`, dkim: `v=DKIM1; t=s; h=sha256; p=KEY${id};`, return_path: `psrp.${name}`, return_target: "rp.postal.kovalr.com", mx: ["mta.kovalr.com"], verified: false });
let scripts = [], postalDomains = {}, poolFull = false, verifyOk = false;
postalAdmin.setRunner(async (src) => {
  scripts.push(src);
  const name = (/name: ("[^"]+")/.exec(src) || /find_by!\(name: ("[^"]+")/.exec(src) || [])[1]?.slice(1, -1);
  if (/IPPool\.all\.map \{ \|p\| \{ name/.test(src)) return json({ domains: Object.values(postalDomains).map((d) => ({ name: d.name, verified: true, spf: "OK", dkim: "OK", mx: "OK", return_path: "OK", dkim_identifier: d.id, pool: "ip-02", ip: "5.161.30.62", hostname: "mta2.kovalr.com" })), pools: [{ name: "ip-02", domains: 2 }], per_pool: 10 });
  if (/check_dns/.test(src)) return json({ status: { verified: verifyOk, spf: verifyOk ? "OK" : "Missing", dkim: verifyOk ? "OK" : "Missing", mx: verifyOk ? "OK" : "Missing", return_path: "OK", dns_ok: verifyOk, errors: {} }, records: recordsFor(name, postalDomains[name]?.id || "abc123") });
  if (/IPPoolRule\.create!/.test(src)) {
    if (poolFull) return json({ error: "RuntimeError: Every sending IP pool already has 10 domains. Add another IP first." });
    const existed = Boolean(postalDomains[name]);
    const id = postalDomains[name]?.id || `Z${Object.keys(postalDomains).length}x${String(stamp).slice(-4)}`;
    if (!/raise ActiveRecord::Rollback/.test(src)) postalDomains[name] = { name, id: `postal-${id}` };
    return json({ existed, route: { mode: "Endpoint", endpoint: "Replai inbound" }, pool: { id: 2, name: "ip-03", ip: "5.161.30.134", hostname: "mta3.kovalr.com" }, records: recordsFor(name, id) });
  }
  return json({});
});

let dnsRecords, calls, owned;
porkbun.setTransport(async (path, body) => {
  calls.push({ path, body });
  if (path.startsWith("/domain/listAll")) return { status: "SUCCESS", domains: owned.map((d) => ({ domain: d })) };
  if (path.startsWith("/dns/retrieve")) return { status: "SUCCESS", records: dnsRecords };
  if (path.startsWith("/dns/create")) { const dom = decodeURIComponent(path.split("/").pop()); dnsRecords = [...dnsRecords, { type: body.type, name: body.name ? `${body.name}.${dom}` : dom, content: body.content }]; return { status: "SUCCESS", id: "1" }; }
  return { status: "ERROR", message: "unknown" };
});
postalDns.setResolver({ resolveMx: async () => { throw Object.assign(new Error(), { code: "ENODATA" }); }, resolveTxt: async () => { throw Object.assign(new Error(), { code: "ENODATA" }); }, resolveCname: async () => { throw Object.assign(new Error(), { code: "ENODATA" }); } });
const reset = () => { scripts = []; calls = []; dnsRecords = []; poolFull = false; verifyOk = false; };

(async () => {
  const ws = (await db.query(`INSERT INTO workspaces (name, slug) VALUES ($1,$2) RETURNING id`, [`Onb ${stamp}`, `onb-${stamp}`])).rows[0].id;
  const d = (n) => `${n}-${stamp}.example`;
  const createdCalls = () => calls.filter((c) => c.path.startsWith("/dns/create"));

  console.log("\n[1] the scripts sent to the mail server");
  await check("only a plain domain name can reach a script", () => {
    for (const bad of ['a.com"; system("x")', "a.com\nputs 1", "no_tld", "a b.com", "../etc.com", "-a.com", ""]) assert.throws(() => postalAdmin.assertDomain(bad), /valid domain/, bad);
    assert.equal(postalAdmin.assertDomain("good-name.example"), "good-name.example");
  });
  await check("a dry run is rolled back; a real run is not", () => {
    assert.match(postalAdmin.provisionScript("x.example", { dryRun: true }), /raise ActiveRecord::Rollback/);
    assert.doesNotMatch(postalAdmin.provisionScript("x.example"), /Rollback/);
    assert.match(postalAdmin.provisionScript("x.example"), /name: "x\.example"/);
  });
  await check("the script matches Postal's own models (owner, route, pool rule, endpoint, pool size)", () => {
    const s = postalAdmin.provisionScript("x.example");
    for (const needle of ['owner_type: "Server"', 'Route.create!', 'name: "*"', 'mode: "Endpoint"', "IPPoolRule.create!", 'HTTPEndpoint.find_by!', "n < 10", "dns_verification_string", "dkim_record_name", "return_path_domain"]) assert.ok(s.includes(needle), needle);
    assert.match(postalAdmin.checkScript("x.example"), /verify_with_dns unless domain\.verified\?/);
    assert.match(postalAdmin.checkScript("x.example"), /check_dns\(:manual\)/);
  });
  await check("the console echoes the script back: the echo must not be mistaken for the result", async () => {
    // exactly what Postal's console does when fed a script on stdin: it prints each input line, then the output
    postalAdmin.setRunner(async (src) => `Loading production environment (Rails 7.1.6)\n${src.split("\n").map((l, i) => `irb(main):${String(i + 1).padStart(3, "0")}> ${l}`).join("\n")}\n__JSON_BEGIN__{"domains":[{"name":"a.example"}],"pools":[],"per_pool":10}__JSON_END__\n`);
    const r = await postalAdmin.listDomains(); assert.equal(r.domains[0].name, "a.example"); assert.equal(r.per_pool, 10);
    assert.ok(!/__JSON_BEGIN__/.test(postalAdmin.listScript()), "the script must not contain the contiguous marker");
    assert.ok(!/__JSON_END__/.test(postalAdmin.provisionScript("x.example")) && !/__JSON_BEGIN__/.test(postalAdmin.checkScript("x.example")));
    postalAdmin.setRunner(async () => 'irb> puts "__JSON_BEGIN__" + out.to_json + "__JSON_END__"\n__JSON_BEGIN__{"ok":true}__JSON_END__');
    assert.equal((await postalAdmin.listDomains()).ok, true);
    postalAdmin.setRunner(async () => 'irb> puts "__JSON_BEGIN__" + out.to_json + "__JSON_END__"');
    await assert.rejects(() => postalAdmin.listDomains(), /didn't return a result/);
  });
  await check("results are read from between the markers; errors become clear failures", async () => {
    postalAdmin.setRunner(async () => "no markers here");
    await assert.rejects(() => postalAdmin.listDomains(), /didn't return a result/);
    postalAdmin.setRunner(async () => json({ error: "ActiveRecord::RecordInvalid: Validation failed" }));
    await assert.rejects(() => postalAdmin.provision("x.example"), (e) => e.code === "POSTAL_REFUSED" && /Validation failed/.test(e.message));
    postalAdmin.setRunner(async () => "__JSON_BEGIN__{broken}__JSON_END__");
    await assert.rejects(() => postalAdmin.listDomains(), /unreadable/);
  });

  // restore the main stub
  const mainRunner = async (src) => {
    scripts.push(src);
    const name = (/name: ("[^"]+")/.exec(src) || /find_by!\(name: ("[^"]+")/.exec(src) || [])[1]?.slice(1, -1);
    if (/IPPool\.all\.map \{ \|p\| \{ name/.test(src)) return json({ domains: Object.values(postalDomains).map((x) => ({ name: x.name, verified: true, spf: "OK", dkim: "OK", mx: "OK", return_path: "OK", dkim_identifier: x.id, pool: "ip-02", ip: "5.161.30.62", hostname: "mta2.kovalr.com" })), pools: [{ name: "ip-02", domains: 2 }], per_pool: 10 });
    if (/check_dns/.test(src)) return json({ status: { verified: verifyOk, spf: verifyOk ? "OK" : "Missing", dkim: verifyOk ? "OK" : "Missing", mx: verifyOk ? "OK" : "Missing", return_path: "OK", dns_ok: verifyOk, errors: {} }, records: recordsFor(name, postalDomains[name]?.id?.replace("postal-", "") || "abc123") });
    if (/IPPoolRule\.create!/.test(src)) {
      if (poolFull) return json({ error: "RuntimeError: Every sending IP pool already has 10 domains. Add another IP first." });
      const existed = Boolean(postalDomains[name]);
      const id = postalDomains[name]?.id?.replace("postal-", "") || `Z${Object.keys(postalDomains).length}${String(stamp).slice(-4)}`;
      if (!/raise ActiveRecord::Rollback/.test(src)) postalDomains[name] = { name, id: `postal-${id}` };
      return json({ existed, route: { mode: "Endpoint", endpoint: "Replai inbound" }, pool: { id: 2, name: "ip-03", ip: "5.161.30.134", hostname: "mta3.kovalr.com" }, records: recordsFor(name, id) });
    }
    return json({});
  };
  postalAdmin.setRunner(mainRunner);

  console.log("\n[2] readiness and input checks");
  await check("refuses clearly when the mail server or Porkbun isn't connected", async () => {
    reset(); owned = [];
    const keep = process.env.POSTAL_SSH_HOST; delete process.env.POSTAL_SSH_HOST; postalAdmin.setRunner(null);
    await assert.rejects(() => onboarding.onboard(null, { domains: [d("a")], workspaceId: ws }), /POSTAL_SSH_HOST/);
    process.env.POSTAL_SSH_HOST = keep; postalAdmin.setRunner(mainRunner);
    porkbun.setTransport(null); await assert.rejects(() => onboarding.onboard(null, { domains: [d("a")], workspaceId: ws }), /Porkbun isn't connected/);
    assert.equal(onboarding.readiness().dns, false);
  });
  // re-attach stub transport
  const pbStub = async (path, body) => { calls.push({ path, body }); if (path.startsWith("/domain/listAll")) return { status: "SUCCESS", domains: owned.map((x) => ({ domain: x })) }; if (path.startsWith("/dns/retrieve")) return { status: "SUCCESS", records: dnsRecords }; if (path.startsWith("/dns/create")) { const dom = decodeURIComponent(path.split("/").pop()); dnsRecords = [...dnsRecords, { type: body.type, name: body.name ? `${body.name}.${dom}` : dom, content: body.content }]; return { status: "SUCCESS", id: "1" }; } return { status: "ERROR", message: "unknown" }; };
  porkbun.setTransport(pbStub);
  await check("empty list and more than 50 are refused", async () => {
    await assert.rejects(() => onboarding.onboard(null, { domains: [], workspaceId: ws }), /at least one/i);
    await assert.rejects(() => onboarding.onboard(null, { domains: Array.from({ length: 51 }, (_, i) => `d${i}.example`), workspaceId: ws }), /At most 50/);
  });

  console.log("\n[3] a dry run changes nothing");
  await check("reports the plan, never writes to Postal, Porkbun or the app", async () => {
    reset(); const n = d("dry"); owned = [n];
    const r = await onboarding.onboard(null, { domains: [n], workspaceId: ws, dryRun: true });
    assert.equal(r.dryRun, true); assert.equal(r.results[0].ok, true); assert.equal(createdCalls().length, 0);
    assert.ok(scripts.every((s) => /Rollback/.test(s))); assert.equal(Object.keys(postalDomains).length, 0);
    assert.equal(Number((await db.query(`SELECT COUNT(*) AS n FROM domains WHERE domain = $1`, [n])).rows[0].n), 0);
    assert.equal(r.results[0].dns.added.length, 6);
  });

  console.log("\n[4] onboarding for real");
  const one = d("one");
  await check("a domain goes through every step: Porkbun, Postal, DNS, app", async () => {
    reset(); owned = [one, d("other")];
    const r = await onboarding.onboard(7, { domains: [one], mailboxesPerDomain: 3, workspaceId: ws });
    assert.equal(r.succeeded, 1, JSON.stringify(r.results[0])); const res = r.results[0];
    assert.deepEqual(res.steps.map((s) => s.step), ["porkbun", "postal", "dns", "verify", "app"]);
    assert.equal(createdCalls().length, 6);
    const by = Object.fromEntries(createdCalls().map((c) => [c.body.type + ":" + c.body.name, c.body]));
    assert.equal(by["MX:"].content, "mta.kovalr.com"); assert.equal(by["MX:"].prio, "10");
    assert.ok(by["CNAME:psrp"]); assert.equal(by["CNAME:psrp"].content, "rp.postal.kovalr.com"); assert.ok(by["TXT:_dmarc"]);
    assert.ok(Object.keys(by).some((k) => k.startsWith("TXT:postal-") && k.endsWith("._domainkey"))); assert.ok(createdCalls().some((c) => /^postal-verification/.test(c.body.content)));
  });
  await check("the app row: Postal provider, Porkbun registrar, DKIM selector, sending IP, Pending until DNS spreads", async () => {
    const { rows } = await db.query(`SELECT d.*, ip.ip, ip.hostname FROM domains d LEFT JOIN warmnet_domains wd ON wd.domain_id = d.id LEFT JOIN warmnet_ips ip ON ip.id = wd.ip_id WHERE d.domain = $1`, [one]);
    const r = rows[0]; assert.equal(r.provider, "Postal"); assert.equal(r.registrar, "Porkbun"); assert.match(r.dkim_selector, /^postal-/); assert.equal(r.ip, "5.161.30.134"); assert.equal(r.hostname, "mta3.kovalr.com");
    assert.equal(r.status, "Pending Verification"); assert.match(r.last_error, /DNS isn't ready/); assert.equal(r.workspace_id, ws);
    const mb = (await db.query(`SELECT m.provider, m.status, w.state FROM mailboxes m JOIN warmnet_mailboxes w ON w.mailbox_id = m.id WHERE m.domain_id = $1`, [r.id])).rows;
    assert.equal(mb.length, 3); assert.ok(mb.every((m) => m.provider === "postal" && m.status === "Paused" && m.state === "queued"));
  });
  await check("running it again for the same domain is refused cleanly and adds nothing", async () => {
    reset(); const r = await onboarding.onboard(7, { domains: [one], workspaceId: ws });
    assert.equal(r.failed, 1); assert.match(r.results[0].error, /already in the system/); assert.equal(createdCalls().length, 0); assert.equal(scripts.length, 0);
  });
  await check("a domain that isn't in Porkbun fails on its own; the others still go through", async () => {
    reset(); const a = d("ok2"), b = d("notmine"); owned = [a];
    const r = await onboarding.onboard(7, { domains: [b, a], workspaceId: ws, mailboxesPerDomain: 1 });
    const by = Object.fromEntries(r.results.map((x) => [x.domain, x])); assert.equal(by[b].ok, false); assert.match(by[b].error, /isn't in the Porkbun account/); assert.equal(by[a].ok, true);
    assert.ok(!scripts.some((s) => s.includes(b)), "nothing was created at Postal for a domain we don't own");
  });
  await check("when Postal refuses (every IP pool full) nothing is written to DNS or the app", async () => {
    reset(); poolFull = true; const n = d("full"); owned = [n];
    const r = await onboarding.onboard(7, { domains: [n], workspaceId: ws }); assert.equal(r.failed, 1); assert.match(r.results[0].error, /Every sending IP pool/);
    assert.equal(createdCalls().length, 0); assert.equal(Number((await db.query(`SELECT COUNT(*) AS n FROM domains WHERE domain = $1`, [n])).rows[0].n), 0);
  });
  await check("an existing different record is reported for a person to fix and never overwritten", async () => {
    reset(); const n = d("conf"); owned = [n];
    dnsRecords = [{ type: "TXT", name: n, content: '"v=spf1 include:_spf.google.com ~all"' }];
    const r = await onboarding.onboard(7, { domains: [n], workspaceId: ws, mailboxesPerDomain: 1 });
    assert.equal(r.results[0].needsAttention, true); assert.deepEqual(r.results[0].dns.conflicts.map((c) => c.key), ["spf"]);
    assert.ok(!calls.some((c) => /\/dns\/(delete|edit)/.test(c.path))); assert.equal(r.results[0].steps.find((s) => s.step === "dns").ok, false);
  });
  await check("a domain Postal already has (set up earlier) is reused, not duplicated", async () => {
    reset(); const n = d("known"); owned = [n]; postalDomains[n] = { name: n, id: "postal-OLD111" };
    const r = await onboarding.onboard(7, { domains: [n], workspaceId: ws, mailboxesPerDomain: 1 }); assert.equal(r.succeeded, 1);
    assert.match(r.results[0].steps.find((s) => s.step === "postal").detail, /Already in/); assert.equal((await db.query(`SELECT dkim_selector FROM domains WHERE domain = $1`, [n])).rows[0].dkim_selector, "postal-old111");
  });

  console.log("\n[4b] matching what Porkbun really returns");
  await check("names come back lowercased with a trailing-semicolon DMARC: an already-onboarded domain is recognised, nothing is added", async () => {
    reset(); const n = d("exact"); owned = [n];
    const rec = recordsFor(n, "AbCdEf");
    dnsRecords = [
      { type: "MX", name: n, content: "mta.kovalr.com" }, { type: "TXT", name: n, content: rec.verification }, { type: "TXT", name: n, content: rec.spf },
      { type: "TXT", name: `${rec.dkim_name.toLowerCase()}.${n}`, content: rec.dkim }, { type: "CNAME", name: `psrp.${n}`, content: "rp.postal.kovalr.com" }, { type: "TXT", name: `_dmarc.${n}`, content: "v=DMARC1; p=none;" },
    ];
    postalDomains[n] = { name: n, id: "postal-AbCdEf" };
    const r = await onboarding.onboard(7, { domains: [n], workspaceId: ws, mailboxesPerDomain: 1 });
    assert.equal(createdCalls().length, 0, JSON.stringify(r.results[0].dns)); assert.deepEqual(r.results[0].dns.conflicts, []); assert.equal(r.results[0].dns.alreadyThere.length, 6);
  });

  console.log("\n[5] re-check asks Postal and trusts its DKIM verdict");
  await check("Re-check verifies at Postal, learns the selector, and the domain turns Verified once DNS is there", async () => {
    reset(); verifyOk = true;
    postalDns.setResolver({
      resolveMx: async () => [{ priority: 10, exchange: "mta.kovalr.com" }],
      resolveTxt: async (h) => { if (h === one) return [["v=spf1 a mx include:spf.postal.kovalr.com ~all"]]; if (h.startsWith("_dmarc")) return [["v=DMARC1; p=none"]]; return [["v=DKIM1; p=KEY"]]; },
      resolveCname: async () => ["rp.postal.kovalr.com."],
    });
    const out = await domainService.refreshDomainStatus(one, ws);
    assert.equal(out.status, "Verified"); assert.equal(out.dkimStatus, "Success"); assert.ok(scripts.some((s) => /verify_with_dns/.test(s)));
  });
  await check("if Postal can't be reached, the DNS-only check still works", async () => {
    reset(); postalAdmin.setRunner(async () => { throw Object.assign(new Error("down"), { code: "POSTAL_UNREACHABLE" }); });
    const out = await domainService.refreshDomainStatus(one, ws); assert.equal(out.status, "Verified"); postalAdmin.setRunner(mainRunner);
  });

  console.log("\n[6] adopting domains that already exist in Postal");
  await check("domains in Postal but not in the app are added (no invented inboxes); existing ones are left alone; safe to repeat", async () => {
    reset(); postalDomains = { [d("old1")]: { name: d("old1"), id: "postal-AAA111" }, [d("old2")]: { name: d("old2"), id: "postal-BBB222" }, [one]: { name: one, id: "postal-X" } };
    const r = await onboarding.syncFromPostal(7, { workspaceId: ws });
    assert.equal(r.inPostal, 3); assert.deepEqual(r.added.sort(), [d("old1"), d("old2")].sort()); assert.equal(r.alreadyHere, 1); assert.equal(r.failed.length, 0);
    const row = (await db.query(`SELECT d.provider, d.dkim_selector, (SELECT COUNT(*) FROM mailboxes m WHERE m.domain_id = d.id) AS boxes FROM domains d WHERE d.domain = $1`, [d("old1")])).rows[0];
    assert.equal(row.provider, "Postal"); assert.equal(row.dkim_selector, "postal-aaa111"); assert.equal(Number(row.boxes), 0);
    const again = await onboarding.syncFromPostal(7, { workspaceId: ws }); assert.equal(again.added.length, 0);
  });

  // cleanup
  await db.query(`DELETE FROM warmnet_mailboxes WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE workspace_id = $1)`, [ws]);
  await db.query(`DELETE FROM warmnet_domains WHERE domain_id IN (SELECT id FROM domains WHERE workspace_id = $1)`, [ws]);
  await db.query(`DELETE FROM mailboxes WHERE workspace_id = $1`, [ws]);
  await db.query(`DELETE FROM domains WHERE workspace_id = $1`, [ws]);
  await db.query(`DELETE FROM warmnet_ips WHERE ip IN ('5.161.30.134', '5.161.30.62') AND id NOT IN (SELECT ip_id FROM warmnet_domains WHERE ip_id IS NOT NULL)`);
  await db.query(`DELETE FROM workspace_usage_events WHERE workspace_id = $1`, [ws]);
  await db.query(`DELETE FROM workspaces WHERE id = $1`, [ws]);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
