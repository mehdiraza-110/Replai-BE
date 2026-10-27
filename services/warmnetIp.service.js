const dns = require("dns");
const db = require("../config/db.config");
const { WorkspaceError } = require("./workspace.service");

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const BLOCKLISTS = [
  { name: "Barracuda", zone: "b.barracudacentral.org" },
  { name: "SpamCop", zone: "bl.spamcop.net" },
  { name: "PSBL", zone: "psbl.surriel.com" },
  { name: "UCEProtect L1", zone: "dnsbl-1.uceprotect.net" },
  { name: "UCEProtect L2", zone: "dnsbl-2.uceprotect.net" },
  { name: "DroneBL", zone: "dnsbl.dronebl.org" },
  { name: "Mailspike", zone: "bl.mailspike.net" },
  { name: "SpamRats (dyna)", zone: "dyna.spamrats.com" },
  { name: "SpamRats (spam)", zone: "spam.spamrats.com" },
];

const publicResolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
publicResolver.setServers(["8.8.8.8", "1.1.1.1"]);

const reverse = (ip) => ip.split(".").reverse().join(".");

function classify(error, addresses) {
  if (addresses && addresses.length) {
    // 127.255.255.x is a "you are querying through a blocked resolver" answer, not a listing.
    if (addresses.every((a) => a.startsWith("127.255.255."))) return "unchecked";
    return "listed";
  }
  if (error && (error.code === "ENOTFOUND" || error.code === "ENODATA")) return "clean";
  return "unchecked";
}

async function lookup(resolver, name) {
  try {
    return classify(null, await resolver.resolve4(name));
  } catch (error) {
    return classify(error, null);
  }
}

/** Spamhaus refuses public resolvers, so ask its own nameserver directly. */
async function checkSpamhaus(rev) {
  try {
    const ns = await publicResolver.resolve4("d.gns.spamhaus.org");
    const direct = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
    direct.setServers([ns[0]]);
    return await lookup(direct, `${rev}.zen.spamhaus.org`);
  } catch {
    return "unchecked";
  }
}

async function checkIp(ip) {
  const rev = reverse(ip);
  const [spamhaus, ...others] = await Promise.all([checkSpamhaus(rev), ...BLOCKLISTS.map((b) => lookup(publicResolver, `${rev}.${b.zone}`))]);
  const listings = [];
  const unchecked = [];
  if (spamhaus === "listed") listings.push("Spamhaus ZEN");
  if (spamhaus === "unchecked") unchecked.push("Spamhaus ZEN");
  BLOCKLISTS.forEach((b, i) => {
    if (others[i] === "listed") listings.push(b.name);
    if (others[i] === "unchecked") unchecked.push(b.name);
  });
  return { listings, unchecked, clean: listings.length === 0 };
}

const iso = (v) => (v ? new Date(v).toISOString() : null);
const mapIp = (r) => ({
  id: r.id,
  ip: r.ip,
  hostname: r.hostname,
  poolName: r.pool_name,
  notes: r.notes,
  clean: r.clean,
  listings: r.listings || [],
  unchecked: r.unchecked || [],
  lastCheckedAt: iso(r.last_checked_at),
  domains: Number(r.domains || 0),
  mailboxes: Number(r.mailboxes || 0),
});

class WarmnetIpService {
  blocklists() {
    return BLOCKLISTS.map((b) => b.name).concat("Spamhaus ZEN");
  }

  async list() {
    const { rows } = await db.query(
      `SELECT i.*,
         (SELECT COUNT(*) FROM warmnet_domains wd WHERE wd.ip_id = i.id) AS domains,
         (SELECT COUNT(*) FROM warmnet_domains wd JOIN mailboxes m ON m.domain_id = wd.domain_id AND m.is_deleted = FALSE WHERE wd.ip_id = i.id) AS mailboxes
       FROM warmnet_ips i ORDER BY i.id`
    );
    return rows.map(mapIp);
  }

  async add({ ip, hostname, poolName, notes }) {
    const value = String(ip || "").trim();
    if (!IPV4_RE.test(value)) throw new WorkspaceError("Enter a valid IPv4 address.", 400);
    try {
      const { rows } = await db.query(
        `INSERT INTO warmnet_ips (ip, hostname, pool_name, notes) VALUES ($1, $2, $3, $4) RETURNING *`,
        [value, String(hostname || "").trim() || null, String(poolName || "").trim() || null, String(notes || "").trim() || null]
      );
      await this.check(rows[0].id).catch(() => {});
      return (await this.list()).find((i) => i.id === rows[0].id);
    } catch (error) {
      if (error.code === "23505") throw new WorkspaceError("That IP is already listed.", 409);
      throw error;
    }
  }

  async remove(id) {
    const { rowCount } = await db.query(`DELETE FROM warmnet_ips WHERE id = $1`, [id]);
    if (!rowCount) throw new WorkspaceError("That IP could not be found.", 404);
  }

  async check(id) {
    const { rows } = await db.query(`SELECT ip FROM warmnet_ips WHERE id = $1`, [id]);
    if (!rows[0]) throw new WorkspaceError("That IP could not be found.", 404);
    const result = await checkIp(rows[0].ip);
    await db.query(
      `UPDATE warmnet_ips SET clean = $2, listings = $3::jsonb, unchecked = $4::jsonb, last_checked_at = NOW() WHERE id = $1`,
      [id, result.clean, JSON.stringify(result.listings), JSON.stringify(result.unchecked)]
    );
    return { id, ...result };
  }

  async checkAll() {
    const { rows } = await db.query(`SELECT id FROM warmnet_ips ORDER BY id`);
    const out = [];
    for (const r of rows) out.push(await this.check(r.id));
    return out;
  }
}

module.exports = new WarmnetIpService();
module.exports.checkIp = checkIp;
