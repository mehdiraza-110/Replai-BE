// Sets who is alerted about positive leads, per brand (= campaign name). Edit ROUTES, then run:
//   node scripts/lead-alert-routes.js          (dry run: shows what would change and which campaigns match)
//   node scripts/lead-alert-routes.js --apply  (replaces all routes)
// Pattern is a SQL ILIKE pattern on the campaign name. COPY_ALL get every brand. Brands that do not exist in
// SendVybe (Si Staffing, Veteran Business) are left out on purpose.
const db = require("../config/db.config");

const EMAILS = {
  Felipe: "felipe.v@kovalai.ai", Chantal: "Chantal.C@sistaffing.com", Joe: "joesph.h@kovalinvest.com",
  Artem: "artem.p@kovalinvest.com", Yuri: "yuri@sistaffing.com", Chris: "chris.b@kovalcorp.com",
  Mardi: "", // email still needed
};
const ROUTES = {
  "Koval AI%": ["Felipe"],
  "Staffing Brokerage%": ["Chantal", "Mardi", "Yuri"],
  "Koval Invest%": ["Joe", "Chantal", "Artem"],
};
const COPY_ALL = ["Chris"];

(async () => {
  const apply = process.argv.includes("--apply");
  const rows = [];
  const missing = new Set();
  const email = (n) => { const e = EMAILS[n]; if (!e) missing.add(n); return e; };
  for (const e of COPY_ALL.map(email).filter(Boolean)) rows.push({ pattern: null, email: e });
  for (const [pattern, people] of Object.entries(ROUTES)) {
    const { rows: c } = await db.query(`SELECT name FROM plusvibe_campaigns WHERE name ILIKE $1`, [pattern]);
    console.log(`${pattern} -> campaigns: ${c.map((x) => x.name).join(", ") || "NONE"}`);
    for (const e of people.map(email).filter(Boolean)) rows.push({ pattern, email: e });
  }
  console.table(rows.map((r) => ({ brand: r.pattern || "ALL BRANDS", email: r.email })));
  if (missing.size) console.log("No email yet for:", [...missing].join(", "));
  if (apply) {
    await db.query(`DELETE FROM lead_alert_routes`);
    for (const r of rows) await db.query(`INSERT INTO lead_alert_routes (campaign_pattern, email) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [r.pattern, r.email]);
    console.log(`Applied ${rows.length} routes.`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
