const { Parser } = require("htmlparser2");

// Generated sites are hosted on our own origin, so nothing a model writes is trusted. This rebuilds the page from an allowlist of
// tags and attributes (no scripts, frames, forms, event handlers or odd URLs). Serving adds a strict CSP on top as a second layer.

const MAX_BYTES = 400000;
const VOID = new Set(["br", "hr", "img", "meta", "link", "source", "path", "circle", "rect", "line", "ellipse", "polyline", "polygon", "stop"]);
const SVG_SHAPES = new Set(["path", "circle", "rect", "line", "ellipse", "polyline", "polygon", "stop"]);
// Void in HTML: they never get a closing tag, whether or not we keep them.
const HTML_VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const TAGS = new Set(["html", "head", "meta", "title", "style", "link", "body", "section", "header", "footer", "nav", "main", "article", "aside", "div", "span", "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "a", "img", "button", "strong", "em", "b", "i", "u", "small", "br", "hr", "blockquote", "figure", "figcaption", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "details", "summary", "dl", "dt", "dd", "address", "time", "mark", "code", "pre", "sup", "sub",
  "svg", "g", "defs", "path", "circle", "rect", "line", "ellipse", "polyline", "polygon", "lineargradient", "radialgradient", "stop", "text", "tspan", "title"]);
