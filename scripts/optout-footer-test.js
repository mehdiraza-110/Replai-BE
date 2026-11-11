// Verifies the opt-out line setting and its automatic switch-back in the LOCAL sandbox (database only, nothing is sent).
// Run from the workspace root:  ./dev-local.sh node scripts/optout-footer-test.js
const BE = require("path").resolve(__dirname, "..");
const assert = require("assert");
const db = require(`${BE}/config/db.config`);
const prefs = require(`${BE}/services/settings/preferences.service`);
const guard = require(`${BE}/services/optOutGuard.service`);
const { applyOptOutSetting, OPT_OUT_FOOTER } = require(`${BE}/utils/optOutFooter.util`);

let pass = 0, fail = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log("  PASS", name); }, (e) => { fail++; console.log("  FAIL", name, "->", e.message); });
const stamp = Date.now();

(async () => {
  const ws = (await db.query(`INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id`, [`OptOut ${stamp}`, `optout-${stamp}`])).rows[0].id;
  const user = (await db.query(`INSERT INTO users (first_name, last_name, email, password_hash) VALUES ('Opt', 'Tester', $1, 'x') RETURNING id`, [`optout-${stamp}@settings.invalid`])).rows[0].id;
  const camp = (await db.query(`INSERT INTO campaigns (name, subject, body, workspace_id, is_warmup) VALUES ('t', 's', 'b', $1, FALSE) RETURNING id`, [ws])).rows[0].id;
  const seed = async (sent, bounced, complained) => {
    await db.query(`DELETE FROM campaign_leads WHERE campaign_id = $1`, [camp]);
    await db.query(`DELETE FROM suppressions WHERE workspace_id = $1`, [ws]);
    for (let i = 0; i < sent; i++) await db.query(`INSERT INTO campaign_leads (campaign_id, workspace_id, email, status, sent_at) VALUES ($1,$2,$3,'Sent',NOW())`, [camp, ws, `l${i}-${stamp}@x.invalid`]);
    for (let i = 0; i < bounced; i++) await db.query(`INSERT INTO suppressions (email, reason, source, campaign_id, workspace_id) VALUES ($1,'hard_bounce','postal_bounce',$2,$3)`, [`b${i}-${stamp}@x.invalid`, camp, ws]);
    for (let i = 0; i < complained; i++) await db.query(`INSERT INTO suppressions (email, reason, source, campaign_id, workspace_id) VALUES ($1,'complained','ses_complaint',$2,$3)`, [`c${i}-${stamp}@x.invalid`, camp, ws]);
  };
  try {
    console.log("body handling");
    await check("enabled appends the line once", () => { const out = applyOptOutSetting("Hi", true); assert.equal(out, `Hi${OPT_OUT_FOOTER}`); assert.equal(applyOptOutSetting(out, true), out); });
    await check("disabled strips a stored legacy line", () => assert.equal(applyOptOutSetting(`Hi${OPT_OUT_FOOTER}`, false), "Hi"));
    await check("disabled leaves the author's own opt-out wording alone", () => assert.equal(applyOptOutSetting("Hi. Reply STOP to unsubscribe.", false), "Hi. Reply STOP to unsubscribe."));
    await check("enabled skips a body with its own opt-out wording", () => assert.equal(applyOptOutSetting("Hi. Reply STOP to unsubscribe.", true), "Hi. Reply STOP to unsubscribe."));

    console.log("setting");
    await check("defaults to on and does not mark the schedule as configured", async () => { const s = await prefs.getWorkspaceSettings(ws); assert.equal(s.coldEmail.optOutFooter.enabled, true); assert.equal(s.coldEmailConfigured, false); assert.equal(await guard.isFooterEnabled(ws), true); });
    await check("can be switched off without sending a schedule", async () => { const s = await prefs.updateWorkspaceSettings(ws, user, { coldEmail: { optOutFooter: { enabled: false } } }); assert.equal(s.coldEmail.optOutFooter.enabled, false); assert.ok(s.coldEmail.optOutFooter.disabledAt); assert.equal(s.coldEmailConfigured, false); assert.equal(await guard.isFooterEnabled(ws), false); });
    await check("saving the schedule keeps the footer choice", async () => { const s = await prefs.updateWorkspaceSettings(ws, user, { coldEmail: { schedule: { from: "08:00" } } }); assert.equal(s.coldEmail.optOutFooter.enabled, false); assert.equal(s.coldEmailConfigured, true); });
    await check("rejects a non-boolean value", () => assert.rejects(() => prefs.updateWorkspaceSettings(ws, user, { coldEmail: { optOutFooter: { enabled: "no" } } }), /on or off/));

    console.log("automatic switch-back");
    await check("healthy sending leaves it off", async () => { await seed(200, 2, 0); assert.equal(await guard.evaluateWorkspace(ws), null); assert.equal(await guard.isFooterEnabled(ws), false); });
    await check("too few sends never trigger it", async () => { await seed(40, 10, 1); assert.equal(await guard.evaluateWorkspace(ws), null); });
    await check("a high bounce rate turns it on", async () => { await seed(200, 14, 0); const why = await guard.evaluateWorkspace(ws); assert.match(why, /hard bounces/); assert.equal(await guard.isFooterEnabled(ws), true); const s = await prefs.getWorkspaceSettings(ws); assert.ok(s.coldEmail.optOutFooter.autoEnabledAt); assert.match(s.coldEmail.optOutFooter.autoReason, /hard bounces/); const a = await prefs.listAudit(ws, "cold_email"); assert.ok(a.some((x) => /automatically/.test(x.summary))); });
    await check("a complaint turns it on", async () => { await prefs.updateWorkspaceSettings(ws, user, { coldEmail: { optOutFooter: { enabled: false } } }); await seed(300, 0, 1); await new Promise((r) => setTimeout(r, 20)); await db.query(`UPDATE workspace_settings SET cold_email = jsonb_set(cold_email, '{optOutFooter,disabledAt}', to_jsonb((NOW() - INTERVAL '1 hour')::text)) WHERE workspace_id = $1`, [ws]); assert.match(await guard.evaluateWorkspace(ws), /complaint/); });
    await check("old problems do not undo a fresh manual switch-off", async () => { await seed(200, 14, 0); await prefs.updateWorkspaceSettings(ws, user, { coldEmail: { optOutFooter: { enabled: false } } }); assert.equal(await guard.evaluateWorkspace(ws), null); assert.equal(await guard.isFooterEnabled(ws), false); });
    await check("warm-up campaign traffic is ignored", async () => { await db.query(`UPDATE campaigns SET is_warmup = TRUE WHERE id = $1`, [camp]); await seed(200, 30, 3); await db.query(`UPDATE workspace_settings SET cold_email = jsonb_set(cold_email, '{optOutFooter,disabledAt}', to_jsonb((NOW() - INTERVAL '1 hour')::text)) WHERE workspace_id = $1`, [ws]); assert.equal(await guard.evaluateWorkspace(ws), null); });
  } finally {
    await db.query(`DELETE FROM suppressions WHERE workspace_id = $1`, [ws]);
    await db.query(`DELETE FROM campaign_leads WHERE campaign_id = $1`, [camp]);
    await db.query(`DELETE FROM campaigns WHERE id = $1`, [camp]);
    await db.query(`DELETE FROM workspaces WHERE id = $1`, [ws]);
    await db.query(`DELETE FROM users WHERE id = $1`, [user]);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
