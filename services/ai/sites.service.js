const crypto = require("crypto");
const dns = require("dns");
const db = require("../../config/db.config");
const llm = require("./llm.service");
const { sanitize, SERVE_HEADERS } = require("./siteHtml");
const { bad, text, page } = require("./context");

const MAX_SITES = 50;
const MAX_VERSIONS = 15;
const MAX_PROMPT = 4000;
const STALE_MINUTES = 15;

const TEMPLATES = {
  landing: { label: "Landing Page", prompt: "A focused one-page landing site for a single offer: a strong headline, a short explanation, three benefits, how it works in three steps, a call to action, and a contact section." },
  business: { label: "Business Website", prompt: "A professional small-business website: hero, about, services, why choose us, process, and a contact section." },
  portfolio: { label: "Portfolio Site", prompt: "A clean portfolio for an individual professional: intro, selected work areas, skills, about, and contact." },
  agency: { label: "Agency Website", prompt: "A modern agency website: hero, services, approach, results area, who we work with, and a contact call to action." },
  local: { label: "Local Business", prompt: "A local service business site: hero with the main service and area served, services list, why local customers choose us, service area, and contact details." },
  personal: { label: "Personal Brand", prompt: "A personal brand site for a consultant or creator: bold intro, what I help with, my approach, ways to work with me, and contact." },
};

const SYSTEM = [
  "You are a senior web designer who writes complete, beautiful, accessible websites as ONE self-contained HTML document.",
  "Output ONLY the HTML document, starting with <!doctype html>. No markdown fences, no explanation.",
  "Rules:",
  "- All CSS goes in a single <style> block in the <head>. Modern, responsive CSS (flexbox/grid, clamp(), media queries), good spacing and type hierarchy, readable contrast. It must look good on a phone and on a desktop.",
  "- NO JavaScript of any kind, no forms, no iframes, no external scripts. Interactivity is limited to links and <details>/<summary>.",
  "- Images: do not link to image files. Use CSS gradients, shapes and small inline <svg> icons for visuals.",
  "- Fonts: system font stacks, or a Google Fonts <link> if you want one.",
  "- Use ONLY facts the user gave. Never invent testimonials, customer names, statistics, awards, prices, addresses, phone numbers or emails. If something isn't given, leave that element out. For contact, link to an email or phone only if provided; otherwise write a short 'Get in touch' section without made-up details.",
  "- Write specific, plain, human copy. No filler like 'cutting-edge' or 'world-class'.",
  "- Semantic structure (header, main, sections, footer), a descriptive <title> and meta description.",
].join("\n");

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
const PHONE_RE = /\+?\d[\d\s().-]{8,}\d/g;
const digits = (v) => String(v).replace(/\D/g, "");

/** Contact details in the page that nobody supplied (not in the description, the change request or the earlier page). */
function inventedContacts(html, allowedText) {
  const body = String(html).replace(/<style[\s\S]*?<\/style>/gi, " ");
  const allowed = String(allowedText).toLowerCase();
  const allowedDigits = digits(allowedText);
  const emails = [...new Set((body.match(EMAIL_RE) || []).map((e) => e.toLowerCase()))].filter((e) => !allowed.includes(e));
  const phones = [...new Set(body.match(PHONE_RE) || [])].filter((p) => digits(p).length >= 10 && !allowedDigits.includes(digits(p)));
  return { emails, phones, any: emails.length + phones.length > 0 };
}

/** Last resort when the model keeps inventing them: take them out rather than publish a made-up address or number. */
function scrubContacts(html, found) {
  let out = html;
  for (const e of found.emails) out = out.replace(new RegExp(`<a [^>]*href="mailto:${e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^"]*"[^>]*>[\\s\\S]*?</a>`, "gi"), "").replace(new RegExp(e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "");
  for (const p of found.phones) out = out.split(p).join("");
  return out;
}

const slugify = (s) => String(s || "site").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40).replace(/-+$/, "") || "site";
const stripFences = (t) => String(t || "").trim().replace(/^```(?:html)?\s*/i, "").replace(/\s*```$/, "");

