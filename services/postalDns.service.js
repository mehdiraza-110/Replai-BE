const dns = require("dns");

// The mail server's DNS identity. Defaults match the Hetzner pilot; override per environment.
const config = () => ({
  mxHost: String(process.env.POSTAL_MX_HOST || "mta.kovalr.com").toLowerCase(),
  spfInclude: String(process.env.POSTAL_SPF_INCLUDE || "spf.postal.kovalr.com").toLowerCase(),
  returnPathHost: String(process.env.POSTAL_RETURN_PATH_HOST || "rp.postal.kovalr.com").toLowerCase(),
  // Matches the records already on the live domains; there is no mailbox for aggregate reports, so no rua= by default.
  dmarc: process.env.POSTAL_DMARC_POLICY || "v=DMARC1; p=none;",
});

const resolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
let transport = resolver;
const setResolver = (next) => { transport = next || resolver; };

const norm = (host) => String(host || "").toLowerCase().replace(/\.$/, "");
const NOT_THERE = new Set(["ENODATA", "ENOTFOUND", "NXDOMAIN"]);
const flat = (records) => records.map((parts) => (Array.isArray(parts) ? parts.join("") : String(parts)));

/** The records a Postal domain needs. `dkimValue` is only known after Postal generates it, so DKIM lists what to look for. */
function expectedRecords(domain, { dkimSelector = null } = {}) {
  const c = config();
  return [
    { key: "mx", type: "MX", name: domain, value: `10 ${c.mxHost}`, purpose: "Delivers replies to the mail server", required: true },
    { key: "spf", type: "TXT", name: domain, value: `v=spf1 a mx include:${c.spfInclude} ~all`, purpose: "Authorizes the server to send for the domain", required: true },
    { key: "dkim", type: "TXT", name: dkimSelector ? `${dkimSelector}._domainkey.${domain}` : `<selector>._domainkey.${domain}`, value: dkimSelector ? "(copy the DKIM value Postal shows for this domain)" : "(set the DKIM selector Postal shows for this domain)", purpose: "Signs outgoing mail", required: false, manual: true },
    { key: "returnPath", type: "CNAME", name: `psrp.${domain}`, value: c.returnPathHost, purpose: "Return path (bounces)", required: false },
    { key: "dmarc", type: "TXT", name: `_dmarc.${domain}`, value: c.dmarc.replace("{domain}", domain), purpose: "Tells receivers how to treat failures", required: false },
  ];
}

/** One lookup. `Failed` = the record is missing or wrong. `Unknown` = the lookup itself failed (network), so nothing should change. */
async function lookup(fn) {
  try { return { ok: true, value: await fn() }; } catch (error) { return NOT_THERE.has(error.code) ? { ok: true, value: null } : { ok: false, error: error.code || error.message }; }
}

/**
 * Reads the domain's live DNS. Returns one status per record plus `unreliable` when any lookup could not be answered at all,
 * in which case callers must keep the domain's previous status rather than mark it failed.
 */
async function check(domain, { dkimSelector = null } = {}) {
  const c = config();
  const [mx, txt, dmarc, dkim, rp] = await Promise.all([
    lookup(() => transport.resolveMx(domain)),
    lookup(() => transport.resolveTxt(domain)),
    lookup(() => transport.resolveTxt(`_dmarc.${domain}`)),
    dkimSelector ? lookup(() => transport.resolveTxt(`${dkimSelector}._domainkey.${domain}`)) : Promise.resolve({ ok: true, skipped: true }),
    lookup(() => transport.resolveCname(`psrp.${domain}`)),
  ]);
  const verdict = (res, test) => (!res.ok ? "Unknown" : res.skipped ? "Not started" : res.value && test(res.value) ? "Success" : "Failed");
  const statuses = {
    mx: verdict(mx, (v) => v.some((r) => norm(r.exchange) === c.mxHost)),
    spf: verdict(txt, (v) => flat(v).some((t) => /^v=spf1/i.test(t) && t.toLowerCase().includes(`include:${c.spfInclude}`))),
    dmarc: verdict(dmarc, (v) => flat(v).some((t) => /^v=DMARC1/i.test(t))),
    dkim: verdict(dkim, (v) => flat(v).some((t) => /v=DKIM1|p=/i.test(t))),
    returnPath: verdict(rp, (v) => v.some((h) => norm(h) === c.returnPathHost)),
  };
  return { statuses, unreliable: [mx, txt, dmarc, dkim, rp].some((r) => !r.ok), errors: [mx, txt, dmarc, dkim, rp].filter((r) => !r.ok).map((r) => r.error) };
}

/** The domain's overall status from its checks. Sending needs the server to receive (MX) and be authorized (SPF). */
function overall(statuses) {
  if (statuses.mx === "Success" && statuses.spf === "Success") return "Verified";
  if (statuses.mx === "Failed" || statuses.spf === "Failed") return "Failed";
  return "Pending Verification";
}

module.exports = { config, expectedRecords, check, overall, setResolver };
