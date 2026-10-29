const BASE = "https://api.porkbun.com/api/json/v3";

let transport = null;
const setTransport = (fn) => { transport = fn; };

const keys = () => ({ apikey: process.env.PORKBUN_API_KEY || "", secretapikey: process.env.PORKBUN_API_SECRET || "" });
const configured = () => Boolean(transport || (process.env.PORKBUN_API_KEY && process.env.PORKBUN_API_SECRET));
const fail = (message, statusCode = 502) => Object.assign(new Error(message), { statusCode });

async function call(path, body = {}) {
  if (!configured()) throw fail("Porkbun isn't configured on this server.", 503);
  const payload = { ...keys(), ...body };
  const out = transport ? await transport(path, payload) : await fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) }).then((r) => r.json().catch(() => ({})));
  if (out.status !== "SUCCESS") throw fail(`Porkbun: ${out.message || "request failed"}`);
  return out;
}

/** Domains in the Porkbun account (read-only). Lets onboarding refuse a domain we don't control instead of failing halfway. */
async function listDomains() {
  const all = [];
  for (let start = 0; start < 10000; start += 1000) {
    const out = await call("/domain/listAll", { start: String(start), includeLabels: "no" });
    const page = out.domains || [];
    all.push(...page.map((d) => String(d.domain).toLowerCase()));
    if (page.length < 1000) break;
  }
  return all;
}
const ownsDomain = async (domain) => (await listDomains()).includes(String(domain).toLowerCase());

const listRecords = async (domain) => (await call(`/dns/retrieve/${encodeURIComponent(domain)}`)).records || [];

// Porkbun stores names without the domain; the content of TXT records may come back quoted.
// DNS names are case-insensitive and Porkbun hands them back lowercased, so compare them lowercased.
const relName = (rawName, rawDomain) => { const name = String(rawName).toLowerCase(); const domain = String(rawDomain).toLowerCase(); return name === domain ? "" : name.endsWith(`.${domain}`) ? name.slice(0, -domain.length - 1) : name; };
const clean = (v) => String(v || "").replace(/^"|"$/g, "").trim();

/**
 * Adds the records a domain is missing. It never edits or deletes anything: a different SPF/DMARC/MX record already there
 * is reported as a conflict for a person to resolve. Safe to run twice.
 */
async function applyRecords(domain, records, { dryRun = false } = {}) {
  const existing = await listRecords(domain);
  const out = { added: [], alreadyThere: [], conflicts: [] };
  for (const r of records) {
    const sub = relName(r.name, domain);
    const same = existing.filter((e) => e.type === r.type && relName(e.name, domain) === sub);
    const wanted = r.type === "MX" ? r.value.replace(/^\d+\s+/, "") : r.value;
    const have = (e) => (r.type === "MX" ? clean(e.content) : clean(e.content));
    const norm = (v) => String(v).toLowerCase().replace(/\.$/, "").replace(/;\s*$/, "").replace(/\s+/g, " ").trim();
    if (same.some((e) => norm(have(e)) === norm(wanted))) { out.alreadyThere.push(r.key); continue; }
    // One SPF and one DMARC record per name, and a CNAME can't share a name: don't stack a second one.
    const exclusive = r.exclusive || r.type === "CNAME" || (r.type === "TXT" && /^v=(spf1|DMARC1)/i.test(r.value));
    const clash = exclusive ? same.filter((e) => r.type === "CNAME" || r.exclusive || /^v=(spf1|DMARC1)/i.test(clean(e.content))) : [];
    if (clash.length) { out.conflicts.push({ key: r.key, existing: clash.map((e) => clean(e.content)) }); continue; }
    if (dryRun) { out.added.push(r.key); continue; }
    await call(`/dns/create/${encodeURIComponent(domain)}`, { type: r.type, name: sub, content: wanted, ttl: "600", ...(r.type === "MX" ? { prio: String(r.value.match(/^(\d+)/)?.[1] || 10) } : {}) });
    out.added.push(r.key);
  }
  return out;
}

module.exports = { configured, applyRecords, listRecords, listDomains, ownsDomain, setTransport };
