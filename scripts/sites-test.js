// Verifies Sites (AI-built websites) in the LOCAL sandbox. The model is stubbed; nothing leaves the machine.
//   ./dev-local.sh node scripts/sites-test.js
const BE = require("path").resolve(__dirname, "..");
const assert = require("assert");
const db = require(`${BE}/config/db.config`);
const llm = require(`${BE}/services/ai/llm.service`);
const sites = require(`${BE}/services/ai/sites.service`);
const { sanitize, SERVE_HEADERS } = require(`${BE}/services/ai/siteHtml`);

let pass = 0, fail = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log("  PASS", name); }, (e) => { fail++; console.log("  FAIL", name, "->", e.message); });
const stamp = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label) { for (let i = 0; i < 80; i++) { const v = await fn(); if (v) return v; await sleep(40); } throw new Error(`timed out: ${label}`); }

const PAGE = (title = "Acme Plumbing") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font-family:system-ui;margin:0}header{padding:48px;background:linear-gradient(135deg,#0b6bff,#7c3aed);color:#fff}section{padding:32px}</style></head><body><header><h1>${title}</h1><p>Fast, honest plumbing for homes in Austin.</p></header><main><section><h2>Services</h2><ul><li>Leak repair</li><li>Water heaters</li></ul></section><section><h2>Get in touch</h2><p>Tell us what's wrong and we'll call you back.</p></section></main><footer><p>© ${title}</p></footer></body></html>`;
let reply = async () => PAGE();
let seen = [];
llm.setTransport(async (req) => { seen.push(req); const r = await reply(req); if (r instanceof Error) throw r; return r; });

(async () => {
  const ws = (await db.query(`INSERT INTO workspaces (name, slug) VALUES ($1,$2) RETURNING id`, [`Sites ${stamp}`, `sites-${stamp}`])).rows[0].id;
  const other = (await db.query(`INSERT INTO workspaces (name, slug) VALUES ($1,$2) RETURNING id`, [`Sites2 ${stamp}`, `sites2-${stamp}`])).rows[0].id;
  const ann = (await db.query(`INSERT INTO users (first_name, last_name, email, password_hash) VALUES ('Ann','Tester',$1,'x') RETURNING id`, [`ann-${stamp}@sites.invalid`])).rows[0].id;
  const settle = (id, w = ws) => until(async () => { const s = await sites.get(w, id); return s.status !== "processing" && s; }, "site settle");

  console.log("\n[1] the HTML sanitizer");
  await check("scripts, frames, forms, handlers and bad URLs are removed; normal markup survives", () => {
    const out = sanitize('<html><head><script>x()</script><style>@import url(//e);a{background:url(javascript:1)}h1{color:red}</style><link rel=stylesheet href=http://evil/x.css></head><body onload=1><h1 onclick=a()>Hi</h1><a href="javascript:alert(1)">bad</a><a href="https://ok.com/p">ok</a><iframe src=//e></iframe><form action=//x><input name=a><button>Go</button></form><img src=x onerror=1><img src="https://i.com/a.png" alt="a"><svg viewBox="0 0 4 4"><path d="M0 0"/></svg></body></html>');
    for (const needle of ["<script", "onload", "onclick", "javascript:", "<iframe", "<form", "<input", "onerror", "evil", "@import"]) assert.ok(!out.toLowerCase().includes(needle), `still contains ${needle}: ${out}`);
    assert.match(out, /<h1[^>]*>Hi<\/h1>/); assert.match(out, /href="https:\/\/ok\.com\/p"/); assert.match(out, /rel="noopener noreferrer nofollow"/);
    assert.match(out, /<img src="https:\/\/i\.com\/a\.png"/); assert.match(out, /<path d="M0 0" \/>/); assert.match(out, /h1\{color:red\}/);
    assert.ok(out.startsWith("<!doctype html>")); assert.equal((out.match(/<img/g) || []).length, 1);
  });
  await check("Google Fonts links are kept, other stylesheets dropped; data:image allowed, other data: dropped", () => {
    const out = sanitize('<html><head><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"><link rel="stylesheet" href="https://cdn.evil.com/a.css"></head><body><img src="data:image/png;base64,AAAA"><img src="data:text/html;base64,AAAA"><div style="background:url(http://x/y.png);color:blue">z</div></body></html>');
    assert.match(out, /fonts\.googleapis\.com\/css2/); assert.ok(!out.includes("cdn.evil.com")); assert.match(out, /data:image\/png/); assert.ok(!out.includes("text/html")); assert.match(out, /color:blue/); assert.ok(!out.includes("http://x/y.png"));
  });
  await check("unclosed and nested junk still yields a balanced document; oversized pages are refused", () => {
    const out = sanitize("<div><p>one<div>two<span>three");
    assert.equal((out.match(/<div>/g) || []).length, (out.match(/<\/div>/g) || []).length); assert.match(out, /<body>/);
    assert.throws(() => sanitize(`<p>${"x".repeat(900000)}</p>`), /too large/);
  });
  await check("served pages carry a CSP with no script, no frames and a sandbox", () => {
    const csp = SERVE_HEADERS["Content-Security-Policy"];
    assert.match(csp, /default-src 'none'/); assert.ok(!/script-src/.test(csp)); assert.match(csp, /frame-ancestors 'none'/); assert.match(csp, /sandbox/); assert.equal(SERVE_HEADERS["X-Content-Type-Options"], "nosniff");
  });

  console.log("\n[2] creating a site");
  await check("needs a description or a template", async () => {
    await assert.rejects(() => sites.create(ws, ann, { prompt: "hi" }), /Describe the website/);
    await assert.rejects(() => sites.create(ws, ann, { prompt: "x".repeat(4001) }), /under 4,000/);
  });
  let s1;
  await check("builds in the background; the page is sanitized and the prompt reaches the model", async () => {
    reply = async () => `\`\`\`html\n${PAGE().replace("<main>", "<script>steal()</script><main>")}\n\`\`\``;
    const created = await sites.create(ws, ann, { prompt: "A site for Acme Plumbing in Austin: leak repair and water heaters.", template: "local" });
    s1 = created.id; assert.equal(created.status, "processing"); assert.equal(created.template, "local"); assert.match(created.slug, /^a-site-for-acme-plumbing-in-austin-leak-[0-9a-f]{6}$/);
    const done = await settle(s1);
    assert.equal(done.status, "ready", done.error); assert.ok(!done.html.includes("<script")); assert.match(done.html, /Acme Plumbing/); assert.ok(!done.html.includes("```"));
    const sys = seen.at(-1); assert.match(sys.system, /NO JavaScript/); assert.match(sys.messages[0].content, /local service business/i); assert.match(sys.messages[0].content, /leak repair/);
    assert.equal(done.createdBy, "Ann Tester"); assert.equal(done.isPublished, false);
  });
  await check("a template alone is enough; slugs stay unique for the same name", async () => {
    const a = await sites.create(ws, ann, { template: "landing", name: "Same" }); const b = await sites.create(ws, ann, { template: "landing", name: "Same" });
    assert.notEqual(a.slug, b.slug); await settle(a.id); await settle(b.id);
  });
  await check("a model failure or an empty page marks it failed with a reason; regenerate recovers", async () => {
    reply = async () => new Error("down");
    const f = await sites.create(ws, ann, { prompt: "A site for a bakery that sells sourdough." });
    const failed = await settle(f.id); assert.equal(failed.status, "failed"); assert.match(failed.error, /couldn't answer/i);
    reply = async () => "<html><body></body></html>";
    await sites.regenerate(ws, f.id); const empty = await settle(f.id); assert.equal(empty.status, "failed"); assert.match(empty.error, /empty/i);
    reply = async () => PAGE("Bakery"); await sites.regenerate(ws, f.id); const ok = await settle(f.id); assert.equal(ok.status, "ready"); assert.equal(ok.error, null);
  });

  console.log("\n[2b] invented contact details");
  await check("an invented email or phone triggers one corrective retry; given details are kept", async () => {
    let calls = 0;
    reply = async () => { calls++; return calls === 1 ? PAGE("Cafe").replace("<footer>", '<footer><a href="mailto:info@madeup.com">info@madeup.com</a> Call 512-555-0199 or hello@cafe.test') : PAGE("Cafe").replace("<footer>", '<footer><a href="mailto:hello@cafe.test">hello@cafe.test</a>'); };
    const c = await sites.create(ws, ann, { prompt: "A site for Cafe. Email hello@cafe.test to book a table." }); const d = await settle(c.id);
    assert.equal(calls, 2); assert.ok(!d.html.includes("madeup")); assert.ok(!d.html.includes("555")); assert.match(d.html, /hello@cafe\.test/);
    assert.match(seen.at(-1).messages.at(-1).content, /info@madeup\.com/);
  });
  await check("if the model keeps inventing them they are stripped, links included", async () => {
    reply = async () => PAGE("Cafe").replace("<footer>", '<footer><a href="mailto:ghost@made.up">ghost@made.up</a> +1 (415) 555-0100');
    const c = await sites.create(ws, ann, { prompt: "A site for a cafe with no contact details given at all." }); const d = await settle(c.id);
    assert.ok(!d.html.includes("ghost")); assert.ok(!d.html.includes("555")); assert.equal(d.status, "ready");
  });
  await check("numbers in CSS and details that came from the earlier page are not mistaken for invented ones", async () => {
    reply = async () => PAGE("Cafe").replace("margin:0", "margin:0;width:1000000000px");
    const c = await sites.create(ws, ann, { prompt: "A site for a cafe, plain and simple please." }); const d = await settle(c.id);
    assert.match(d.html, /1000000000px/);
  });

  console.log("\n[3] changing a site");
  await check("a change request sends the current page, saves the old one as a version, and updates the page", async () => {
    reply = async () => PAGE("Acme Plumbing & Heating");
    const before = await sites.get(ws, s1);
    await sites.revise(ws, s1, "Add heating to the name");
    const done = await settle(s1); assert.equal(done.status, "ready", done.error); assert.match(done.html, /Heating/);
    assert.match(seen.at(-1).messages[0].content, /Fast, honest plumbing/); assert.match(seen.at(-1).messages[0].content, /Add heating to the name/);
    const v = await sites.versions(ws, s1); assert.equal(v.length, 1); assert.match(v[0].note, /Add heating/);
    assert.notEqual(before.html, done.html);
  });
  await check("a failed change keeps the page exactly as it was and says why", async () => {
    const before = await sites.get(ws, s1); reply = async () => new Error("down");
    await sites.revise(ws, s1, "Make it blue"); const after = await settle(s1);
    assert.equal(after.html, before.html); assert.equal(after.status, "ready"); assert.match(after.error, /couldn't answer/i);
  });
  await check("input checks and no overlapping changes", async () => {
    await assert.rejects(() => sites.revise(ws, s1, "x"), /what to change/i);
    reply = async () => { await sleep(150); return PAGE("Slow"); };
    await sites.revise(ws, s1, "Slow one"); await assert.rejects(() => sites.revise(ws, s1, "Second at once"), /already being updated/);
    await settle(s1);
  });
  await check("restore brings back an older page and keeps the current one as a version", async () => {
    const v = await sites.versions(ws, s1); const oldest = v.at(-1);
    const restored = await sites.restore(ws, s1, oldest.id); assert.match(restored.html, /Acme Plumbing/);
    assert.equal((await sites.versions(ws, s1)).length, v.length + 1);
    await assert.rejects(() => sites.restore(ws, s1, 99999999), /no longer exists/);
  });
  await check("only the 15 most recent versions are kept", async () => {
    reply = async () => PAGE("Loop");
    for (let i = 0; i < 17; i++) { await sites.revise(ws, s1, `Change ${i}`); await settle(s1); }
    assert.equal((await sites.versions(ws, s1)).length, 15);
  });
  await check("rename works and an empty name is refused", async () => {
    assert.equal((await sites.rename(ws, s1, "  Main site ")).name, "Main site"); await assert.rejects(() => sites.rename(ws, s1, "  "), /name/i);
  });

  console.log("\n[4] publishing");
  await check("not published -> 404; published -> the snapshot, with the locked-down headers", async () => {
    const slug = (await sites.get(ws, s1)).slug;
    assert.equal((await sites.servePublic({ slug })).status, 404);
    const pub = await sites.publish(ws, s1); assert.equal(pub.isPublished, true); assert.equal(pub.hasUnpublishedChanges, false);
    const out = await sites.servePublic({ slug }); assert.equal(out.status, 200); assert.match(out.body, /Loop/); assert.match(out.headers["Content-Security-Policy"], /default-src 'none'/);
  });
  await check("edits after publishing don't change the live page until it is published again", async () => {
    const slug = (await sites.get(ws, s1)).slug; reply = async () => PAGE("Draft only");
    await sites.revise(ws, s1, "Draft change"); const d = await settle(s1); assert.equal(d.hasUnpublishedChanges, true);
    assert.match((await sites.servePublic({ slug })).body, /Loop/); assert.ok(!(await sites.servePublic({ slug })).body.includes("Draft only"));
    await sites.publish(ws, s1); assert.match((await sites.servePublic({ slug })).body, /Draft only/);
  });
  await check("unpublish takes it offline", async () => {
    const slug = (await sites.get(ws, s1)).slug; await sites.unpublish(ws, s1); assert.equal((await sites.servePublic({ slug })).status, 404);
  });
  await check("a site with no page can't be published", async () => {
    reply = async () => new Error("down"); const f = await sites.create(ws, ann, { prompt: "A site that will fail to build." }); await settle(f.id);
    await assert.rejects(() => sites.publish(ws, f.id), /nothing to publish/i);
  });

  console.log("\n[5] custom domains");
  let resolver = { resolveCname: async () => { throw Object.assign(new Error("none"), { code: "ENODATA" }); } };
  sites.setResolver({ resolveCname: (h) => resolver.resolveCname(h) });
  await check("domain checks: format, reserved names, one site per domain", async () => {
    await assert.rejects(() => sites.setDomain(ws, s1, "not a domain"), /like www/);
    await assert.rejects(() => sites.setDomain(ws, s1, "sites.sendvybe.com"), /can't be used/);
    const r = await sites.setDomain(ws, s1, "https://WWW.Acme-Plumbing.test/path"); assert.equal(r.customDomain, "www.acme-plumbing.test"); assert.equal(r.domainStatus, "pending"); assert.equal(r.dns.type, "CNAME");
    const s2 = (await db.query(`SELECT id FROM sites WHERE workspace_id = $1 AND id <> $2 LIMIT 1`, [ws, s1])).rows[0].id;
    await assert.rejects(() => sites.setDomain(ws, s2, "www.acme-plumbing.test"), /already connected/);
  });
  await check("verification: wrong target stays pending with the reason; right target verifies; a DNS outage changes nothing", async () => {
    let r = await sites.checkDomain(ws, s1); assert.equal(r.domainStatus, "pending"); assert.match(r.detail, /No CNAME/);
    resolver = { resolveCname: async () => ["elsewhere.example."] }; r = await sites.checkDomain(ws, s1); assert.equal(r.domainStatus, "pending"); assert.match(r.detail, /instead of/);
    resolver = { resolveCname: async () => ["sites.sendvybe.com."] }; r = await sites.checkDomain(ws, s1); assert.equal(r.domainStatus, "verified");
    resolver = { resolveCname: async () => { throw Object.assign(new Error("t"), { code: "ETIMEOUT" }); } }; r = await sites.checkDomain(ws, s1); assert.equal(r.domainStatus, "verified"); assert.match(r.detail, /try again/i);
  });
  await check("the domain serves the site only when verified AND published", async () => {
    assert.equal((await sites.servePublic({ host: "www.acme-plumbing.test" })).status, 404);
    await sites.publish(ws, s1); assert.equal((await sites.servePublic({ host: "WWW.acme-plumbing.test" })).status, 200);
    await sites.setDomain(ws, s1, "www.acme-plumbing.test"); assert.equal((await sites.servePublic({ host: "www.acme-plumbing.test" })).status, 404, "pending domains don't serve");
    await sites.setDomain(ws, s1, ""); assert.equal((await sites.get(ws, s1)).customDomain, null);
  });

  console.log("\n[6] isolation, limits, cleanup");
  await check("sites are private to their workspace", async () => {
    await assert.rejects(() => sites.get(other, s1), /not found/i); await assert.rejects(() => sites.remove(other, s1), /not found/i);
    await assert.rejects(() => sites.publish(other, s1), /not found/i); await assert.rejects(() => sites.revise(other, s1, "hack"), /not found/i);
    assert.equal((await sites.list(other)).items.length, 0);
  });
  await check("a stuck build is shown as failed and can be retried", async () => {
    const id = (await db.query(`INSERT INTO sites (workspace_id, user_id, name, slug, prompt, status, started_at) VALUES ($1,$2,'Stuck',$3,'x','processing', NOW() - INTERVAL '2 hours') RETURNING id`, [ws, ann, `stuck-${stamp}`])).rows[0].id;
    await sites.list(ws); assert.equal((await sites.get(ws, id)).status, "failed");
  });
  await check("the per-workspace limit is enforced", async () => {
    const have = Number((await db.query(`SELECT COUNT(*) AS n FROM sites WHERE workspace_id = $1`, [ws])).rows[0].n);
    await db.query(`INSERT INTO sites (workspace_id, name, slug, prompt, status) SELECT $1, 'f', 'fill-' || $3 || '-' || g, 'x', 'ready' FROM generate_series(1, $2::int) g`, [ws, 50 - have, stamp]);
    await assert.rejects(() => sites.create(ws, ann, { template: "landing" }), /up to 50/);
  });
  await check("delete removes the site and its versions", async () => {
    await sites.remove(ws, s1); await assert.rejects(() => sites.get(ws, s1), /not found/i);
    assert.equal(Number((await db.query(`SELECT COUNT(*) AS n FROM site_versions WHERE site_id = $1`, [s1])).rows[0].n), 0);
  });

  for (const w of [ws, other]) { await db.query(`DELETE FROM workspace_usage_events WHERE workspace_id = $1`, [w]); await db.query(`DELETE FROM workspaces WHERE id = $1`, [w]); }
  await db.query(`DELETE FROM users WHERE id = $1`, [ann]);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
