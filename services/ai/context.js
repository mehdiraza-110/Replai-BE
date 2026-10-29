const db = require("../../config/db.config");

/** What the workspace has told us about itself (Acquisity Brain), as prompt text. Empty string when nothing is set. */
async function brainContext(workspaceId) {
  const { rows } = await db.query(`SELECT company_name, website, who_you_sell_to, what_you_sell FROM workspace_brain WHERE workspace_id = $1`, [workspaceId]);
  const b = rows[0] || {};
  const lines = [
    b.company_name && `Company: ${b.company_name}`,
    b.website && `Website: ${b.website}`,
    b.who_you_sell_to && `Who they sell to: ${b.who_you_sell_to}`,
    b.what_you_sell && `What they sell: ${b.what_you_sell}`,
  ].filter(Boolean);
  return lines.length ? `=== ABOUT THE USER'S BUSINESS ===\n${lines.join("\n")}` : "";
}

const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const text = (value, max) => String(value ?? "").replace(/\u0000/g, "").trim().slice(0, max);

const page = (query, def = 25) => {
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || def));
  return { page: Math.max(1, parseInt(query.page, 10) || 1), limit };
};

module.exports = { brainContext, bad, text, page };
