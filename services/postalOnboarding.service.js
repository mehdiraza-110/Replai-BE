const db = require("../config/db.config");
const postalAdmin = require("./postalAdmin.service");
const porkbun = require("./porkbun.service");
const postalDns = require("./postalDns.service");
const warmnet = require("./warmnet.service");

const MAX_PER_REQUEST = 50;
const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const selectorOf = (dkimName) => String(dkimName || "").replace(/\._domainkey$/, "") || null;

/** The records Postal wants for a domain, in the shape the DNS host needs them. */
function recordsFrom(domain, r) {
  const c = postalDns.config();
  return [
    { key: "mx", type: "MX", name: domain, value: `10 ${(r.mx && r.mx[0]) || c.mxHost}` },
    { key: "verification", type: "TXT", name: domain, value: r.verification },
    { key: "spf", type: "TXT", name: domain, value: r.spf },
    { key: "dkim", type: "TXT", name: `${r.dkim_name}.${domain}`, value: r.dkim, exclusive: true },
    { key: "returnPath", type: "CNAME", name: r.return_path, value: r.return_target || c.returnPathHost },
    { key: "dmarc", type: "TXT", name: `_dmarc.${domain}`, value: c.dmarc.replace("{domain}", domain) },
  ].filter((rec) => rec.value);
}

/** What onboarding needs and whether this server has it. */
function readiness() {
  return { mailServer: postalAdmin.configured(), dns: porkbun.configured(), perPool: postalAdmin.cfg().perPool };
}

/**
 * Brings domains onto our own mail server: confirm we own it at Porkbun, create it in Postal (with its reply route and a sending IP),
 * add the DNS records Postal asked for, then register it here with its inboxes. One domain failing never stops the rest.
 * dryRun reports what would happen and changes nothing anywhere.
 */
async function onboard(actorId, input = {}) {
  const ready = readiness();
  if (!ready.mailServer) throw bad("The mail server connection isn't set up on this server yet (POSTAL_SSH_HOST).", 503);
  if (!ready.dns) throw bad("Porkbun isn't connected on this server yet (PORKBUN_API_KEY and PORKBUN_API_SECRET).", 503);
  const names = [...new Set((Array.isArray(input.domains) ? input.domains : []).map((d) => String(d || "").trim().toLowerCase()).filter(Boolean))];
  if (!names.length) throw bad("Provide at least one domain.");
  if (names.length > MAX_PER_REQUEST) throw bad(`At most ${MAX_PER_REQUEST} domains at a time.`);
  const dryRun = Boolean(input.dryRun);
  const owned = new Set(await porkbun.listDomains());
  const results = [];

  for (const name of names) {
    const steps = [];
    const step = (key, ok, detail) => steps.push({ step: key, ok, detail });
    try {
      postalAdmin.assertDomain(name);
      const { rows: have } = await db.query(`SELECT id FROM domains WHERE domain = $1 AND COALESCE(is_deleted, FALSE) = FALSE`, [name]);
      if (have[0]) throw bad("This domain is already in the system.", 409);
      if (!owned.has(name)) throw bad("This domain isn't in the Porkbun account, so its DNS can't be set up here.", 422);
      step("porkbun", true, "Domain found in Porkbun.");

      const post = await postalAdmin.provision(name, { dryRun });
      step("postal", true, `${post.existed ? "Already in" : dryRun ? "Would be added to" : "Added to"} the mail server; replies route to this app; sending IP pool ${post.pool?.name || "none"}.`);

      const dns = await porkbun.applyRecords(name, recordsFrom(name, post.records), { dryRun });
      step("dns", dns.conflicts.length === 0, `${dryRun ? "Would add" : "Added"} ${dns.added.length} record(s), ${dns.alreadyThere.length} already there${dns.conflicts.length ? `, ${dns.conflicts.length} conflict(s) to fix by hand (${dns.conflicts.map((c) => c.key).join(", ")})` : ""}.`);

      if (dryRun) { results.push({ domain: name, ok: true, dryRun: true, steps, pool: post.pool, dns }); continue; }

      // Postal checks the records itself; right after adding them DNS usually hasn't spread yet, so this is best effort.
      const verify = await postalAdmin.checkDns(name).catch((e) => ({ error: e.message }));
      step("verify", !verify.error && verify.status?.verified === true, verify.error ? "Postal couldn't be asked just now." : verify.status.verified ? "Postal has verified the domain." : "DNS hasn't spread yet. Use Re-check in a few minutes.");

      const reg = await warmnet.registerDomains(actorId, {
        domains: [{ domain: name, ip: post.pool?.ip, hostname: post.pool?.hostname, pool: post.pool?.name, dkimSelector: selectorOf(post.records.dkim_name) }],
        mailboxesPerDomain: input.mailboxesPerDomain, workspaceId: input.workspaceId, autoStart: input.autoStart,
      });
      const r = reg.results[0];
      step("app", Boolean(r?.ok), r?.ok ? `Registered with ${r.mailboxes} inbox(es), queued for warm-up.` : r?.error || "Could not register.");
      results.push({ domain: name, ok: Boolean(r?.ok), steps, pool: post.pool, dns, needsAttention: dns.conflicts.length > 0 });
    } catch (error) {
      step("failed", false, error.message);
      results.push({ domain: name, ok: false, steps, error: error.message });
    }
  }
  return { dryRun, requested: names.length, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}

/** Domains that already exist in Postal but not in the app (set up by hand or by an earlier run): add them, without inventing inboxes. */
async function syncFromPostal(actorId, { workspaceId } = {}) {
  if (!postalAdmin.configured()) throw bad("The mail server connection isn't set up on this server yet (POSTAL_SSH_HOST).", 503);
  const live = await postalAdmin.listDomains();
  const { rows: mine } = await db.query(`SELECT domain FROM domains WHERE COALESCE(is_deleted, FALSE) = FALSE`);
  const known = new Set(mine.map((r) => r.domain.toLowerCase()));
  const missing = live.domains.filter((d) => !known.has(d.name.toLowerCase()));
  const added = [];
  const failed = [];
  for (const d of missing) {
    const reg = await warmnet.registerDomains(actorId, { domains: [{ domain: d.name, ip: d.ip, hostname: d.hostname, pool: d.pool, dkimSelector: d.dkim_identifier }], mailboxesPerDomain: 0, workspaceId });
    (reg.results[0]?.ok ? added : failed).push(reg.results[0]?.ok ? d.name : { domain: d.name, error: reg.results[0]?.error });
  }
  return { inPostal: live.domains.length, alreadyHere: live.domains.length - missing.length, added, failed, pools: live.pools, perPool: live.per_pool };
}

module.exports = { onboard, syncFromPostal, readiness, recordsFrom, MAX_PER_REQUEST };
