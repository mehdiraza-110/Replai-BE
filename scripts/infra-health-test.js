// Verifies the mail server identity monitor (DNS, fetch and database all stubbed or local; nothing leaves the machine).
//   ./dev-local.sh node scripts/infra-health-test.js
const BE = require("path").resolve(__dirname, "..");
const assert = require("assert");
const infra = require(`${BE}/services/infraHealth.service`);

let pass = 0, fail = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log("  PASS", name); }, (e) => { fail++; console.log("  FAIL", name, "->", e.message); });
const ENODATA = () => Object.assign(new Error("x"), { code: "ENODATA" });
const TIMEOUT = () => Object.assign(new Error("x"), { code: "ETIMEOUT" });

const IP1 = "198.51.100.11", IP2 = "198.51.100.12", MXIP = "198.51.100.10";
let zone;
const fresh = () => { zone = { a: { "mta.kovalr.com": [MXIP], "mta2.test": [IP1], "mta3.test": [IP2], "mta.test": [MXIP] }, ptr: { [MXIP]: ["mta.test"], [IP1]: ["mta2.test"], [IP2]: ["mta3.test"] }, txt: { "spf.postal.kovalr.com": [["v=spf1 ip4:" + MXIP + " ip4:" + IP1 + " ip4:" + IP2 + " ~all"]], "rp.postal.kovalr.com": [["v=spf1 a mx ~all"]] } }; };
const fetchStub = (days, ageDays = 400) => async () => ({ ok: true, json: async () => ({ events: [{ eventAction: "registration", eventDate: new Date(Date.now() - ageDays * 86400000).toISOString() }, { eventAction: "expiration", eventDate: new Date(Date.now() + days * 86400000).toISOString() }] }) });
const install = (fetchFn = fetchStub(300)) => infra.setTransport({
  resolve4: async (h) => { if (zone.fail === h) throw TIMEOUT(); if (!zone.a[h]) throw ENODATA(); return zone.a[h]; },
  reverse: async (ip) => { if (zone.failPtr === ip) throw TIMEOUT(); if (!zone.ptr[ip]) throw ENODATA(); return zone.ptr[ip]; },
  resolveTxt: async (h) => { if (zone.failTxt === h) throw TIMEOUT(); if (!zone.txt[h]) throw ENODATA(); return zone.txt[h]; },
}, fetchFn);
const by = (r, k) => r.items.find((i) => i.key === k);

(async () => {
  // The sending IPs are passed in, so this test never reads or writes the real warmnet_ips table.
  let rows = [{ ip: IP1, hostname: "mta2.test", clean: true, listings: [] }, { ip: IP2, hostname: "mta3.test", clean: true, listings: [] }];
  console.log("\n[1] healthy");
  await check("everything in order -> ok, with the infra domain named", async () => {
    fresh(); install(); const r = await infra.check({ ips: rows });
    assert.equal(r.status, "ok", JSON.stringify(r.items.filter((i) => i.status !== "ok"))); assert.equal(r.infraDomain, "kovalr.com"); assert.equal(r.items.length, 6);
    assert.match(by(r, "domain-expiry").detail, /\b(299|300) days left/);
  });

  console.log("\n[2] problems are found");
  await check("reverse DNS pointing at the wrong place is bad and names the IP", async () => {
    fresh(); zone.ptr[IP1] = ["unrelated.example"]; zone.a["unrelated.example"] = ["203.0.113.9"]; install(); const r = await infra.check({ ips: rows });
    assert.equal(by(r, "reverse-dns").status, "bad"); assert.match(by(r, "reverse-dns").detail, new RegExp(IP1));
  });
  await check("an IP missing from the SPF include is bad (that IP would fail SPF everywhere)", async () => {
    fresh(); zone.txt["spf.postal.kovalr.com"] = [["v=spf1 ip4:" + MXIP + " ip4:" + IP1 + " ~all"]]; install(); const r = await infra.check({ ips: rows });
    assert.equal(by(r, "spf-include").status, "bad"); assert.match(by(r, "spf-include").detail, new RegExp(IP2)); assert.equal(r.status, "bad");
  });
  await check("no SPF record at all, or no address for the mail host, or no return-path record: each bad", async () => {
    fresh(); delete zone.txt["spf.postal.kovalr.com"]; install(); assert.equal(by(await infra.check({ ips: rows }), "spf-include").status, "bad");
    fresh(); delete zone.a["mta.kovalr.com"]; install(); assert.equal(by(await infra.check({ ips: rows }), "mx-host").status, "bad");
    fresh(); delete zone.txt["rp.postal.kovalr.com"]; install(); assert.equal(by(await infra.check({ ips: rows }), "return-path").status, "bad");
  });
  await check("an IP flagged by the blocklist check is reported with the list names", async () => {
    fresh(); install(); const listed = rows.map((r) => (r.ip === IP2 ? { ...r, clean: false, listings: ["Spamhaus ZEN"] } : r));
    const r = await infra.check({ ips: listed }); assert.equal(by(r, "blocklists").status, "bad"); assert.match(by(r, "blocklists").detail, /Spamhaus ZEN/);
  });

  console.log("\n[3] registration and outages");
  await check("under 90 days left warns, under 30 is bad, and a young domain is called out", async () => {
    fresh(); install(fetchStub(60, 100)); let r = await infra.check({ ips: rows }); assert.equal(by(r, "domain-expiry").status, "warn"); assert.match(by(r, "domain-expiry").detail, /young domain/);
    install(fetchStub(10)); r = await infra.check({ ips: rows }); assert.equal(by(r, "domain-expiry").status, "bad"); assert.equal(r.status, "bad");
  });
  await check("an unreadable registry answer is a warning to check by hand, not a failure", async () => {
    fresh(); install(async () => { throw new Error("offline"); }); const r = await infra.check({ ips: rows }); assert.equal(by(r, "domain-expiry").status, "warn"); assert.equal(r.status, "warn");
  });
  await check("a DNS outage (timeout) is a warning, never reported as broken", async () => {
    fresh(); zone.failTxt = "spf.postal.kovalr.com"; zone.failPtr = IP1; zone.fail = "mta.kovalr.com"; install(); const r = await infra.check({ ips: rows });
    assert.equal(by(r, "spf-include").status, "warn"); assert.equal(by(r, "mx-host").status, "warn"); assert.notEqual(by(r, "reverse-dns").status, "ok" && "never"); assert.ok(!r.items.some((i) => i.key !== "reverse-dns" && i.status === "bad"));
  });
  await check("the registrable domain is found from the hostname", () => { assert.equal(infra.registrable("mta.kovalr.com"), "kovalr.com"); assert.equal(infra.registrable("a.b.example.net"), "example.net"); });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