// Contents of these are dropped with the tag.
const DROP_WITH_CONTENT = new Set(["script", "iframe", "object", "embed", "noscript", "template", "frame", "frameset", "applet", "audio", "video", "canvas", "textarea", "select", "option"]);
// Layout wrappers: the tag goes, the text stays.
const UNWRAP = new Set(["form", "label", "fieldset", "legend", "input", "picture", "center", "font"]);
const GLOBAL_ATTRS = new Set(["class", "id", "style", "title", "lang", "role", "dir", "tabindex"]);
const SVG_ATTRS = new Set(["viewbox", "xmlns", "d", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "fill-rule", "clip-rule", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2", "points", "transform", "opacity", "offset", "stop-color", "stop-opacity", "gradientunits", "gradienttransform", "font-size", "font-weight", "text-anchor", "width", "height", "preserveaspectratio", "fill-opacity", "stroke-opacity"]);
const PER_TAG = { a: ["href", "target", "rel"], img: ["src", "alt", "width", "height", "loading"], meta: ["charset", "name", "content"], link: ["rel", "href", "crossorigin"], th: ["colspan", "rowspan", "scope"], td: ["colspan", "rowspan"], time: ["datetime"], html: ["lang"], button: [] };
const FONT_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s) => esc(s).replace(/"/g, "&quot;");

function safeUrl(value, { allowData = false, allowRelative = true } = {}) {
  const v = String(value || "").trim().replace(/[\u0000-\u001f\u007f\s]+/g, "");
  if (!v) return null;
  if (v.startsWith("#")) return allowRelative ? v : null;
  if (/^https?:\/\//i.test(v)) return v;
  if (!allowData && /^(mailto|tel):/i.test(v)) return v;
  if (allowData && /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);/i.test(v)) return v;
  return null;
}

/** CSS can load things too: drop @import, expressions, and url() that isn't https or an image data URI. */
function safeCss(css) {
  return String(css)
    .replace(/@import[^;]*;?/gi, "")
    .replace(/expression\s*\(/gi, "(")
    .replace(/behavior\s*:[^;}]*/gi, "")
    .replace(/-moz-binding\s*:[^;}]*/gi, "")
    .replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (m, _q, u) => (/^https:\/\//i.test(u.trim()) || /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml)[;,]/i.test(u.trim()) ? m : "none"))
    .replace(/<\/?style/gi, "");
}

function sanitize(input) {
  const raw = String(input || "").slice(0, MAX_BYTES * 2);
  const out = [];
  const stack = [];
  let skip = 0;          // depth inside a dropped element
  let inStyle = false;
  let seenBody = false;

  const parser = new Parser({
    onopentag(name, attribs) {
      const tag = name.toLowerCase();
      if (skip > 0) { if (!HTML_VOID.has(tag)) skip += 1; return; }
      if (DROP_WITH_CONTENT.has(tag)) { skip = 1; return; }
      const unwrap = () => { if (!HTML_VOID.has(tag)) stack.push(null); };
      if (UNWRAP.has(tag) || !TAGS.has(tag)) { unwrap(); return; }
      if (tag === "body") seenBody = true;
      if (tag === "meta") {
        const n = String(attribs.name || "").toLowerCase();
        if (!("charset" in attribs) && !["viewport", "description", "theme-color"].includes(n)) { unwrap(); return; }
      }
      if (tag === "link") {
        let host = "";
        try { host = new URL(attribs.href || "").hostname; } catch { /* not a URL */ }
        const rel = String(attribs.rel || "").toLowerCase();
        if (!FONT_HOSTS.has(host) || !/^(stylesheet|preconnect)$/.test(rel) || !/^https:/i.test(attribs.href || "")) { unwrap(); return; }
      }
      const allowed = PER_TAG[tag] || [];
      const parts = [];
      for (const [rawKey, value] of Object.entries(attribs)) {
        const key = rawKey.toLowerCase();
        if (key.startsWith("on")) continue;
        const isSvgPart = tag === "svg" || ["g", "path", "circle", "rect", "line", "ellipse", "polyline", "polygon", "lineargradient", "radialgradient", "stop", "text", "tspan", "defs"].includes(tag);
        if (key === "style") { const css = safeCss(value); if (css.trim()) parts.push(`style="${escAttr(css)}"`); continue; }
        if (key === "href" && tag === "a") { const u = safeUrl(value); if (u) parts.push(`href="${escAttr(u)}"`); continue; }
        if (key === "href" && tag === "link") { parts.push(`href="${escAttr(value)}"`); continue; }
        if (key === "src" && tag === "img") { const u = safeUrl(value, { allowData: true, allowRelative: false }); if (u) parts.push(`src="${escAttr(u)}"`); continue; }
        if (key === "target" && tag === "a") continue; // set below
        if (key === "rel" && tag === "a") continue;
        if (GLOBAL_ATTRS.has(key) || allowed.includes(key) || (isSvgPart && SVG_ATTRS.has(key)) || key.startsWith("aria-")) {
          if (key === "id" || key === "class") parts.push(`${key}="${escAttr(String(value).replace(/[^\w\s-]/g, ""))}"`);
          else parts.push(`${rawKey}="${escAttr(value)}"`);
        }
      }
      if (tag === "img" && !parts.some((p) => p.startsWith("src="))) { return; }
      if (tag === "a") parts.push('target="_blank"', 'rel="noopener noreferrer nofollow"');
      if (tag === "style") inStyle = true;
      out.push(`<${tag}${parts.length ? ` ${parts.join(" ")}` : ""}${SVG_SHAPES.has(tag) ? " /" : ""}>`);
      if (!VOID.has(tag)) stack.push(tag);
    },
    ontext(text) {
      if (skip > 0) return;
      out.push(inStyle ? safeCss(text) : esc(text));
    },
    onclosetag(name) {
      const tag = name.toLowerCase();
      if (skip > 0) { if (!HTML_VOID.has(tag)) skip -= 1; return; }
      if (VOID.has(tag) || HTML_VOID.has(tag)) return;
      if (!stack.length) return;
      const top = stack.pop();
      if (top === null) return;
      if (top === "style") inStyle = false;
      out.push(`</${top}>`);
    },
  }, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: false, recognizeSelfClosing: true });
  parser.write(raw);
  parser.end();
  while (stack.length) { const t = stack.pop(); if (t) out.push(`</${t}>`); }

  let html = out.join("");
  if (!seenBody && !/<body/i.test(html)) html = `<body>${html}</body>`;
  if (!/<html/i.test(html)) html = `<html lang="en">${html}</html>`;
  if (!/<meta[^>]+charset/i.test(html)) html = html.replace(/<head>/i, '<head><meta charset="utf-8">');
  html = `<!doctype html>${html.replace(/^<!doctype html>/i, "")}`;
  if (Buffer.byteLength(html) > MAX_BYTES) throw Object.assign(new Error("The generated page is too large."), { statusCode: 422 });
  return html;
}

/** Headers for serving a site. The page can't run script, load frames or post anywhere even if something slipped through. */
const SERVE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; img-src https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox allow-popups allow-popups-to-escape-sandbox",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "public, max-age=0, must-revalidate",
};

module.exports = { sanitize, safeCss, SERVE_HEADERS, MAX_BYTES };
