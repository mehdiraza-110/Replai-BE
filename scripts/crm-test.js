// Verifies the CRM and Dashboard services in the LOCAL sandbox (database only, nothing is sent anywhere).
// Run from the workspace root:  ./dev-local.sh node scripts/crm-test.js
const BE = require("path").resolve(__dirname, "..");
const assert = require("assert");
const db = require(`${BE}/config/db.config`);
const crm = require(`${BE}/services/crm.service`);
const dash = require(`${BE}/services/dashboard.service`);

let pass = 0, fail = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log("  PASS", name); }, (e) => { fail++; console.log("  FAIL", name, "->", e.message); });
const stamp = Date.now();
const mkWs = async (tag) => (await db.query(`INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id`, [`CRM ${tag} ${stamp}`, `crm-${tag}-${stamp}`])).rows[0].id;
const mkUser = async (tag, ws, role = "member") => {
  const id = (await db.query(`INSERT INTO users (first_name, last_name, email, password_hash) VALUES ($1, 'Tester', $2, 'x') RETURNING id`, [tag, `${tag}-${stamp}@crm.invalid`])).rows[0].id;
  if (ws) await db.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,$3)`, [ws, id, role]);
  return id;
};
const iso = (d) => d.toISOString();
const day = 86400000;

(async () => {
  const ws = await mkWs("a"), other = await mkWs("b");
  const ann = await mkUser("Ann", ws, "owner"), bob = await mkUser("Bob", ws), outsider = await mkUser("Zed", other);

  console.log("\n[1] tasks");
  let t1, t2;
  await check("create needs a title; trims; links to a record", async () => {
    await assert.rejects(() => crm.createTask(ws, ann, { title: "   " }), /title/i);
    t1 = await crm.createTask(ws, ann, { title: "  Call Acme  ", dueAt: iso(new Date(Date.now() - 2 * 3600000)), assigneeUserId: bob, recordType: "person", recordId: "x@acme.com", recordLabel: "Xavier Acme" });
    assert.equal(t1.title, "Call Acme"); assert.equal(t1.assigneeName, "Bob Tester"); assert.equal(t1.overdue, true); assert.equal(t1.recordLabel, "Xavier Acme");
  });
  await check("a due date round-trips exactly (no timezone shift)", async () => { const when = new Date(Date.now() + 3 * day); t2 = await crm.createTask(ws, ann, { title: "Send proposal", dueAt: iso(when) }); assert.equal(new Date(t2.dueAt).getTime(), when.getTime()); assert.equal(t2.overdue, false); });
  await check("bad date and non-member assignee are refused", async () => { await assert.rejects(() => crm.createTask(ws, ann, { title: "x", dueAt: "not-a-date" }), /valid date/); await assert.rejects(() => crm.createTask(ws, ann, { title: "x", assigneeUserId: outsider }), /not a member/); });
  await check("several manual tasks on one record are allowed", async () => { await crm.createTask(ws, ann, { title: "a", recordType: "person", recordId: "x@acme.com" }); await crm.createTask(ws, ann, { title: "b", recordType: "person", recordId: "x@acme.com" }); });
  await check("list: open by default, overdue first by due date, counts overdue", async () => { const r = await crm.listTasks(ws, {}); assert.equal(r.items[0].id, t1.id); assert.equal(r.overdueTotal, 1); assert.ok(r.items.every((t) => t.status === "open")); });
  await check("filters: assignee me / none, overdue, search", async () => {
    assert.equal((await crm.listTasks(ws, { assignee: "me", userId: bob })).total, 1);
    assert.equal((await crm.listTasks(ws, { assignee: "none" })).total, 3);
    assert.equal((await crm.listTasks(ws, { overdue: "1" })).total, 1);
    assert.equal((await crm.listTasks(ws, { search: "xavier" })).total, 1);
    assert.equal((await crm.listTasks(ws, { search: "%" })).total, 0);
  });
  await check("complete, reopen and edit", async () => {
    const done = await crm.updateTask(ws, t1.id, { status: "done" }); assert.equal(done.status, "done"); assert.ok(done.completedAt); assert.equal(done.overdue, false);
    assert.equal((await crm.listTasks(ws, { status: "done" })).total, 1);
    const re = await crm.updateTask(ws, t1.id, { status: "open", title: "Call Acme again", dueAt: null }); assert.equal(re.completedAt, null); assert.equal(re.dueAt, null);
    await assert.rejects(() => crm.updateTask(ws, t1.id, { status: "weird" }), /open or done/);
  });
  await check("the AI escalation task still dedupes per thread, and manual ones are untouched", async () => {
    const ins = () => db.query(`INSERT INTO crm_tasks (workspace_id, title, record_type, record_id, source) VALUES ($1,'esc','thread','1:t','ai_sdr') ON CONFLICT (workspace_id, record_type, record_id, source) WHERE status = 'open' AND record_id IS NOT NULL DO NOTHING`, [ws]);
    await ins(); await ins();
    assert.equal((await db.query(`SELECT COUNT(*)::int n FROM crm_tasks WHERE workspace_id=$1 AND source='ai_sdr'`, [ws])).rows[0].n, 1);
  });
  await check("another workspace cannot read, edit or delete it", async () => { assert.equal((await crm.listTasks(other, {})).total, 0); await assert.rejects(() => crm.updateTask(other, t2.id, { title: "x" }), /not found/i); await assert.rejects(() => crm.deleteTask(other, t2.id), /not found/i); });
  await check("delete", async () => { await crm.deleteTask(ws, t2.id); await assert.rejects(() => crm.deleteTask(ws, t2.id), /not found/i); });

  console.log("\n[2] companies and deals");
  let acme, deal;
  await check("company: create, unique per workspace (case-insensitive), edit, rename clash", async () => {
    acme = await crm.createCompany(ws, ann, { name: "Acme Inc", website: "acme.com", industry: "SaaS" });
    await assert.rejects(() => crm.createCompany(ws, ann, { name: "ACME inc" }), /already have/);
    await crm.createCompany(other, outsider, { name: "Acme Inc" });
    await crm.createCompany(ws, ann, { name: "Globex" });
    const u = await crm.updateCompany(ws, acme.id, { industry: "Software" }); assert.equal(u.industry, "Software");
    await assert.rejects(() => crm.updateCompany(ws, acme.id, { name: "globex" }), /already have/);
    await assert.rejects(() => crm.updateCompany(ws, acme.id, { name: "" }), /name/i);
  });
  await check("deal: create with defaults, validation, stage change closes it, reopening clears closed", async () => {
    await assert.rejects(() => crm.createDeal(ws, ann, { title: "x", value: -5 }), /positive/); await assert.rejects(() => crm.createDeal(ws, ann, { title: "x", stage: "nope" }), /stage/); await assert.rejects(() => crm.createDeal(ws, ann, { title: "x", companyId: 99999999 }), /company/i);
    deal = await crm.createDeal(ws, ann, { title: "Acme pilot", value: 12000, companyId: acme.id, personEmail: "X@Acme.com", expectedClose: "2026-12-01" });
    assert.deepEqual([deal.stage, deal.value, deal.companyName, deal.personEmail, deal.expectedClose, deal.ownerUserId], ["lead", 12000, "Acme Inc", "x@acme.com", "2026-12-01", ann]);
    const won = await crm.updateDeal(ws, deal.id, { stage: "won" }); assert.ok(won.closedAt);
    const back = await crm.updateDeal(ws, deal.id, { stage: "proposal" }); assert.equal(back.closedAt, null);
  });
  await check("deals list: totals by stage, open vs won value, filters", async () => {
    await crm.createDeal(ws, ann, { title: "Globex", value: 500, stage: "qualified" }); await crm.createDeal(ws, ann, { title: "Lost one", value: 99, stage: "lost" }); await crm.createDeal(ws, ann, { title: "Big win", value: 1000, stage: "won" });
    const r = await crm.listDeals(ws, {}); assert.equal(r.summary.openValue, 12500); assert.equal(r.summary.openCount, 2); assert.equal(r.summary.wonValue, 1000); assert.equal(r.byStage.lost.count, 1);
    assert.equal((await crm.listDeals(ws, { stage: "won" })).items.length, 1); assert.equal((await crm.listDeals(ws, { search: "acme" })).items.length, 1);
  });
  await check("a deal can't be pointed at another workspace's company or owner", async () => { const theirs = await crm.createCompany(other, outsider, { name: "Theirs" }); await assert.rejects(() => crm.updateDeal(ws, deal.id, { companyId: theirs.id }), /company/i); await assert.rejects(() => crm.updateDeal(ws, deal.id, { ownerUserId: outsider }), /not a member/); });
  await check("company list counts deals, open value and people from the lead library", async () => {
    const list = (await db.query(`INSERT INTO lead_lists (workspace_id, name) VALUES ($1,'L') RETURNING id`, [ws])).rows[0].id;
    await db.query(`INSERT INTO lead_contacts (workspace_id, list_id, email, full_name, company) VALUES ($1,$2,'a@acme.com','A One','ACME INC'), ($1,$2,'b@acme.com','B Two','Acme Inc')`, [ws, list]);
    const row = (await crm.listCompanies(ws, { search: "acme" })).items[0]; assert.deepEqual([row.people, row.deals, row.openDealValue], [2, 1, 12000]);
  });
  await check("deleting a company keeps its deals", async () => { await crm.deleteCompany(ws, acme.id); const d = await crm.listDeals(ws, { search: "Acme pilot" }); assert.equal(d.items[0].companyId, null); });

  console.log("\n[3] notes, people, appointments, scheduled, submissions");
  await check("notes: create, list newest first, search, delete, empty refused", async () => {
    await assert.rejects(() => crm.createNote(ws, ann, { body: " " }), /something/);
    const n1 = await crm.createNote(ws, ann, { body: "Likes the pricing", recordType: "person", recordLabel: "A One" }); await crm.createNote(ws, bob, { body: "Second note" });
    const r = await crm.listNotes(ws, {}); assert.equal(r.items[0].body, "Second note"); assert.equal(r.items[0].authorName, "Bob Tester"); assert.equal((await crm.listNotes(ws, { search: "pricing" })).total, 1);
    await crm.deleteNote(ws, n1.id); assert.equal((await crm.listNotes(ws, {})).total, 1); assert.equal((await crm.listNotes(other, {})).total, 0);
  });
  await check("people: one row per email across lists, with campaign and reply info", async () => {
    const list2 = (await db.query(`INSERT INTO lead_lists (workspace_id, name) VALUES ($1,'L2') RETURNING id`, [ws])).rows[0].id;
    await db.query(`INSERT INTO lead_contacts (workspace_id, list_id, email, first_name, last_name) VALUES ($1,$2,'A@acme.com','A','Dup')`, [ws, list2]);
    const r = await crm.listPeople(ws, {}); assert.equal(r.total, 2); assert.equal((await crm.listPeople(ws, { search: "b@acme" })).total, 1); assert.equal((await crm.listPeople(other, {})).total, 0);
    assert.equal(r.items.find((p) => p.email.toLowerCase() === "b@acme.com").name, "B Two");
  });
  await check("people: leads that only exist on a campaign (never in the library) are listed; the library row wins when both exist", async () => {
    const camp = (await db.query(`INSERT INTO campaigns (workspace_id, name, subject, body) VALUES ($1,'Legacy','s','b') RETURNING id`, [ws])).rows[0].id;
    await db.query(`INSERT INTO campaign_leads (workspace_id, campaign_id, email, first_name, last_name, company) VALUES ($1,$2,'only@camp.com','Only','Camp','CampCo'),($1,$2,'a@acme.com','Camp','Version','Other')`, [ws, camp]);
    const r = await crm.listPeople(ws, {});
    assert.equal(r.total, 3);
    assert.equal(r.items.find((p) => p.email === "only@camp.com").company, "CampCo");
    assert.notEqual(r.items.find((p) => p.email.toLowerCase() === "a@acme.com").company, "Other");
    assert.equal((await crm.listPeople(other, {})).total, 0);
    await db.query(`DELETE FROM campaign_leads WHERE campaign_id = $1`, [camp]); await db.query(`DELETE FROM campaigns WHERE id = $1`, [camp]);
  });
  await check("appointments: upcoming vs past, ordered", async () => {
    const add = (mins, who) => db.query(`INSERT INTO sdr_bookings (workspace_id, mailbox_id, thread_id, lead_email, lead_name, scheduled_start, scheduled_end, handler_user_id) VALUES ($1,1,'t'||$4::text,$2,$3,NOW() + ($4 || ' minutes')::interval, NOW() + (($4::int + 30) || ' minutes')::interval, $5)`, [ws, `${who}@x.com`, who, String(mins), ann]);
    await add(120, "soon"); await add(5000, "later"); await add(-3000, "past");
    const up = await crm.listAppointments(ws, {}); assert.deepEqual(up.items.map((a) => a.leadName), ["soon", "later"]); assert.equal(up.items[0].handlerName, "Ann Tester");
    assert.deepEqual((await crm.listAppointments(ws, { when: "past" })).items.map((a) => a.leadName), ["past"]); assert.equal((await crm.listAppointments(ws, { when: "all" })).total, 3);
  });
  await check("scheduled follow-ups and lead submissions list", async () => {
    await db.query(`INSERT INTO sdr_thread_state (workspace_id, mailbox_id, thread_id, follow_up_at, followup_by) VALUES ($1,1,'sched',NOW() + INTERVAL '2 days','ai')`, [ws]);
    const s = await crm.listScheduled(ws, {}); assert.equal(s.total, 1); assert.equal(s.items[0].scheduledBy, "ai"); assert.equal((await crm.listScheduled(other, {})).total, 0);
    assert.equal((await crm.listSubmissions(ws, {})).total, 0);
  });
  await check("members list is this workspace only", async () => { const m = await crm.listMembers(ws); assert.deepEqual(m.map((x) => x.name).sort(), ["Ann Tester", "Bob Tester"]); });

  console.log("\n[4] dashboard");
  await check("catalog keys are unique and each widget has a type", () => { const keys = dash.CATALOG.map((w) => w.key); assert.equal(new Set(keys).size, keys.length); assert.ok(dash.CATALOG.every((w) => ["stat", "chart", "list"].includes(w.type))); });
  let mb;
  await check("setup: messages across two periods", async () => {
    const dom = (await db.query(`INSERT INTO domains (domain, status, provider, workspace_id) VALUES ($1,'Verified','Postal',$2) RETURNING id`, [`dash-${stamp}.invalid`, ws])).rows[0].id;
    mb = (await db.query(`INSERT INTO mailboxes (domain_id, email, local_part, display_name, status, daily_limit, provider, workspace_id) VALUES ($1,$2,'a','A','Active',20,'postal',$3) RETURNING id`, [dom, `a@dash-${stamp}.invalid`, ws])).rows[0].id;
    const msg = (dir, daysAgo, thread, author) => db.query(`INSERT INTO messages (mailbox_id, workspace_id, direction, thread_id, from_address, to_address, created_at, author) VALUES ($1,$2,$3,$4,'a@x','b@y', (CURRENT_DATE - $5::int) + TIME '12:00', $6)`, [mb, ws, dir, thread, daysAgo, author]);
    for (let i = 0; i < 5; i++) await msg("outbound", 1, `t${i}`, null);       // 5 sent, current period
    for (let i = 0; i < 2; i++) await msg("outbound", 40, `p${i}`, null);       // 2 sent, previous 30-day period
    await msg("outbound", 1, "ai1", "ai");                                       // an AI reply is not a campaign send
    await msg("inbound", 1, "t0"); await msg("inbound", 2, "t1"); await msg("inbound", 45, "p0");
    await db.query(`INSERT INTO sdr_thread_state (workspace_id, mailbox_id, thread_id, interest) VALUES ($1,$2,'t0','very_high'), ($1,$2,'t1','low')`, [ws, mb]);
    await db.query(`INSERT INTO sdr_bookings (workspace_id, mailbox_id, thread_id, lead_email, scheduled_start, scheduled_end, status) VALUES ($1,$2,'t0','b@y',NOW() + INTERVAL '1 day', NOW() + INTERVAL '1 day 30 minutes','booked')`, [ws, mb]);
  });
  await check("stat tiles count the period and the one before; AI replies are not sends", async () => {
    const d = await dash.data(ws, { days: 30, widgets: "emails_sent,replies,positive_replies,meetings_booked" });
    assert.deepEqual(d.widgets.emails_sent, { value: 5, previous: 2 }); assert.deepEqual(d.widgets.replies, { value: 2, previous: 1 });
    assert.equal(d.widgets.positive_replies.value, 1); assert.equal(d.widgets.meetings_booked.value, 4); // the three appointments from [3] plus this one
    assert.equal((await dash.data(ws, { days: 7, widgets: "emails_sent" })).widgets.emails_sent.value, 5);
  });
  await check("workspace isolation", async () => { const d = await dash.data(other, { days: 30, widgets: "emails_sent,replies,open_tasks,pipeline_value" }); assert.deepEqual([d.widgets.emails_sent.value, d.widgets.replies.value, d.widgets.open_tasks.value, d.widgets.pipeline_value.value], [0, 0, 0, 0]); });
  await check("snapshots: tasks, inboxes, pipeline and won value", async () => { const d = await dash.data(ws, { days: 30, widgets: "open_tasks,overdue_tasks,active_inboxes,pipeline_value,deals_won" }); assert.deepEqual(Object.values(d.widgets).map((w) => w.value), [4, 0, 1, 12500, 1000]); });
  await check("chart: one point per day including empty days, zero-filled", async () => {
    const s = (await dash.data(ws, { days: 7, widgets: "sent_vs_replies" })).widgets.sent_vs_replies.series;
    assert.equal(s.length, 7); const y = s.find((p) => p.sent === 5); assert.ok(y && y.replies === 1); assert.equal(s.reduce((n, p) => n + p.sent, 0), 5); assert.ok(s.some((p) => p.sent === 0));
    assert.equal((await dash.data(ws, { days: 90, widgets: "meetings_per_day,new_leads_per_day" })).widgets.new_leads_per_day.series.length, 90);
  });
  await check("lists: upcoming appointments, tasks due, pipeline by stage", async () => {
    const d = (await dash.data(ws, { days: 30, widgets: "upcoming_appointments,tasks_due,pipeline_by_stage" })).widgets;
    assert.ok(d.upcoming_appointments.rows.length >= 1); assert.ok(d.tasks_due.rows.length >= 1); assert.equal(d.pipeline_by_stage.rows.length, 6); assert.equal(d.pipeline_by_stage.rows.find((r) => r.stage === "won").value, 1000);
  });
  await check("bad range and unknown widget are refused", async () => { await assert.rejects(() => dash.data(ws, { days: 14, widgets: "replies" }), /7, 30 or 90/); await assert.rejects(() => dash.data(ws, { days: 30, widgets: "nope" }), /Unknown widget/); });

  console.log("\n[5] dashboard views");
  let v;
  await check("first load seeds one default view", async () => { const l = await dash.listViews(ws, ann); assert.equal(l.length, 1); assert.equal(l[0].isDefault, true); assert.equal(l[0].widgets.length, dash.DEFAULT_WIDGETS.length); assert.equal((await dash.listViews(ws, ann)).length, 1); });
  await check("create: validates widgets, size falls back, duplicates and names refused", async () => {
    v = await dash.createView(ws, ann, { name: "Sales", widgets: [{ key: "replies", size: "m" }, { key: "tasks_due", size: "huge" }] }); assert.equal(v.widgets[1].size, "m");
    await assert.rejects(() => dash.createView(ws, ann, { name: "sales" }), /already have/); await assert.rejects(() => dash.createView(ws, ann, { name: "" }), /name/);
    await assert.rejects(() => dash.createView(ws, ann, { name: "Bad", widgets: [{ key: "x" }] }), /Unknown widget/); await assert.rejects(() => dash.createView(ws, ann, { name: "Dup", widgets: [{ key: "replies" }, { key: "replies" }] }), /already on/);
  });
  await check("update layout and rename; making a view default moves the flag; default can't be deleted", async () => {
    const u = await dash.updateView(ws, v.id, { widgets: [{ key: "tasks_due", size: "l" }, { key: "replies", size: "s" }] }); assert.deepEqual(u.widgets.map((w) => w.key), ["tasks_due", "replies"]);
    await dash.updateView(ws, v.id, { isDefault: true }); const l = await dash.listViews(ws, ann); assert.equal(l[0].id, v.id); assert.equal(l.filter((x) => x.isDefault).length, 1);
    await assert.rejects(() => dash.deleteView(ws, v.id), /default/); await dash.deleteView(ws, l[1].id);
  });
  await check("views are per workspace", async () => { await assert.rejects(() => dash.updateView(other, v.id, { name: "hack" }), /not found/i); await assert.rejects(() => dash.deleteView(other, v.id), /not found/i); });

  for (const id of [ws, other]) {
    for (const table of ["messages", "mailboxes", "domains"]) await db.query(`DELETE FROM ${table} WHERE workspace_id = $1`, [id]);
    await db.query(`DELETE FROM workspaces WHERE id = $1`, [id]);
  }
  await db.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${stamp}@crm.invalid`]);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
