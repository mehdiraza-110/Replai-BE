// Verifies the Settings services in the LOCAL sandbox (database only, nothing is sent anywhere).
// Run from the workspace root:  ./dev-local.sh node scripts/settings-test.js
const BE = require("path").resolve(__dirname, "..");
const assert = require("assert");
const db = require(`${BE}/config/db.config`);
const prefs = require(`${BE}/services/settings/preferences.service`);
const tokens = require(`${BE}/services/settings/apiTokens.service`);
const lib = require(`${BE}/services/settings/library.service`);
const block = require(`${BE}/services/settings/blocklist.service`);
const billing = require(`${BE}/services/settings/billing.service`);
const crm = require(`${BE}/services/crm.service`);
const { TenantGuard } = require(`${BE}/middlewares/tenant.middleware`);

let pass = 0, fail = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log("  PASS", name); }, (e) => { fail++; console.log("  FAIL", name, "->", e.message); });
const stamp = Date.now();
const mkWs = async (tag) => (await db.query(`INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id`, [`Settings ${tag} ${stamp}`, `settings-${tag}-${stamp}`])).rows[0].id;
const mkUser = async (tag, ws, role = "member") => {
  const id = (await db.query(`INSERT INTO users (first_name, last_name, email, password_hash) VALUES ($1, 'Tester', $2, 'x') RETURNING id`, [tag, `${tag}-${stamp}@settings.invalid`])).rows[0].id;
  if (ws) await db.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,$3)`, [ws, id, role]);
  return id;
};

(async () => {
  const ws = await mkWs("a"), other = await mkWs("b");
  const ann = await mkUser("Ann", ws, "owner"), bob = await mkUser("Bob", ws);
  const zed = await mkUser("Zed", other, "owner");

  console.log("\n[1] personal preferences");
  await check("defaults for a new user", async () => { const p = await prefs.getPreferences(ann); assert.equal(p.appearance.theme, "system"); assert.equal(p.notifications.desktop, false); assert.equal(p.notifications.sounds.escalation, "alert"); assert.equal(p.notifications.quiet.enabled, false); });
  await check("partial updates merge and persist", async () => {
    await prefs.updatePreferences(ann, { notifications: { desktop: true, sounds: { message: "pop" }, quiet: { enabled: true, from: "21:00", to: "07:30", timezone: "Europe/London" } } });
    const p = await prefs.getPreferences(ann); assert.equal(p.notifications.desktop, true); assert.equal(p.notifications.sounds.message, "pop"); assert.equal(p.notifications.sounds.ringtone, "classic"); assert.equal(p.notifications.quiet.to, "07:30");
    await prefs.updatePreferences(ann, { appearance: { theme: "dark" } }); assert.equal((await prefs.getPreferences(ann)).notifications.desktop, true);
  });
  await check("bad values are refused", async () => {
    await assert.rejects(() => prefs.updatePreferences(ann, { notifications: { sounds: { message: "airhorn" } } }), /Pick one of/);
    await assert.rejects(() => prefs.updatePreferences(ann, { notifications: { quiet: { from: "25:00" } } }), /time like/);
    await assert.rejects(() => prefs.updatePreferences(ann, { notifications: { quiet: { timezone: "Mars/Base" } } }), /time zone/);
    await assert.rejects(() => prefs.updatePreferences(ann, { notifications: { quiet: { enabled: true, from: "08:00", to: "08:00" } } }), /same time/);
    await assert.rejects(() => prefs.updatePreferences(ann, { appearance: { theme: "neon" } }), /light, dark or system/);
    await assert.rejects(() => prefs.updatePreferences(ann, {}), /Nothing to update/);
    await assert.rejects(() => prefs.updatePreferences(ann, { notifications: { desktop: "yes" } }), /on or off/);
  });
  await check("sidebar: hide, rename and reorder; Dashboard and Settings can never be hidden", async () => {
    const r = await prefs.updatePreferences(ann, { appearance: { sidebar: { hidden: ["sites/websites", "sites/websites"], groupNames: { Outreach: "Selling", Build: "" }, order: { Outreach: ["ai-sdr", "cold-email-campaign-agent"] } } } });
    assert.deepEqual(r.appearance.sidebar.hidden, ["sites/websites"]); assert.deepEqual(r.appearance.sidebar.groupNames, { Outreach: "Selling" }); assert.deepEqual(r.appearance.sidebar.order.Outreach, ["ai-sdr", "cold-email-campaign-agent"]);
    const again = (await prefs.getPreferences(ann)).appearance.sidebar; // what a later page load sees, not just the save response
    assert.deepEqual(again.groupNames, { Outreach: "Selling" }); assert.deepEqual(again.order, { Outreach: ["ai-sdr", "cold-email-campaign-agent"] }); assert.deepEqual(again.hidden, ["sites/websites"]);
    await assert.rejects(() => prefs.updatePreferences(ann, { appearance: { sidebar: { hidden: ["dashboard"] } } }), /can't be hidden/);
    await assert.rejects(() => prefs.updatePreferences(ann, { appearance: { sidebar: { hidden: ["settings/profile"] } } }), /can't be hidden/);
  });
  await check("preferences belong to one person", async () => { assert.equal((await prefs.getPreferences(bob)).appearance.theme, "system"); });

  console.log("\n[2] workspace settings and history");
  await check("defaults, then colour, conferencing and cold email schedule save", async () => {
    const d = await prefs.getWorkspaceSettings(ws); assert.equal(d.conferencing.type, "google_meet"); assert.equal(d.sharing.communication, false);
    const r = await prefs.updateWorkspaceSettings(ws, ann, { color: "#AA33CC", conferencing: { type: "static", staticUrl: "https://meet.example.com/room" }, coldEmail: { schedule: { from: "08:00", to: "18:00", timezone: "Asia/Karachi", days: ["Tue", "Mon"] } } });
    assert.equal(r.color, "#aa33cc"); assert.equal(r.conferencing.type, "static"); assert.deepEqual(r.coldEmail.schedule.days, ["Mon", "Tue"]);
  });
  await check("validation: colour, https link, static needs a link, window, days", async () => {
    await assert.rejects(() => prefs.updateWorkspaceSettings(ws, ann, { color: "blue" }), /colour/);
    await assert.rejects(() => prefs.updateWorkspaceSettings(ws, ann, { conferencing: { staticUrl: "http://meet.example.com/x" } }), /https/);
    await assert.rejects(() => prefs.updateWorkspaceSettings(ws, ann, { conferencing: { staticUrl: "not a url" } }), /https/);
    await assert.rejects(() => prefs.updateWorkspaceSettings(other, zed, { conferencing: { type: "static" } }), /Add the link/);
    await assert.rejects(() => prefs.updateWorkspaceSettings(ws, ann, { conferencing: { type: "zoom" } }), /Google Meet links|one fixed link/);
    await assert.rejects(() => prefs.updateWorkspaceSettings(ws, ann, { coldEmail: { schedule: { from: "18:00", to: "09:00" } } }), /end after/);
    await assert.rejects(() => prefs.updateWorkspaceSettings(ws, ann, { coldEmail: { schedule: { days: [] } } }), /at least one/);
    await assert.rejects(() => prefs.updateWorkspaceSettings(ws, ann, { coldEmail: { schedule: { days: ["Funday"] } } }), /Mon to Sun/);
  });
  await check("sharing switch is logged with who and what, newest first, per workspace", async () => {
    await prefs.updateWorkspaceSettings(ws, ann, { sharing: { communication: true } }); await prefs.updateWorkspaceSettings(ws, bob, { sharing: { communication: false } }); await prefs.updateWorkspaceSettings(ws, bob, { sharing: { communication: false } });
    const log = await prefs.listAudit(ws, "sharing"); assert.equal(log.length, 2); assert.match(log[0].summary, /off/); assert.equal(log[0].who, "Bob Tester"); assert.equal((await prefs.listAudit(other, "sharing")).length, 0);
  });
  await check("call analyzer language and frameworks", async () => {
    const r = await prefs.updateWorkspaceSettings(ws, ann, { callAnalyzer: { language: "en-GB", frameworks: { discovery: "Score on pain, budget, timeline." } } }); assert.equal(r.callAnalyzer.language, "en-GB"); assert.equal(r.callAnalyzer.frameworks.discovery, "Score on pain, budget, timeline."); assert.equal(r.callAnalyzer.frameworks.sales, "");
    await assert.rejects(() => prefs.updateWorkspaceSettings(ws, ann, { callAnalyzer: { frameworks: { karaoke: "x" } } }), /Unknown call type/); await assert.rejects(() => prefs.updateWorkspaceSettings(ws, ann, { callAnalyzer: { language: "fr-FR" } }), /English/);
  });
  await check("workspaces don't share settings", async () => { assert.equal((await prefs.getWorkspaceSettings(other)).conferencing.type, "google_meet"); });

  console.log("\n[3] API tokens");
  let t1, t2;
  await check("create returns the plain token once; only a hash is stored", async () => {
    t1 = await tokens.create(ws, ann, "personal", "Zapier"); assert.match(t1.token, /^sv_pt_[0-9a-f]{48}$/); assert.equal(t1.item.prefix, t1.token.slice(0, 12));
    const { rows } = await db.query(`SELECT token_hash FROM api_tokens WHERE id = $1`, [t1.item.id]); assert.equal(rows[0].token_hash.length, 64); assert.ok(!JSON.stringify(rows).includes(t1.token));
    assert.ok(!JSON.stringify(await tokens.list(ws, ann, "personal")).includes(t1.token));
  });
  await check("personal tokens are private; workspace keys are shared", async () => {
    t2 = await tokens.create(ws, ann, "workspace", "CI"); assert.match(t2.token, /^sv_ws_/);
    assert.equal((await tokens.list(ws, bob, "personal")).length, 0); assert.equal((await tokens.list(ws, ann, "personal")).length, 1); assert.equal((await tokens.list(ws, bob, "workspace")).length, 1);
    assert.equal((await tokens.list(other, zed, "workspace")).length, 0);
    await assert.rejects(() => tokens.create(ws, ann, "personal", " "), /name/); await assert.rejects(() => tokens.create(ws, ann, "root", "x"), /Unknown token/);
  });
  await check("resolve finds an active token, rejects junk, and records last use", async () => {
    assert.deepEqual(await tokens.resolve(t1.token), { userId: ann, workspaceId: ws }); assert.equal(await tokens.resolve("sv_pt_" + "0".repeat(48)), null); assert.equal(await tokens.resolve("nope"), null); assert.equal(await tokens.resolve(undefined), null);
    await new Promise((r) => setTimeout(r, 150)); assert.ok((await tokens.list(ws, ann, "personal"))[0].lastUsedAt);
  });
  await check("the request guard accepts a bearer token as that person and flags it", async () => {
    const req = { cookies: {}, get: (h) => (h.toLowerCase() === "authorization" ? `Bearer ${t1.token}` : undefined), headers: {} };
    let status = null, nextCalled = false; const res = { status(s) { status = s; return this; }, json() { return this; } };
    await TenantGuard(req, res, () => { nextCalled = true; });
    assert.ok(nextCalled, `guard refused with ${status}`); assert.equal(req.user.id, ann); assert.equal(req.workspaceId, ws); assert.equal(req.viaApiToken, true);
  });
  await check("a bad bearer token is a 401, and so is no credential", async () => {
    for (const header of ["Bearer sv_pt_" + "1".repeat(48), "Bearer sv_ws_short", undefined]) {
      const req = { cookies: {}, get: (h) => (h.toLowerCase() === "authorization" ? header : undefined), headers: {} };
      let status = null; const res = { status(s) { status = s; return this; }, json() { return this; } };
      await TenantGuard(req, res, () => assert.fail("must not pass")); assert.equal(status, 401);
    }
  });
  await check("revoke: owner of a personal token only; admins revoke workspace keys; revoked tokens stop working", async () => {
    await assert.rejects(() => tokens.revoke(ws, bob, t1.item.id, { canManageWorkspace: true }), /can't revoke/);
    await assert.rejects(() => tokens.revoke(ws, bob, t2.item.id, { canManageWorkspace: false }), /can't revoke/);
    await tokens.revoke(ws, ann, t1.item.id, { canManageWorkspace: true }); assert.equal(await tokens.resolve(t1.token), null);
    await assert.rejects(() => tokens.revoke(ws, ann, t1.item.id, { canManageWorkspace: true }), /already revoked/);
    await assert.rejects(() => tokens.revoke(other, zed, t2.item.id, { canManageWorkspace: true }), /doesn't exist/);
  });
  await check("a removed user's tokens stop working", async () => { const g = await tokens.create(ws, bob, "personal", "temp"); await db.query(`UPDATE users SET is_deleted = TRUE WHERE id = $1`, [bob]); assert.equal(await tokens.resolve(g.token), null); await db.query(`UPDATE users SET is_deleted = FALSE WHERE id = $1`, [bob]); });
  await check("at most 20 active tokens per person", async () => { for (let i = 0; i < 20; i++) await tokens.create(ws, ann, "personal", `t${i}`); await assert.rejects(() => tokens.create(ws, ann, "personal", "one too many"), /at most 20/); });

  console.log("\n[4] email templates");
  let tpl;
  await check("create, unknown placeholders refused, names unique per workspace", async () => {
    tpl = await lib.createTemplate(ws, ann, { name: "Intro", subject: "Hi {{firstName}}", body: "From {{ senderName }} at {{company}}" }); assert.equal(tpl.shared, true);
    await assert.rejects(() => lib.createTemplate(ws, ann, { name: "Bad", body: "Hi {{contact.first_name}}" }), /aren't supported: \{\{contact.first_name\}\}/);
    await assert.rejects(() => lib.createTemplate(ws, ann, { name: "intro" }), /already have/); await lib.createTemplate(other, zed, { name: "Intro" }); await assert.rejects(() => lib.createTemplate(ws, ann, { name: " " }), /name/);
  });
  await check("private templates are visible only to their author; shared ones to the workspace", async () => {
    await lib.createTemplate(ws, bob, { name: "Bob private", shared: false });
    assert.deepEqual((await lib.listTemplates(ws, ann)).items.map((t) => t.name), ["Intro"]); assert.deepEqual((await lib.listTemplates(ws, bob)).items.map((t) => t.name), ["Bob private", "Intro"]); assert.equal((await lib.listTemplates(ws, bob, { search: "private" })).items.length, 1);
  });
  await check("only the author or an admin can edit or delete", async () => {
    await assert.rejects(() => lib.updateTemplate(ws, bob, tpl.id, { subject: "x" }, { canManage: false }), /Only the person/); await assert.rejects(() => lib.deleteTemplate(ws, bob, tpl.id, { canManage: false }), /Only the person/);
    assert.equal((await lib.updateTemplate(ws, bob, tpl.id, { subject: "Hello {{firstName}}" }, { canManage: true })).subject, "Hello {{firstName}}");
    await assert.rejects(() => lib.updateTemplate(other, zed, tpl.id, { subject: "x" }, { canManage: true }), /not found/i); await lib.deleteTemplate(ws, ann, tpl.id, { canManage: true });
  });

  console.log("\n[5] CRM custom fields");
  let fieldSource, fieldTier;
  await check("create each type; select needs choices; keys come from the name; duplicates refused", async () => {
    fieldSource = await lib.createField(ws, { entity: "deal", label: "Lead Source", type: "select", options: ["Referral", "Outbound", "Referral"] }); assert.equal(fieldSource.key, "lead_source"); assert.deepEqual(fieldSource.options, ["Referral", "Outbound"]);
    fieldTier = await lib.createField(ws, { entity: "deal", label: "Seats", type: "number" }); await lib.createField(ws, { entity: "company", label: "Renewal", type: "date" }); await lib.createField(ws, { entity: "company", label: "Strategic", type: "checkbox" }); await lib.createField(ws, { entity: "company", label: "Notes", type: "text" });
    await assert.rejects(() => lib.createField(ws, { entity: "deal", label: "lead source", type: "text" }), /already exists/); await assert.rejects(() => lib.createField(ws, { entity: "deal", label: "X", type: "select", options: [] }), /at least one choice/);
    await assert.rejects(() => lib.createField(ws, { entity: "person", label: "X", type: "text" }), /deals and companies/); await assert.rejects(() => lib.createField(ws, { entity: "deal", label: "X", type: "color" }), /field type/); await assert.rejects(() => lib.createField(ws, { entity: "deal", label: "!!!", type: "text" }), /name/);
    assert.equal((await lib.listFields(ws, "deal")).length, 2); assert.equal((await lib.listFields(other)).length, 0);
  });
  await check("values are validated per type on deals and companies, and persist", async () => {
    const d = await crm.createDeal(ws, ann, { title: "Big", custom: { lead_source: "Referral", seats: "12" } }); assert.deepEqual(d.custom, { lead_source: "Referral", seats: 12 });
    await assert.rejects(() => crm.createDeal(ws, ann, { title: "x", custom: { lead_source: "Cold" } }), /one of: Referral, Outbound/); await assert.rejects(() => crm.createDeal(ws, ann, { title: "x", custom: { seats: "many" } }), /must be a number/); await assert.rejects(() => crm.createDeal(ws, ann, { title: "x", custom: { nope: 1 } }), /no custom field/);
    const u = await crm.updateDeal(ws, d.id, { custom: { seats: 20 } }); assert.deepEqual(u.custom, { lead_source: "Referral", seats: 20 }); const cleared = await crm.updateDeal(ws, d.id, { custom: { seats: null } }); assert.deepEqual(cleared.custom, { lead_source: "Referral" });
    const c = await crm.createCompany(ws, ann, { name: "Initech", custom: { renewal: "2026-12-31", strategic: true } }); assert.deepEqual(c.custom, { renewal: "2026-12-31", strategic: true });
    await assert.rejects(() => crm.updateCompany(ws, c.id, { custom: { renewal: "tomorrow" } }), /date like/); await assert.rejects(() => crm.updateCompany(ws, c.id, { custom: { strategic: "yes" } }), /yes or no/);
    assert.equal((await crm.updateCompany(ws, c.id, { custom: { notes: "Renews in Q4" } })).custom.renewal, "2026-12-31");
  });
  await check("renaming a field keeps its key; deleting one removes its values everywhere", async () => {
    const r = await lib.updateField(ws, fieldTier.id, { label: "Seat count" }); assert.equal(r.key, "seats"); await lib.deleteField(ws, fieldSource.id);
    const { rows } = await db.query(`SELECT custom FROM crm_deals WHERE workspace_id = $1 AND title = 'Big'`, [ws]); assert.ok(!("lead_source" in rows[0].custom)); await assert.rejects(() => lib.deleteField(other, fieldTier.id), /not found/i);
  });

  console.log("\n[6] call and meeting outcomes");
  await check("built-in outcomes appear once per workspace and can't be edited or deleted", async () => {
    const list = await lib.listOutcomes(ws); assert.equal(list.length, 10); assert.equal((await lib.listOutcomes(ws)).length, 10); assert.ok(list.every((o) => o.system));
    const answered = list.find((o) => o.name === "Answered"); await assert.rejects(() => lib.updateOutcome(ws, answered.id, { name: "x" }), /can't be renamed/); await assert.rejects(() => lib.deleteOutcome(ws, answered.id), /can't be deleted/);
  });
  let mine;
  await check("custom outcomes: add, duplicate refused, rename, delete", async () => {
    mine = await lib.createOutcome(ws, { name: "Asked to call back", group: "call" }); await assert.rejects(() => lib.createOutcome(ws, { name: "asked to call back", group: "call" }), /already exists/); await lib.createOutcome(ws, { name: "Asked to call back", group: "meeting" });
    await assert.rejects(() => lib.createOutcome(ws, { name: "x", group: "email" }), /calls or meetings/); await assert.rejects(() => lib.createOutcome(ws, { name: "" , group: "call" }), /name/);
    assert.equal((await lib.updateOutcome(ws, mine.id, { name: "Call back later" })).name, "Call back later");
  });
  await check("an appointment records an outcome from the list; renaming follows, deleting clears", async () => {
    const b = (await db.query(`INSERT INTO sdr_bookings (workspace_id, mailbox_id, thread_id, lead_email, scheduled_start, scheduled_end) VALUES ($1,1,'o1','a@b.c',NOW(),NOW() + INTERVAL '30 minutes') RETURNING id`, [ws])).rows[0].id;
    await assert.rejects(() => crm.updateAppointment(ws, b, { outcome: "Made up" }), /isn't one of your outcomes/); await assert.rejects(() => crm.updateAppointment(other, b, { outcome: "Held" }), /not found/i);
    await crm.updateAppointment(ws, b, { outcome: "Call back later" }); assert.equal((await crm.listAppointments(ws, { when: "all" })).items[0].outcome, "Call back later");
    await lib.updateOutcome(ws, mine.id, { name: "Ring again" }); assert.equal((await crm.listAppointments(ws, { when: "all" })).items[0].outcome, "Ring again");
    await lib.deleteOutcome(ws, mine.id); assert.equal((await crm.listAppointments(ws, { when: "all" })).items[0].outcome, null); assert.equal((await crm.updateAppointment(ws, b, { outcome: "Held" })).outcome, "Held"); assert.equal((await crm.updateAppointment(ws, b, { outcome: null })).outcome, null);
  });

  console.log("\n[7] workspace snapshots");
  await check("two built-in snapshots with item counts", async () => { const s = await lib.listSnapshots(ws); assert.equal(s.builtIn.length, 2); assert.ok(s.builtIn[0].counts.rules >= 3 && s.builtIn[0].counts.templates === 2); });
  await check("applying a built-in adds rules, templates and a meeting type, and is safe to repeat", async () => {
    await db.query(`INSERT INTO sdr_rules (workspace_id, rule, position) VALUES ($1, 'KEEP REPLIES UNDER 120 WORDS AND END WITH ONE CLEAR QUESTION OR NEXT STEP.', 1)`, [ws]);
    const first = await lib.applySnapshot(ws, ann, "builtin-cold-outreach"); assert.deepEqual([first.added.rules, first.added.templates, first.added.meetingTypes], [2, 2, 1]);
    const again = await lib.applySnapshot(ws, ann, "builtin-cold-outreach"); assert.deepEqual([again.added.rules, again.added.templates, again.added.meetingTypes], [0, 0, 0]);
    assert.equal((await db.query(`SELECT COUNT(*)::int n FROM sdr_rules WHERE workspace_id = $1`, [ws])).rows[0].n, 3);
  });
  await check("capture bundles the current setup; same name bumps the version", async () => {
    await db.query(`INSERT INTO sdr_settings (workspace_id, knowledge_base) VALUES ($1, 'We sell widgets.') ON CONFLICT (workspace_id) DO UPDATE SET knowledge_base = 'We sell widgets.'`, [ws]);
    const a = await lib.captureSnapshot(ws, ann, { name: "My setup", description: "v1" }); assert.equal(a.version, 1); assert.ok(a.counts.rules >= 3 && a.counts.templates >= 2 && a.counts.knowledgeBase === 1 && a.counts.customFields >= 3);
    assert.equal((await lib.captureSnapshot(ws, ann, { name: "my SETUP" })).version, 2); await assert.rejects(() => lib.captureSnapshot(ws, ann, { name: "" }), /name/);
  });
  await check("applying a custom snapshot to another workspace copies config, never overwrites a filled knowledge base", async () => {
    const snap = (await lib.listSnapshots(ws)).custom[0]; await assert.rejects(() => lib.applySnapshot(other, zed, snap.id), /not found/i);
    const copy = await lib.captureSnapshot(ws, ann, { name: "Portable" }); const items = (await db.query(`SELECT items FROM workspace_snapshots WHERE id = $1`, [copy.id])).rows[0].items;
    const into = await mkWs("c"); await db.query(`INSERT INTO workspace_snapshots (workspace_id, name, items) VALUES ($1, 'Portable', $2::jsonb)`, [into, JSON.stringify(items)]);
    await db.query(`INSERT INTO sdr_settings (workspace_id, knowledge_base) VALUES ($1, 'Existing text.')`, [into]);
    const id = (await db.query(`SELECT id FROM workspace_snapshots WHERE workspace_id = $1`, [into])).rows[0].id; const r = await lib.applySnapshot(into, zed, String(id));
    assert.equal(r.added.knowledgeBase, 0); assert.equal((await db.query(`SELECT knowledge_base FROM sdr_settings WHERE workspace_id = $1`, [into])).rows[0].knowledge_base, "Existing text."); assert.ok(r.added.rules >= 3 && r.added.customFields >= 3);
    await db.query(`DELETE FROM workspaces WHERE id = $1`, [into]);
  });
  await check("delete a custom snapshot; built-ins can't be deleted", async () => { const s = (await lib.listSnapshots(ws)).custom; await lib.deleteSnapshot(ws, s[0].id); await assert.rejects(() => lib.deleteSnapshot(ws, "builtin-agency"), /not found/i); await assert.rejects(() => lib.applySnapshot(ws, ann, "nope"), /not found/i); });

  console.log("\n[8] blocklist");
  await check("add: normalises, de-duplicates, reports bad entries, domains are not accepted", async () => {
    const r = await block.add(ws, { emails: "A@One.com, a@one.com\nb@two.com; not-an-email @three.com" }); assert.equal(r.added, 2); assert.deepEqual(r.invalid.sort(), ["@three.com", "not-an-email"]);
    await assert.rejects(() => block.add(ws, { emails: "" }), /at least one/);
  });
  await check("list: newest first, search, reason filter, paging, isolation", async () => {
    await db.query(`INSERT INTO suppressions (email, reason, source, workspace_id) VALUES ('c@three.com','unsubscribed','link_click',$1)`, [ws]);
    const all = await block.list(ws, {}); assert.equal(all.total, 3); assert.equal(all.items[0].email, "c@three.com"); assert.equal((await block.list(ws, { search: "one.com" })).total, 1); assert.equal((await block.list(ws, { reason: "unsubscribed" })).total, 1);
    assert.equal((await block.list(ws, { limit: 2, page: 2 })).items.length, 1); assert.equal((await block.list(other, {})).total, 0); assert.equal((await block.list(ws, { search: "%" })).total, 0); await assert.rejects(() => block.list(ws, { reason: "x" }), /Unknown reason/);
  });
  await check("import CSV with a header, a plain list, bad rows, and repeats", async () => {
    const r = await block.importCsv(ws, "name,email\nAnn,x1@imp.com\nBob,X2@imp.com\nBad,nope\nDup,x1@imp.com\nOld,a@one.com\n"); assert.equal(r.added, 2); assert.equal(r.alreadyBlocked, 1); assert.equal(r.invalidCount, 1); assert.deepEqual(r.invalid, ["nope"]);
    assert.equal((await block.importCsv(ws, "p1@imp.com\np2@imp.com")).added, 2); await assert.rejects(() => block.importCsv(ws, "  \n "), /empty/);
  });
  await check("export CSV has a header, every row, and neutralises spreadsheet formulas", async () => {
    await db.query(`INSERT INTO suppressions (email, reason, source, workspace_id) VALUES ('=cmd@x.com','manual','manual',$1)`, [ws]);
    const csv = await block.exportCsv(ws); const lines = csv.trim().split("\n"); assert.equal(lines[0], "email,reason,source,blocked_at"); assert.equal(lines.length, 1 + (await block.list(ws, {})).total); assert.ok(lines.some((l) => l.startsWith("'=cmd@x.com"))); assert.ok(!(await block.exportCsv(other)).includes("@one.com"));
  });
  await check("remove by id, only in this workspace", async () => {
    const ids = (await block.list(ws, { search: "imp.com" })).items.map((i) => i.id); const theirs = (await db.query(`INSERT INTO suppressions (email, reason, source, workspace_id) VALUES ('t@them.com','manual','manual',$1) RETURNING id`, [other])).rows[0].id;
    const r = await block.remove(ws, { ids: [...ids, theirs] }); assert.equal(r.removed, ids.length); assert.equal((await block.list(other, {})).total, 1); await assert.rejects(() => block.remove(ws, { ids: [] }), /at least one/);
  });
  await check("1,000 imported addresses go in quickly", async () => { const t = Date.now(); const r = await block.importCsv(ws, Array.from({ length: 1000 }, (_, i) => `bulk${i}@perf.com`).join("\n")); assert.equal(r.added, 1000); assert.ok(Date.now() - t < 3000); });

  console.log("\n[9] billing summary");
  await check("domains with inbox counts, totals and open requests", async () => {
    const d = (await db.query(`INSERT INTO domains (domain, status, provider, workspace_id) VALUES ($1,'Verified','Postal',$2) RETURNING id`, [`bill-${stamp}.invalid`, ws])).rows[0].id;
    for (const [n, status] of [["a", "Active"], ["b", "Paused"]]) await db.query(`INSERT INTO mailboxes (domain_id, email, local_part, display_name, status, daily_limit, provider, workspace_id) VALUES ($1,$2,$3,$3,$4,20,'postal',$5)`, [d, `${n}@bill-${stamp}.invalid`, n, status, ws]);
    await db.query(`INSERT INTO provisioning_requests (workspace_id, type, quantity, requested_by, status) VALUES ($1,'mailboxes',2,$2,'requested')`, [ws, ann]).catch(() => {});
    const s = await billing.summary({ id: ws, plan: { type: "trial", days_left: 5, limits: [] } }); assert.deepEqual(s.totals, { domains: 1, inboxes: 2, activeInboxes: 1 }); assert.equal(s.domains[0].inboxes, 2); assert.equal(s.plan.type, "trial");
    assert.equal((await billing.summary({ id: other, plan: null })).totals.domains, 0);
  });

  for (const id of [ws, other]) { for (const t of ["messages", "mailboxes", "domains", "suppressions", "provisioning_requests"]) await db.query(`DELETE FROM ${t} WHERE workspace_id = $1`, [id]).catch(() => {}); await db.query(`DELETE FROM workspaces WHERE id = $1`, [id]); }
  await db.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${stamp}@settings.invalid`]);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
