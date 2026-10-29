const { execFile } = require("child_process");

// Talks to the Postal install on the Hetzner server. Postal has no API for creating domains, so this runs a short Ruby script
// in Postal's own console over SSH (the same thing an admin would do by hand) and reads back one JSON line.
//
// Environment:
//   POSTAL_SSH_HOST        server address (required to turn this on)
//   POSTAL_SSH_USER        default root
//   POSTAL_SSH_KEY_PATH    private key file for that user
//   POSTAL_CONTAINER       default postal-web-1
//   POSTAL_SERVER_PERMALINK  the Postal mail server the domains belong to, default pilot
//   POSTAL_ENDPOINT_NAME   the HTTP endpoint that delivers replies to this app, default "Replai inbound"
//   POSTAL_DOMAINS_PER_POOL  how many domains share one sending IP pool, default 10

const cfg = () => ({
  host: process.env.POSTAL_SSH_HOST || "",
  user: process.env.POSTAL_SSH_USER || "root",
  keyPath: process.env.POSTAL_SSH_KEY_PATH || "",
  container: process.env.POSTAL_CONTAINER || "postal-web-1",
  serverPermalink: process.env.POSTAL_SERVER_PERMALINK || "pilot",
  endpointName: process.env.POSTAL_ENDPOINT_NAME || "Replai inbound",
  perPool: Math.max(1, parseInt(process.env.POSTAL_DOMAINS_PER_POOL, 10) || 10),
});

let runner = null;           // tests replace this: (rubySource) => Promise<stdout string>
const setRunner = (fn) => { runner = fn; };
const configured = () => Boolean(runner || cfg().host);
const fail = (message, statusCode = 502, code = "POSTAL_ADMIN_FAILED") => Object.assign(new Error(message), { statusCode, code });

const NAME_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
/** Only a plain domain name ever reaches a Ruby script. */
function assertDomain(name) {
  if (!NAME_RE.test(String(name))) throw fail("Not a valid domain name.", 400, "BAD_DOMAIN");
  return String(name);
}
const lit = (value) => JSON.stringify(String(value)); // a safe Ruby string literal for the plain values we pass

function ssh(source) {
  const c = cfg();
  return new Promise((resolve, reject) => {
    const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=yes", ...(c.keyPath ? ["-i", c.keyPath] : []), `${c.user}@${c.host}`, `timeout 120 docker exec -i ${c.container} postal console`];
    const child = execFile("ssh", args, { timeout: 150000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(fail(/Permission denied|Host key|Connection (refused|timed out)|Could not resolve/i.test(`${stderr}`) ? `Couldn't reach the mail server: ${String(stderr).trim().split("\n").pop()}` : "The mail server command failed.", 502, "POSTAL_UNREACHABLE"));
      resolve(stdout);
    });
    child.stdin.end(source);
  });
}

/** Runs a script and returns the JSON it printed between the markers. */
async function run(source) {
  if (!configured()) throw fail("The mail server connection isn't set up on this server (POSTAL_SSH_HOST).", 503, "POSTAL_NOT_CONFIGURED");
  const out = await (runner ? runner(source) : ssh(source));
  const m = /__JSON_BEGIN__([\s\S]*?)__JSON_END__/.exec(String(out));
  if (!m) throw fail("The mail server didn't return a result.", 502, "POSTAL_NO_RESULT");
  let data;
  try { data = JSON.parse(m[1]); } catch { throw fail("The mail server returned something unreadable.", 502, "POSTAL_BAD_RESULT"); }
  if (data.error) throw fail(`The mail server refused: ${String(data.error).slice(0, 300)}`, 422, "POSTAL_REFUSED");
  return data;
}

const wrap = (body) => `require "json"
out = {}
begin
${body}
rescue => e
  out = { error: "#{e.class}: #{e.message}" }
end
puts "__JSON_BEGIN__" + out.to_json + "__JSON_END__"
`;

const recordsRuby = `out[:records] = { verification: domain.dns_verification_string, spf: domain.spf_record, dkim_name: domain.dkim_record_name, dkim: domain.dkim_record,
  return_path: domain.return_path_domain, return_target: Postal::Config.dns.return_path_domain, mx: Postal::Config.dns.mx_records, verified: domain.verified? }`;

