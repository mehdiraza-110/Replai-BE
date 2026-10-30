const dns = require("dns");
const db = require("../config/db.config");
const postalDns = require("./postalDns.service");

// Every sending domain depends on the mail server's own hostnames (MX, SPF include, return path, reverse DNS). If that one
// domain's DNS breaks or the domain lapses, all of them break together. This checks those few things so a problem is seen early.

const resolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
let transport = resolver;
let fetchImpl = (...args) => fetch(...args);
const setTransport = (r, f) => { transport = r || resolver; fetchImpl = f || ((...args) => fetch(...args)); };

const NOT_THERE = new Set(["ENODATA", "ENOTFOUND", "NXDOMAIN"]);
const safe = async (fn) => { try { return { ok: true, value: await fn() }; } catch (e) { return NOT_THERE.has(e.code) ? { ok: true, value: null } : { ok: false, error: e.code || e.message }; } };
const item = (key, label, status, detail) => ({ key, label, status, detail });
const rank = { ok: 0, warn: 1, bad: 2 };

/** The registrable part of a hostname (example.com from mta.example.com). Good enough for .com, .net, .org and similar. */
const registrable = (host) => String(host).toLowerCase().split(".").slice(-2).join(".");

async function domainExpiry(domain) {
  if (!/\.(com|net)$/.test(domain)) return null; // only the registries that answer RDAP without a key
  try {
    const tld = domain.split(".").pop();
    const res = await fetchImpl(`https://rdap.verisign.com/${tld}/v1/domain/${domain}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const d = await res.json();
    const ev = Object.fromEntries((d.events || []).map((e) => [e.eventAction, e.eventDate]));
    const expires = ev.expiration ? new Date(ev.expiration) : null;
    const registered = ev.registration ? new Date(ev.registration) : null;
    return { expires, registered, daysLeft: expires ? Math.floor((expires - Date.now()) / 86400000) : null, ageDays: registered ? Math.floor((Date.now() - registered) / 86400000) : null };
  } catch { return null; }
}

/** `ips` (rows like {ip, hostname, clean, listings}) replaces the database list; used by tests so they never touch real rows. */
async function check({ ips: given } = {}) {
  const c = postalDns.config();
  const items = [];
  const infra = registrable(c.mxHost);

  // 1. the mail server's hostname and its IPs
  const a = await safe(() => transport.resolve4(c.mxHost));
  const mxIps = a.ok && a.value ? a.value : [];
  items.push(a.ok ? (mxIps.length ? item("mx-host", `${c.mxHost} resolves`, "ok", mxIps.join(", ")) : item("mx-host", `${c.mxHost} resolves`, "bad", "No address record. Every domain's mail would stop arriving.")) : item("mx-host", `${c.mxHost} resolves`, "warn", `DNS didn't answer (${a.error}). Check again shortly.`));

  // 2. every sending IP: reverse DNS must point to a name that resolves back to the same IP
  const rows = given || (await db.query(`SELECT ip, hostname, clean, listings FROM warmnet_ips ORDER BY id`)).rows;
  const ips = [...new Map([...rows.map((r) => [r.ip, r]), ...mxIps.map((ip) => [ip, { ip, hostname: c.mxHost, clean: null, listings: [] }])]).values()];
  const ptrProblems = [];
  const listed = [];
  for (const r of ips) {
    const ptr = await safe(() => transport.reverse(r.ip));
    if (!ptr.ok) { ptrProblems.push(`${r.ip}: DNS didn't answer`); continue; }
    if (!ptr.value || !ptr.value.length) { ptrProblems.push(`${r.ip}: no reverse DNS`); continue; }
    const back = (await Promise.all(ptr.value.map((h) => safe(() => transport.resolve4(h))))).flatMap((x) => (x.ok && x.value ? x.value : []));
    if (!back.includes(r.ip)) ptrProblems.push(`${r.ip}: reverse name ${ptr.value[0]} doesn't point back to it`);
    if (r.clean === false) listed.push(`${r.ip} (${(Array.isArray(r.listings) ? r.listings : []).join(", ") || "listed"})`);
  }
  items.push(item("reverse-dns", "Reverse DNS on every sending IP", ptrProblems.length ? "bad" : "ok", ptrProblems.length ? ptrProblems.join("; ") : `${ips.length} IP${ips.length === 1 ? "" : "s"} checked, all match`));
  items.push(item("blocklists", "Sending IPs on spam blocklists", listed.length ? "bad" : "ok", listed.length ? listed.join("; ") : "None listed at the last check"));

  // 3. the SPF include must list every sending IP, or mail from that IP fails SPF
  const spf = await safe(() => transport.resolveTxt(c.spfInclude));
  if (!spf.ok) items.push(item("spf-include", `${c.spfInclude} lists every IP`, "warn", `DNS didn't answer (${spf.error}). Check again shortly.`));
  else {
    const text = (spf.value || []).map((p) => p.join("")).find((t) => /^v=spf1/i.test(t)) || "";
    const missing = ips.map((r) => r.ip).filter((ip) => !text.includes(`ip4:${ip}`));
    items.push(item("spf-include", `${c.spfInclude} lists every IP`, !text ? "bad" : missing.length ? "bad" : "ok", !text ? "No SPF record there. Mail from every domain fails SPF." : missing.length ? `Missing: ${missing.join(", ")}. Mail sent from those IPs fails SPF.` : `${ips.length} IP${ips.length === 1 ? "" : "s"} listed`));
  }

  // 4. the return-path host the bounce addresses point at must exist
  const rp = await safe(async () => { const t = await transport.resolveTxt(c.returnPathHost).catch(() => null); const a4 = await transport.resolve4(c.returnPathHost).catch(() => null); return t || a4; });
  items.push(rp.ok ? (rp.value ? item("return-path", `${c.returnPathHost} exists`, "ok", "Bounce addresses resolve") : item("return-path", `${c.returnPathHost} exists`, "bad", "No record. Bounces can't be matched to the emails they belong to.")) : item("return-path", `${c.returnPathHost} exists`, "warn", `DNS didn't answer (${rp.error})`));

  // 5. the domain everything hangs off: age and expiry
  const exp = await domainExpiry(infra);
  if (!exp) items.push(item("domain-expiry", `${infra} registration`, "warn", "Couldn't read the expiry date. Check it at the registrar."));
  else {
    const status = exp.daysLeft !== null && exp.daysLeft < 30 ? "bad" : exp.daysLeft !== null && exp.daysLeft < 90 ? "warn" : "ok";
    items.push(item("domain-expiry", `${infra} registration`, status, `${exp.daysLeft === null ? "Expiry unknown" : `${exp.daysLeft} days left`}${exp.ageDays !== null ? `; registered ${exp.ageDays} days ago${exp.ageDays < 180 ? " (a young domain at the centre of all sending)" : ""}` : ""}`));
  }

  const worst = items.reduce((w, i) => (rank[i.status] > rank[w] ? i.status : w), "ok");
  return { status: worst, checkedAt: new Date().toISOString(), infraDomain: infra, items };
}

module.exports = { check, setTransport, registrable };