const map = (r, { full = false } = {}) => ({
  id: Number(r.id), name: r.name, slug: r.slug, template: r.template, status: r.status, error: r.error, prompt: r.prompt,
  isPublished: r.is_published, publishedAt: r.published_at, hasUnpublishedChanges: Boolean(r.is_published && r.html && r.html !== r.published_html),
  customDomain: r.custom_domain, domainStatus: r.domain_status, createdAt: r.created_at, updatedAt: r.updated_at, hasHtml: Boolean(r.html), createdBy: r.created_by || null,
  ...(full ? { html: r.html } : {}),
});
const SELECT = `SELECT s.*, NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') AS created_by FROM sites s LEFT JOIN users u ON u.id = s.user_id`;

async function own(workspaceId, id) {
  if (!/^\d+$/.test(String(id))) throw bad("Site not found.", 404);
  const { rows } = await db.query(`${SELECT} WHERE s.id = $1 AND s.workspace_id = $2`, [id, workspaceId]);
  if (!rows[0]) throw bad("Site not found.", 404);
  return rows[0];
}

async function list(workspaceId) {
  await db.query(`UPDATE sites SET status = CASE WHEN html IS NULL THEN 'failed' ELSE 'ready' END, error = 'The last change was interrupted. Try again.' WHERE workspace_id = $1 AND status = 'processing' AND started_at < NOW() - ($2 || ' minutes')::interval`, [workspaceId, String(STALE_MINUTES)]);
  const { rows } = await db.query(`${SELECT} WHERE s.workspace_id = $1 ORDER BY s.updated_at DESC, s.id DESC LIMIT 200`, [workspaceId]);
  return { items: rows.map((r) => map(r)), templates: Object.entries(TEMPLATES).map(([id, t]) => ({ id, label: t.label })), limit: MAX_SITES };
}

async function get(workspaceId, id) {
  return map(await own(workspaceId, id), { full: true });
}