/**
 * Creates (or finds) the domain in Postal, gives it a catch-all route to this app's inbound endpoint and puts it on the
 * least-loaded sending IP pool. Idempotent. dryRun rolls everything back and only reports what would happen.
 */
function provisionScript(name, { dryRun = false } = {}) {
  const c = cfg();
  return wrap(`ActiveRecord::Base.transaction do
  server = Server.find_by!(permalink: ${lit(c.serverPermalink)})
  domain = Domain.find_by(name: ${lit(name)}, owner_type: "Server", owner_id: server.id)
  out[:existed] = !domain.nil?
  domain ||= Domain.create!(owner: server, name: ${lit(name)}, verification_method: "DNS")
  endpoint = HTTPEndpoint.find_by!(server_id: server.id, name: ${lit(c.endpointName)})
  route = Route.find_by(server_id: server.id, domain_id: domain.id, name: "*") || Route.create!(server: server, name: "*", domain: domain, endpoint: endpoint, mode: "Endpoint", spam_mode: "Mark")
  rule = IPPoolRule.where(owner_type: "Server", owner_id: server.id, from_text: ${lit(name)}).first
  if rule
    pool = rule.ip_pool
  else
    load = IPPool.all.map { |p| [p, IPPoolRule.where(ip_pool_id: p.id).count] }
    pick = load.select { |_, n| n < ${c.perPool} }.min_by { |_, n| n }
    raise "Every sending IP pool already has ${c.perPool} domains. Add another IP first." unless pick
    pool = pick[0]
    IPPoolRule.create!(owner: server, ip_pool_id: pool.id, from_text: ${lit(name)})
  end
  ip = IPAddress.where(ip_pool_id: pool.id).first
  out[:route] = { mode: route.mode, endpoint: route.endpoint.name }
  out[:pool] = { id: pool.id, name: pool.name, ip: ip && ip.ipv4, hostname: ip && ip.hostname }
  ${recordsRuby}
  ${dryRun ? "raise ActiveRecord::Rollback" : ""}
end`);
}

/** Asks Postal to verify the domain's ownership record and re-check its DNS, and returns what Postal now thinks. */
function checkScript(name) {
  const c = cfg();
  return wrap(`server = Server.find_by!(permalink: ${lit(c.serverPermalink)})
domain = Domain.find_by!(name: ${lit(name)}, owner_type: "Server", owner_id: server.id)
domain.verify_with_dns unless domain.verified?
domain.check_dns(:manual)
domain.reload
out[:status] = { verified: domain.verified?, spf: domain.spf_status, dkim: domain.dkim_status, mx: domain.mx_status, return_path: domain.return_path_status, dns_ok: domain.dns_ok?,
  errors: { spf: domain.spf_error, dkim: domain.dkim_error, mx: domain.mx_error, return_path: domain.return_path_error } }
${recordsRuby}`);
}

/** Read-only: every domain Postal knows about for this server, with its sending IP pool. */
function listScript() {
  const c = cfg();
  return wrap(`server = Server.find_by!(permalink: ${lit(c.serverPermalink)})
rules = IPPoolRule.where(owner_type: "Server", owner_id: server.id).to_a
out[:domains] = Domain.where(owner_type: "Server", owner_id: server.id).map do |d|
  rule = rules.find { |r| r.from.include?(d.name) }
  pool = rule && rule.ip_pool
  ip = pool && IPAddress.where(ip_pool_id: pool.id).first
  { name: d.name, verified: d.verified?, spf: d.spf_status, dkim: d.dkim_status, mx: d.mx_status, return_path: d.return_path_status, dkim_identifier: d.dkim_identifier,
    pool: pool && pool.name, ip: ip && ip.ipv4, hostname: ip && ip.hostname }
end
out[:pools] = IPPool.all.map { |p| { name: p.name, domains: IPPoolRule.where(ip_pool_id: p.id).count } }
out[:per_pool] = ${c.perPool}`);
}

const provision = (name, opts) => run(provisionScript(assertDomain(name), opts));
const checkDns = (name) => run(checkScript(assertDomain(name)));
const listDomains = () => run(listScript());

module.exports = { configured, provision, checkDns, listDomains, setRunner, provisionScript, checkScript, listScript, assertDomain, cfg };
