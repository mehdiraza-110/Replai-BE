const dns = require("dns");

// Cheap pre-send check that catches the addresses certain to bounce: a malformed address, or a domain that has no mail server at
// all (it doesn't exist, has no MX and no address record, or publishes a "null MX" meaning it refuses mail). Bounces on a new
// sending IP are expensive, and these are the avoidable ones. A lookup that can't be answered (timeout, DNS outage) never blocks
// a send: only a definite "no mail server" does.
//
// Off unless LEAD_VERIFY_DNS=on, so sandboxes and tests that send to made-up addresses are unaffected.

const resolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
let transport = resolver;
const setResolver = (next) => { transport = next || resolver; cache.clear(); };

const TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map();

const enabled = () => String(process.env.LEAD_VERIFY_DNS || "").toLowerCase() === "on";
const NO_ANSWER = new Set(["ENODATA", "ENOTFOUND", "NXDOMAIN"]);
const SYNTAX = /^[^\s@<>()[\]\\,;:"]+@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/i;

/** One lookup that tells "definitely nothing there" (value null) from "couldn't ask" (unknown). */
async function look(fn) {
  try { return { value: await fn() }; } catch (error) { return NO_ANSWER.has(error.code) ? { value: null, code: error.code } : { unknown: true, code: error.code }; }
}

/** Can this domain receive mail? Returns { deliverable: true|false|null, reason }. null = couldn't tell, treat as deliverable. */
async function domainCanReceive(domain) {
  const hit = cache.get(domain);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.result;

  const mx = await look(() => transport.resolveMx(domain));
  let result;
  if (mx.unknown) result = { deliverable: null, reason: `DNS lookup failed (${mx.code})` };
  else if (mx.value && mx.value.length) {
    result = mx.value.every((r) => !r.exchange || r.exchange === ".")
      ? { deliverable: false, reason: "The domain refuses mail (null MX)" }
      : { deliverable: true, reason: "MX found" };
  } else if (mx.code === "ENOTFOUND" || mx.code === "NXDOMAIN") {
    result = { deliverable: false, reason: "The domain doesn't exist" };
  } else {
    // No MX: mail servers fall back to the domain's own address record.
    const [a, aaaa] = await Promise.all([look(() => transport.resolve4(domain)), look(() => transport.resolve6(domain))]);
    if (a.unknown && aaaa.unknown) result = { deliverable: null, reason: `DNS lookup failed (${a.code})` };
    else if ((a.value && a.value.length) || (aaaa.value && aaaa.value.length)) result = { deliverable: true, reason: "No MX, but the domain has an address record" };
    else result = { deliverable: false, reason: "The domain has no mail server" };
  }
  if (result.deliverable !== null) cache.set(domain, { at: Date.now(), result });
  return result;
}

/** Checks one email address. `skipped` when the check is switched off. */
async function checkAddress(email) {
  if (!enabled()) return { deliverable: true, skipped: true };
  const match = SYNTAX.exec(String(email || "").trim());
  if (!match) return { deliverable: false, reason: "Not a valid email address" };
  return domainCanReceive(match[1].toLowerCase());
}

module.exports = { checkAddress, domainCanReceive, setResolver, enabled };