async function create(workspaceId, userId, body = {}) {
  const template = TEMPLATES[body.template] ? body.template : null;
  const prompt = text(body.prompt, MAX_PROMPT + 1);
  if (prompt.length > MAX_PROMPT) throw bad(`Keep the description under ${MAX_PROMPT.toLocaleString()} characters.`);
  if (prompt.length < 15 && !template) throw bad("Describe the website you want (what it's for and who it's for), or pick a template.");
  const count = Number((await db.query(`SELECT COUNT(*) AS n FROM sites WHERE workspace_id = $1`, [workspaceId])).rows[0].n);
  if (count >= MAX_SITES) throw bad(`You can have up to ${MAX_SITES} sites. Delete one to make room.`, 409);
  const full = [template ? TEMPLATES[template].prompt : "", prompt].filter(Boolean).join("\n\nDetails from the user:\n");
  const name = text(body.name, 120) || (prompt ? prompt.replace(/\s+/g, " ").slice(0, 48) : TEMPLATES[template].label);
  const slug = `${slugify(name)}-${crypto.randomBytes(3).toString("hex")}`;
  const { rows } = await db.query(`INSERT INTO sites (workspace_id, user_id, name, slug, prompt, template) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [workspaceId, userId, name, slug, full, template]);
  const id = Number(rows[0].id);
  setImmediate(() => build(id, { kind: "create" }).catch((e) => console.error("Site build crashed:", e)));
  return get(workspaceId, id);
}

async function revise(workspaceId, id, instruction) {
  const site = await own(workspaceId, id);
  if (!site.html) throw bad("This site has no page yet. Create it first.", 409);
  if (site.status === "processing") throw bad("This site is already being updated.", 409);
  const change = text(instruction, 2000);
  if (change.length < 3) throw bad("Tell us what to change.");
  await db.query(`UPDATE sites SET status = 'processing', error = NULL, started_at = NOW() WHERE id = $1`, [site.id]);
  setImmediate(() => build(Number(site.id), { kind: "revise", change }).catch((e) => console.error("Site revise crashed:", e)));
  return get(workspaceId, id);
}

const running = new Set();
/** Runs one generation or revision. A failed revision keeps the page as it was. Safe to call twice. */
async function build(id, { kind, change }) {
  if (running.has(id)) return;
  running.add(id);
  try {
    const { rows } = await db.query(`SELECT * FROM sites WHERE id = $1 AND status = 'processing'`, [id]);
    const site = rows[0];
    if (!site) return;
    try {
      const messages = kind === "revise"
        ? [{ role: "user", content: `Here is the current page:\n\n${site.html}\n\nMake this change and return the complete updated HTML document. Keep everything else as it is.\nChange: ${change}` }]
        : [{ role: "user", content: `Build this website:\n\n${site.prompt}` }];
      const ask = (msgs) => llm.complete({ workspaceId: site.workspace_id, system: SYSTEM, messages: msgs, action: "site", maxTokens: 12000, temperature: 0.6 });
      let { text: out, model } = await ask(messages);
      let html = sanitize(stripFences(out));
      // Only contact details the user gave may appear. One corrective retry, then they are removed.
      const allowedText = `${site.prompt}\n${change || ""}\n${site.html || ""}`;
      let invented = inventedContacts(html, allowedText);
      if (invented.any) {
        const list = [...invented.emails, ...invented.phones].join(", ");
        try {
          const again = await ask([...messages, { role: "assistant", content: out }, { role: "user", content: `The page contains contact details that were not provided: ${list}. Remove them (and any link to them) and return the complete HTML document again. Do not add any other contact details.` }]);
          html = sanitize(stripFences(again.text)); model = again.model;
        } catch { /* fall through to scrubbing the first attempt */ }
        invented = inventedContacts(html, allowedText);
        if (invented.any) html = scrubContacts(html, invented);
      }
      if (!/<body[\s>][\s\S]*\S[\s\S]*<\/body>/i.test(html) || html.length < 400) throw Object.assign(new Error("The page came back empty. Try again."), { code: "AI_BAD_OUTPUT" });
      const client = await db.getClient();
      try {
        await client.query("BEGIN");
        if (site.html) await client.query(`INSERT INTO site_versions (site_id, html, note) VALUES ($1,$2,$3)`, [id, site.html, kind === "revise" ? `Before: ${change}`.slice(0, 300) : "Before regeneration"]);
        await client.query(`UPDATE sites SET html = $2, status = 'ready', error = NULL, model = $3, updated_at = NOW() WHERE id = $1`, [id, html, model]);
        await client.query(`DELETE FROM site_versions WHERE site_id = $1 AND id NOT IN (SELECT id FROM site_versions WHERE site_id = $1 ORDER BY id DESC LIMIT ${MAX_VERSIONS})`, [id]);
        await client.query("COMMIT");
      } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); }
    } catch (error) {
      // A page that already exists stays usable; only the failed change is reported.
      await db.query(`UPDATE sites SET status = CASE WHEN html IS NULL THEN 'failed' ELSE 'ready' END, error = $2, updated_at = NOW() WHERE id = $1`, [id, text(error.message, 400)]);
    }
  } finally {
    running.delete(id);
  }
}

async function regenerate(workspaceId, id) {
  const site = await own(workspaceId, id);
  if (site.status === "processing") throw bad("This site is already being updated.", 409);
  await db.query(`UPDATE sites SET status = 'processing', error = NULL, started_at = NOW() WHERE id = $1`, [site.id]);
  setImmediate(() => build(Number(site.id), { kind: "create" }).catch((e) => console.error("Site build crashed:", e)));
  return get(workspaceId, id);
}

async function rename(workspaceId, id, name) {
  const site = await own(workspaceId, id);
  const value = text(name, 120);
  if (!value) throw bad("Give the site a name.");
  await db.query(`UPDATE sites SET name = $2, updated_at = NOW() WHERE id = $1`, [site.id, value]);
  return get(workspaceId, id);
}

async function versions(workspaceId, id) {
  const site = await own(workspaceId, id);
  const { rows } = await db.query(`SELECT id, note, created_at FROM site_versions WHERE site_id = $1 ORDER BY id DESC`, [site.id]);
  return rows.map((r) => ({ id: Number(r.id), note: r.note, createdAt: r.created_at }));
}

async function restore(workspaceId, id, versionId) {
  const site = await own(workspaceId, id);
  const { rows } = await db.query(`SELECT html FROM site_versions WHERE id = $1 AND site_id = $2`, [/^\d+$/.test(String(versionId)) ? versionId : 0, site.id]);
  if (!rows[0]) throw bad("That version no longer exists.", 404);
  if (site.status === "processing") throw bad("This site is being updated. Try again in a moment.", 409);
  if (site.html) await db.query(`INSERT INTO site_versions (site_id, html, note) VALUES ($1,$2,'Before restoring an older version')`, [site.id, site.html]);
  await db.query(`UPDATE sites SET html = $2, error = NULL, updated_at = NOW() WHERE id = $1`, [site.id, rows[0].html]);
  return get(workspaceId, id);
}

async function publish(workspaceId, id) {
  const site = await own(workspaceId, id);
  if (!site.html) throw bad("There's nothing to publish yet.", 409);
  await db.query(`UPDATE sites SET is_published = TRUE, published_html = html, published_at = NOW(), updated_at = NOW() WHERE id = $1`, [site.id]);
  return get(workspaceId, id);
}

async function unpublish(workspaceId, id) {
  const site = await own(workspaceId, id);
  await db.query(`UPDATE sites SET is_published = FALSE, updated_at = NOW() WHERE id = $1`, [site.id]);
  return get(workspaceId, id);
}

async function remove(workspaceId, id) {
  const site = await own(workspaceId, id);
  await db.query(`DELETE FROM sites WHERE id = $1`, [site.id]);
  return { deleted: true };
}

// ---- custom domains ----
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const target = () => String(process.env.SITES_CNAME_TARGET || "sites.sendvybe.com").toLowerCase();
const resolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
let dnsTransport = resolver;
const setResolver = (r) => { dnsTransport = r || resolver; };

const instructions = (domain) => ({ type: "CNAME", name: domain, value: target(), note: domain.split(".").length === 2 ? "For a bare domain (no www), use an ALIAS/ANAME record if your DNS host offers one, or connect www." : null });

async function setDomain(workspaceId, id, domainRaw) {
  const site = await own(workspaceId, id);
  const domain = String(domainRaw || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!domain) {
    await db.query(`UPDATE sites SET custom_domain = NULL, domain_status = 'none', updated_at = NOW() WHERE id = $1`, [site.id]);
    return get(workspaceId, id);
  }
  if (!DOMAIN_RE.test(domain)) throw bad("Enter a domain like www.yourbrand.com.");
  const appHost = (() => { try { return new URL(process.env.APP_FRONTEND_URL || "").hostname; } catch { return ""; } })();
  if (domain === target() || (appHost && domain === appHost)) throw bad("That domain can't be used for a site.");
  const { rows: taken } = await db.query(`SELECT id FROM sites WHERE custom_domain = $1 AND id <> $2`, [domain, site.id]);
  if (taken[0]) throw bad("That domain is already connected to another site.", 409);
  await db.query(`UPDATE sites SET custom_domain = $2, domain_status = 'pending', updated_at = NOW() WHERE id = $1`, [site.id, domain]);
  return { ...(await get(workspaceId, id)), dns: instructions(domain) };
}

async function checkDomain(workspaceId, id) {
  const site = await own(workspaceId, id);
  if (!site.custom_domain) throw bad("Connect a domain first.");
  let status = "pending";
  let detail = null;
  try {
    const cnames = (await dnsTransport.resolveCname(site.custom_domain)).map((h) => h.toLowerCase().replace(/\.$/, ""));
    if (cnames.includes(target())) status = "verified"; else detail = `The domain points at ${cnames.join(", ")} instead of ${target()}.`;
  } catch (error) {
    detail = ["ENODATA", "ENOTFOUND", "NXDOMAIN"].includes(error.code) ? `No CNAME record found yet for ${site.custom_domain}. DNS changes can take a while.` : "We couldn't read the DNS right now. Try again in a minute.";
    if (!["ENODATA", "ENOTFOUND", "NXDOMAIN"].includes(error.code)) status = site.domain_status; // a lookup problem proves nothing
  }
  await db.query(`UPDATE sites SET domain_status = $2, updated_at = NOW() WHERE id = $1`, [site.id, status]);
  return { ...(await get(workspaceId, id)), dns: instructions(site.custom_domain), detail };
}

// ---- public serving ----
async function servePublic({ slug, host }) {
  const { rows } = host
    ? await db.query(`SELECT published_html FROM sites WHERE custom_domain = $1 AND domain_status = 'verified' AND is_published = TRUE`, [String(host).toLowerCase()])
    : await db.query(`SELECT published_html FROM sites WHERE slug = $1 AND is_published = TRUE`, [String(slug || "").toLowerCase()]);
  if (!rows[0]?.published_html) return { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }, body: "This site isn't published." };
  return { status: 200, headers: SERVE_HEADERS, body: rows[0].published_html };
}

module.exports = { TEMPLATES, list, get, create, revise, regenerate, rename, versions, restore, publish, unpublish, remove, setDomain, checkDomain, servePublic, build, setResolver, SYSTEM };
