// Exercises the AI SDR's calendar booking, follow-ups, Forward and per-campaign overrides end to end in the LOCAL sandbox.
// The model, the calendar provider and the mail sender are all stubbed, so nothing leaves the machine.
// Run from the workspace root:  ./dev-local.sh node scripts/sdr-scheduling-test.js
const BE = require("path").resolve(__dirname, "..");
const assert = require("assert");
const db = require(`${BE}/config/db.config`);
const inboundEmail = require(`${BE}/services/inboundEmail.service`);
const inboxService = require(`${BE}/services/inbox.service`);
const mailTransport = require(`${BE}/services/mailTransport.service`);
const agent = require(`${BE}/services/sdr/agent.service`);
const threadState = require(`${BE}/services/sdr/threadState.service`);
const settings = require(`${BE}/services/sdr/settings.service`);
const sdr = require(`${BE}/services/sdr/inbound.service`);
const classifier = require(`${BE}/services/sdr/classifier.service`);
const scheduling = require(`${BE}/services/sdr/scheduling.service`);
const followups = require(`${BE}/services/sdr/followup.service`);
const forward = require(`${BE}/services/sdr/forward.service`);
const controller = require(`${BE}/controllers/aiSdr.controller`);

let pass = 0, fail = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log("  PASS", name); }, (e) => { fail++; console.log("  FAIL", name, "->", e.message); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = Date.now();
const HOUR = 3600000;

const sent = [];            // bodies sent through the stubbed inbox sender
const forwarded = [];       // raw messages passed to the stubbed transport
const events = [];          // calendar events created through the stubbed provider
let busy = [];              // busy intervals the stubbed calendar reports
let nextGenerate = null;    // what the stubbed model returns next
const modelCalls = [];

inboxService.sendReply = async (mailboxId, threadId, { body }, workspaceId) => {
  const row = (await db.query(`INSERT INTO messages (mailbox_id, direction, thread_id, from_address, to_address, subject, body_text, workspace_id) VALUES ($1,'outbound',$2,'sam','p','Re: Quick question',$3,$4) RETURNING id`, [mailboxId, threadId, body, workspaceId])).rows[0];
  sent.push(body);
  return { id: row.id };
};
mailTransport.sendRawEmail = async ({ to, raw }) => { forwarded.push({ to, raw: String(raw) }); };
scheduling.provider = {
  fetchBusy: async () => busy,
  createEvent: async (_conn, event) => { events.push(event); return { id: `evt_${events.length}`, meetLink: "https://meet.example.com/abc-defg" }; },
};
const originalGenerate = agent.generate;
agent.generate = async ({ context }) => { modelCalls.push(context); return typeof nextGenerate === "function" ? nextGenerate(context) : nextGenerate; };

const reply = (over = {}) => ({ intent: "meeting_request", interest: "very_high", shouldReply: true, escalate: false, escalateReason: "", wantsMeeting: true, relevantFact: "", reply: "Hi Jordan,\nHappy to talk.\nSam Seller\nOwner | Acme", generatedBy: "stub:model", ...over });

async function seed() {
  const ws = (await db.query(`INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id`, [`SDR scheduling ${stamp}`, `sdr-sched-${stamp}`])).rows[0].id;
  const user = (await db.query(`INSERT INTO users (email, password_hash, first_name, last_name) VALUES ($1, 'x', 'Yuri', 'Handler') RETURNING id`, [`handler${stamp}@sdrtest.invalid`])).rows[0].id;
  await db.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [ws, user]);
  await db.query(`INSERT INTO calendar_connections (workspace_id, user_id, ai_agent_id, provider, google_email, status, calendar_id) VALUES ($1, $2, NULL, 'google', $3, 'connected', 'primary')`, [ws, user, `handler${stamp}@sdrtest.invalid`]);
  const domain = (await db.query(`INSERT INTO domains (domain, status, workspace_id) VALUES ($1, 'Verified', $2) RETURNING id`, [`sched${stamp}.invalid`, ws])).rows[0].id;
  const mailbox = (await db.query(`INSERT INTO mailboxes (domain_id, email, local_part, display_name, workspace_id, provider) VALUES ($1, $2, 'sam', 'Sam Seller', $3, 'Test') RETURNING *`, [domain, `sam@sched${stamp}.invalid`, ws])).rows[0];
  const campaign = (await db.query(`INSERT INTO campaigns (name, subject, body, workspace_id, status) VALUES ('Sched campaign', 'Quick question', 'Hi', $1, 'Active') RETURNING *`, [ws])).rows[0];
  await settings.updateBrain(ws, { companyName: "Acme", senderFirstName: "Yuri", senderTitle: "Owner" });
  await settings.updateSettings(ws, { bookingLink: "https://cal.example.com/fallback", knowledgeBase: "Acme staffs Maryland restaurants." });
  const all = { mon: [["08:00", "20:00"]], tue: [["08:00", "20:00"]], wed: [["08:00", "20:00"]], thu: [["08:00", "20:00"]], fri: [["08:00", "20:00"]], sat: [["08:00", "20:00"]], sun: [["08:00", "20:00"]] };
  await scheduling.saveAvailability(ws, user, { timezone: "America/New_York", weekly: all, bufferBeforeMin: 15, bufferAfterMin: 15 });
  return { ws, user, mailbox, campaign };
}

async function lead(ctx, key, name) {
  const email = `${key}${stamp}@prospect.invalid`;
  const row = (await db.query(`INSERT INTO campaign_leads (campaign_id, email, full_name, first_name, company, status, mailbox_id, workspace_id, sent_at) VALUES ($1,$2,$3,$4,'Acme','Sent',$5,$6,NOW()) RETURNING *`, [ctx.campaign.id, email, name, name.split(" ")[0], ctx.mailbox.id, ctx.ws])).rows[0];
  const threadId = `${ctx.mailbox.id}:${email}`;
  await db.query(`INSERT INTO messages (mailbox_id, direction, campaign_id, campaign_lead_id, thread_id, from_address, to_address, subject, body_text, workspace_id, created_at) VALUES ($1,'outbound',$2,$3,$4,$5,$6,'Quick question','Hi, quick question.',$7, NOW() - INTERVAL '3 days')`, [ctx.mailbox.id, ctx.campaign.id, row.id, threadId, ctx.mailbox.email, email, ctx.ws]);
  return { email, threadId, row };
}

/** Records an inbound reply and runs the SDR reply path directly (the hook runs the same two calls). */
async function inboundReply(ctx, p, text, subject = "Re: Quick question") {
  const msg = (await db.query(`INSERT INTO messages (mailbox_id, direction, campaign_id, campaign_lead_id, thread_id, from_address, to_address, subject, body_text, workspace_id) VALUES ($1,'inbound',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [ctx.mailbox.id, ctx.campaign.id, p.row.id, p.threadId, p.email, ctx.mailbox.email, subject, text, ctx.ws])).rows[0];
  const { classification } = await sdr.classify({ workspaceId: ctx.ws, mailboxId: ctx.mailbox.id, threadId: p.threadId, inboundMessageId: msg.id, subject, body: text, lead: p.row, fromAddress: p.email });
  const campaign = (await db.query(`SELECT * FROM campaigns WHERE id = $1`, [ctx.campaign.id])).rows[0];
  const result = await sdr.reply({ workspaceId: ctx.ws, mailbox: ctx.mailbox, lead: p.row, campaign, inbound: msg, classification });
  return { result, msg };
}

const bodyOf = async (ctx, p) => (await db.query(`SELECT body_text FROM messages WHERE workspace_id=$1 AND thread_id=$2 AND direction='outbound' AND author='ai' ORDER BY id DESC LIMIT 1`, [ctx.ws, p.threadId])).rows[0]?.body_text;

(async () => {
  const ctx = await seed();

  console.log("\n[1] availability validation and time zones");
  await check("defaults before anything is saved", async () => { const a = await scheduling.getAvailability(ctx.ws, 999999); assert.equal(a.timezone, "UTC"); assert.equal(a.saved, false); assert.deepEqual(a.weekly.sat, []); });
  await check("invalid time zone rejected", () => assert.rejects(() => scheduling.saveAvailability(ctx.ws, ctx.user, { timezone: "Mars/Olympus", weekly: scheduling.DEFAULT_WEEKLY }), /time zone/i));
  await check("range that ends before it starts rejected", () => assert.rejects(() => scheduling.saveAvailability(ctx.ws, ctx.user, { timezone: "UTC", weekly: { ...scheduling.DEFAULT_WEEKLY, mon: [["17:00", "09:00"]] } }), /end after/i));
  await check("malformed time rejected", () => assert.rejects(() => scheduling.saveAvailability(ctx.ws, ctx.user, { timezone: "UTC", weekly: { ...scheduling.DEFAULT_WEEKLY, mon: [["9am", "5pm"]] } }), /09:00/));
  await check("a schedule with no hours at all rejected", () => assert.rejects(() => scheduling.saveAvailability(ctx.ws, ctx.user, { timezone: "UTC", weekly: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] } }), /At least one/));
  await check("buffer out of range rejected", () => assert.rejects(() => scheduling.saveAvailability(ctx.ws, ctx.user, { timezone: "UTC", weekly: scheduling.DEFAULT_WEEKLY, bufferBeforeMin: 500 }), /Buffers/));
  const ny = { timezone: "America/New_York", weekly: scheduling.DEFAULT_WEEKLY };
  await check("window starts at 09:00 New York time after daylight saving ENDS (EST = UTC-5)", () => { const w = scheduling.buildWindows(ny, new Date(Date.UTC(2026, 10, 1, 12, 0))); assert.equal(w[0].start, Date.UTC(2026, 10, 2, 14, 0)); });
  await check("window starts at 09:00 New York time after daylight saving STARTS (EDT = UTC-4)", () => { const w = scheduling.buildWindows(ny, new Date(Date.UTC(2026, 2, 7, 12, 0))); assert.equal(w[0].start, Date.UTC(2026, 2, 9, 13, 0)); });
  await check("a time zone half an hour off UTC (Kolkata) is honoured", () => { const w = scheduling.buildWindows({ timezone: "Asia/Kolkata", weekly: scheduling.DEFAULT_WEEKLY }, new Date(Date.UTC(2026, 5, 1, 0, 0))); assert.equal(w[0].start, Date.UTC(2026, 5, 1, 3, 30)); });
  await check("never offers a time starting within two hours", () => { const now = new Date(); const w = scheduling.buildWindows({ timezone: "UTC", weekly: { ...scheduling.DEFAULT_WEEKLY, sat: [["00:00", "23:59"]], sun: [["00:00", "23:59"]], mon: [["00:00", "23:59"]], tue: [["00:00", "23:59"]], wed: [["00:00", "23:59"]], thu: [["00:00", "23:59"]], fri: [["00:00", "23:59"]] } }, now); assert.ok(w[0].start >= now.getTime() + 2 * HOUR - 1000); });

  console.log("\n[2] finding, offering and matching slots");
  const handler = await scheduling.resolveHandler(ctx.ws, null);
  const type30 = await scheduling.pickMeetingType(ctx.ws);
  await check("handler resolved from the connected calendar", () => { assert.equal(handler.userId, ctx.user); assert.equal(handler.availability.timezone, "America/New_York"); });
  await check("no handler when nobody has a calendar (falls back to a link)", async () => assert.equal(await scheduling.resolveHandler(ctx.ws, 999999), null));
  await check("three slots, on the half-hour grid, distinct, in the future, inside working hours", async () => {
    busy = [];
    const slots = await scheduling.findSlots(handler, 30);
    assert.equal(slots.length, 3);
    for (const s of slots) { const start = new Date(s.startTime); assert.equal(start.getUTCMinutes() % 30, 0); assert.ok(start.getTime() > Date.now() + 2 * HOUR - 1000); const hourNY = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(start)); assert.ok(hourNY >= 8 && hourNY < 20, `hour ${hourNY}`); }
    assert.equal(new Set(slots.map((s) => s.startTime)).size, 3);
  });
  await check("busy time and its buffers are respected", async () => {
    const first = (await scheduling.findSlots(handler, 30))[0];
    const start = new Date(first.startTime).getTime();
    busy = [{ start, end: start + 30 * 60000 }];
    const slots = await scheduling.findSlots(handler, 30, { count: 6 });
    for (const s of slots) { const a = new Date(s.startTime).getTime(), b = new Date(s.endTime).getTime(); assert.ok(b + 15 * 60000 <= start || a >= start + 30 * 60000 + 15 * 60000, `slot ${s.startTime} too close to the busy block`); }
    busy = [];
  });
  const p1 = await lead(ctx, "pick", "Pat Picker");
  let offer;
  await check("an offer is stored and earlier slots are not offered again", async () => {
    offer = await scheduling.offerSlots({ workspaceId: ctx.ws, mailboxId: ctx.mailbox.id, threadId: p1.threadId, handler, meetingType: type30 });
    const second = await scheduling.offerSlots({ workspaceId: ctx.ws, mailboxId: ctx.mailbox.id, threadId: p1.threadId, handler, meetingType: type30 });
    const first = new Set(offer.slots.map((s) => s.startTime));
    assert.ok(second.slots.every((s) => !first.has(s.startTime)), "repeated a slot");
    const active = await scheduling.activeOffer(ctx.ws, ctx.mailbox.id, p1.threadId);
    assert.equal(active.id, second.id); assert.match(active.slots[0].label, /^\w+, \w+ \d+ at \d+:\d\d (AM|PM) E[SD]T$/);
  });
  const o = await scheduling.activeOffer(ctx.ws, ctx.mailbox.id, p1.threadId);
  await check("rules read 'the second one', 'none of these' and an ambiguous 'sounds good'", () => {
    assert.equal(scheduling.detectSelection("The second one works for me.", o).selected, 2);
    const none = scheduling.detectSelection("None of these work, sorry.", o); assert.equal(none.decided, true); assert.equal(none.selected, null);
    assert.equal(scheduling.detectSelection("Sounds good!", o).decided, false);
  });

  console.log("\n[3] booking");
  const bookLead = { email: p1.email, name: "Pat Picker" };
  let booked;
  await check("books on the calendar: title has the prospect's name, prospect is an attendee, video link kept", async () => {
    const slot = o.slots[0];
    booked = await scheduling.book({ workspaceId: ctx.ws, mailboxId: ctx.mailbox.id, threadId: p1.threadId, offer: o, slot, handler, meetingType: type30, lead: bookLead });
    assert.equal(booked.success, true); assert.equal(events.length, 1);
    assert.equal(events[0].summary, "Intro Call - Pat Picker"); assert.deepEqual(events[0].attendees, [{ email: p1.email, displayName: "Pat Picker" }]);
    assert.equal(booked.meetLink, "https://meet.example.com/abc-defg");
    assert.equal((await db.query(`SELECT status FROM sdr_slot_offers WHERE id = $1`, [o.id])).rows[0].status, "accepted");
  });
  await check("booking the same slot twice does not create a second event", async () => { const again = await scheduling.book({ workspaceId: ctx.ws, mailboxId: ctx.mailbox.id, threadId: p1.threadId, offer: o, slot: o.slots[0], handler, meetingType: type30, lead: bookLead }); assert.equal(again.success, true); assert.equal(again.repeated, true); assert.equal(events.length, 1); });
  await check("a slot that was taken in the meantime is refused", async () => { const slot = o.slots[1]; busy = [{ start: new Date(slot.startTime).getTime(), end: new Date(slot.endTime).getTime() }]; const r = await scheduling.book({ workspaceId: ctx.ws, mailboxId: ctx.mailbox.id, threadId: p1.threadId, offer: o, slot, handler, meetingType: type30, lead: bookLead }); busy = []; assert.equal(r.success, false); assert.equal(r.reason, "taken"); assert.equal(events.length, 1); });
  await check("a calendar failure is reported, not thrown", async () => { const original = scheduling.provider.createEvent; scheduling.provider.createEvent = async () => { throw new Error("Google is down"); }; const r = await scheduling.book({ workspaceId: ctx.ws, mailboxId: ctx.mailbox.id, threadId: p1.threadId, offer: o, slot: o.slots[2], handler, meetingType: type30, lead: bookLead }); scheduling.provider.createEvent = original; assert.equal(r.success, false); assert.equal(r.reason, "error"); });

  console.log("\n[4] the reply flow: offer times, read the pick, book, confirm");
  const A = await lead(ctx, "flowa", "Alex Flow");
  nextGenerate = (context) => reply({ reply: "Hi Alex,\nHappy to find a time.\nSam Seller\nOwner | Acme" });
  await check("an interested reply gets real times offered (the model is told them, and they are in the email)", async () => {
    modelCalls.length = 0; sent.length = 0;
    const { result } = await inboundReply(ctx, A, "Yes, interested! Can we talk this week?");
    assert.equal(result.status, "Sent");
    assert.equal(modelCalls[0].offeredSlots.length, 3, "model was not given the slots");
    const body = sent[0]; for (const label of modelCalls[0].offeredSlots) assert.ok(body.includes(label), `email is missing ${label}`);
    assert.match(body, /Times that work:/); assert.ok(body.indexOf("Times that work") < body.indexOf("Sam Seller"), "times must come before the sign-off");
    assert.ok(await scheduling.activeOffer(ctx.ws, ctx.mailbox.id, A.threadId));
  });
  await check("the pick is recognised and booked WITHOUT asking the model; confirmation has time and video link", async () => {
    modelCalls.length = 0; sent.length = 0; const before = events.length;
    const { result } = await inboundReply(ctx, A, "The second one works for me, thanks!");
    assert.equal(result.status, "Booked"); assert.equal(modelCalls.length, 0, "the model should not be needed for a clear pick");
    assert.equal(events.length, before + 1); assert.match(sent[0], /you're booked for \w+, \w+ \d+ at/); assert.ok(sent[0].includes("https://meet.example.com/abc-defg"));
    const st = await threadState.getState(ctx.ws, ctx.mailbox.id, A.threadId); assert.equal(st.outcome, "meeting_booked"); assert.equal(st.interest, "very_high");
  });
  const B = await lead(ctx, "flowb", "Bea Retry");
  await inboundReply(ctx, B, "Sure, let's talk.");
  await check("'none of these work' gets NEW times, never the same ones", async () => {
    const before = await scheduling.activeOffer(ctx.ws, ctx.mailbox.id, B.threadId); modelCalls.length = 0;
    const { result } = await inboundReply(ctx, B, "None of these work for me, sorry.");
    assert.equal(result.status, "Sent"); const after = await scheduling.activeOffer(ctx.ws, ctx.mailbox.id, B.threadId);
    assert.notEqual(after.id, before.id); assert.ok(after.slots.every((s) => !before.slots.some((b) => b.startTime === s.startTime)));
    assert.match(modelCalls[0].situation, /none of the offered times/i);
  });
  await check("a pick that was taken meanwhile: apologise and offer new times", async () => {
    const offerNow = await scheduling.activeOffer(ctx.ws, ctx.mailbox.id, B.threadId); const target = offerNow.slots[0];
    busy = [{ start: new Date(target.startTime).getTime(), end: new Date(target.endTime).getTime() }]; modelCalls.length = 0;
    const { result } = await inboundReply(ctx, B, "The first one please.");
    busy = []; assert.equal(result.status, "Sent"); assert.match(modelCalls[0].situation, /just been taken/i);
    assert.ok(modelCalls[0].offeredSlots.length > 0 && !modelCalls[0].offeredSlots.includes(target.label));
  });
  await check("an ambiguous answer asks which time they prefer (and repeats the same times)", async () => {
    const offerNow = await scheduling.activeOffer(ctx.ws, ctx.mailbox.id, B.threadId); modelCalls.length = 0;
    await inboundReply(ctx, B, "Sounds good!");
    assert.match(modelCalls[0].situation, /did not clearly choose/i); assert.deepEqual(modelCalls[0].offeredSlots, offerNow.slots.map((s) => s.label));
  });
  const C = await lead(ctx, "approve", "Cal Approve");
  await inboundReply(ctx, C, "Yes, let's set up a call.");
  await settings.updateSettings(ctx.ws, { requireApproval: true });
  await check("approval mode: the pick becomes a draft carrying the booking; NOTHING is booked or sent yet", async () => {
    const before = { events: events.length, sent: sent.length };
    const { result } = await inboundReply(ctx, C, "The third one works.");
    assert.equal(result.status, "Drafted"); assert.equal(events.length, before.events); assert.equal(sent.length, before.sent);
    const d = (await db.query(`SELECT * FROM sdr_drafts WHERE workspace_id=$1 AND thread_id=$2 AND status='pending'`, [ctx.ws, C.threadId])).rows[0];
    assert.ok(d.booking && d.booking.slot.startTime);
  });
  await check("approving that draft makes the booking, adds the video link and sends", async () => {
    const d = (await db.query(`SELECT * FROM sdr_drafts WHERE workspace_id=$1 AND thread_id=$2 AND status='pending'`, [ctx.ws, C.threadId])).rows[0];
    const before = { events: events.length, sent: sent.length }; let out = null;
    await controller.sendDraft({ workspaceId: ctx.ws, user: { id: ctx.user }, params: { mailboxId: String(ctx.mailbox.id), threadId: C.threadId, draftId: String(d.id) }, body: {} }, { status: () => ({ json: (j) => { out = j; } }) });
    assert.equal(out.success, true, JSON.stringify(out)); assert.equal(events.length, before.events + 1); assert.equal(sent.length, before.sent + 1); assert.ok(sent.at(-1).includes("https://meet.example.com/abc-defg"));
    assert.equal((await threadState.getState(ctx.ws, ctx.mailbox.id, C.threadId)).outcome, "meeting_booked");
  });
  await settings.updateSettings(ctx.ws, { requireApproval: false });
  await check("approving a booking draft whose time was taken is refused with a clear message", async () => {
    const D = await lead(ctx, "stale", "Dee Stale"); await inboundReply(ctx, D, "Yes please, call me.");
    await settings.updateSettings(ctx.ws, { requireApproval: true });
    await inboundReply(ctx, D, "The first one.");
    const d = (await db.query(`SELECT * FROM sdr_drafts WHERE workspace_id=$1 AND thread_id=$2 AND status='pending'`, [ctx.ws, D.threadId])).rows[0];
    busy = [{ start: new Date(d.booking.slot.startTime).getTime(), end: new Date(d.booking.slot.endTime).getTime() }]; let out = null;
    await controller.sendDraft({ workspaceId: ctx.ws, user: { id: ctx.user }, params: { mailboxId: String(ctx.mailbox.id), threadId: D.threadId, draftId: String(d.id) }, body: {} }, { status: () => ({ json: (j) => { out = j; } }) });
    busy = []; await settings.updateSettings(ctx.ws, { requireApproval: false });
    assert.equal(out.success, false); assert.match(out.message, /no longer free/);
  });
  await check("no connected calendar: falls back to the booking link (no slots offered)", async () => {
    await db.query(`UPDATE calendar_connections SET status = 'revoked' WHERE workspace_id = $1`, [ctx.ws]);
    const E = await lead(ctx, "nocal", "Nia NoCal"); modelCalls.length = 0;
    const { result } = await inboundReply(ctx, E, "Interested, can we talk?");
    await db.query(`UPDATE calendar_connections SET status = 'connected' WHERE workspace_id = $1`, [ctx.ws]);
    assert.equal(result.status, "Sent"); assert.equal(modelCalls[0].offeredSlots.length, 0); assert.equal(modelCalls[0].bookingLink, "https://cal.example.com/fallback");
  });

  console.log("\n[5] scheduled follow-ups");
  const F = await lead(ctx, "follow", "Fay Follow");
  nextGenerate = () => reply({ intent: "question", interest: "medium", wantsMeeting: false, reply: "Hi Fay,\nHappy to help.\nSam Seller\nOwner | Acme" });
  await check("after an AI reply the next follow-up is queued two days out; a prospect reply cancels it", async () => {
    await inboundReply(ctx, F, "What areas do you cover?");
    let st = await threadState.getState(ctx.ws, ctx.mailbox.id, F.threadId);
    const days = (new Date(st.follow_up_at).getTime() - Date.now()) / 86400000;
    assert.ok(days > 1.9 && days < 2.1, `follow-up in ${days} days`); assert.equal(st.followup_by, "auto");
    await inboundReply(ctx, F, "Thanks, one more thing: do you cover DC too?");
    st = await threadState.getState(ctx.ws, ctx.mailbox.id, F.threadId);
    assert.ok(st.follow_up_at, "a fresh reply from the SDR queues a new follow-up"); // the reply path re-queues after answering
  });
  const G = await lead(ctx, "due", "Gus Due");
  await db.query(`UPDATE sdr_settings SET followup_delay_days = 1, followup_max = 2 WHERE workspace_id = $1`, [ctx.ws]);
  nextGenerate = (context) => context.mode === "followup" ? reply({ intent: "other", interest: "low", wantsMeeting: false, reply: `Hi Gus, just checking in (${context.followup.number} of ${context.followup.max}).\nSam Seller\nOwner | Acme` }) : reply({ wantsMeeting: false, intent: "question" });
  // Other suites can leave due follow-ups in the shared sandbox DB; runTick works through every workspace, so park those first.
  const makeDue = async (p) => { await db.query(`UPDATE sdr_thread_state SET follow_up_at = NULL WHERE workspace_id <> $1 AND follow_up_at IS NOT NULL AND follow_up_at <= NOW()`, [ctx.ws]); return db.query(`UPDATE sdr_thread_state SET follow_up_at = NOW() - INTERVAL '1 minute' WHERE workspace_id=$1 AND mailbox_id=$2 AND thread_id=$3`, [ctx.ws, ctx.mailbox.id, p.threadId]); };
  await inboundReply(ctx, G, "Maybe. Tell me more about pricing?");
  await check("a due follow-up is written by the SDR and sent; the next one is queued", async () => {
    await makeDue(G); sent.length = 0; modelCalls.length = 0;
    const r = await followups.runTick(); assert.ok(r.processed >= 1);
    assert.equal(sent.length, 1); assert.match(sent[0], /1 of 2/); assert.equal(modelCalls.at(-1).mode, "followup"); assert.equal(modelCalls.at(-1).latest, null);
    const st = await threadState.getState(ctx.ws, ctx.mailbox.id, G.threadId); assert.equal(st.followup_count, 1); assert.ok(st.follow_up_at, "second follow-up queued");
  });
  await check("the second follow-up goes out and then they STOP (limit of two)", async () => {
    await makeDue(G); sent.length = 0; await followups.runTick(); assert.equal(sent.length, 1); assert.match(sent[0], /2 of 2/);
    const st = await threadState.getState(ctx.ws, ctx.mailbox.id, G.threadId); assert.equal(st.followup_count, 2); assert.equal(st.follow_up_at, null);
  });
  await check("a prospect who replied since is skipped (nothing sent)", async () => {
    const H = await lead(ctx, "answered", "Hal Answered"); await inboundReply(ctx, H, "Tell me more?"); await db.query(`INSERT INTO messages (mailbox_id, direction, thread_id, from_address, to_address, subject, body_text, workspace_id) VALUES ($1,'inbound',$2,'h','m','Re: x','Actually yes!',$3)`, [ctx.mailbox.id, H.threadId, ctx.ws]);
    await makeDue(H); sent.length = 0; await followups.runTick(); assert.equal(sent.length, 0);
  });
  await check("suppressed, declined and booked threads are never followed up", async () => {
    const I = await lead(ctx, "closed", "Ian Closed"); await inboundReply(ctx, I, "Tell me more?"); await threadState.patch(ctx.ws, ctx.mailbox.id, I.threadId, { outcome: "declined" }, { by: "manual" }); await makeDue(I);
    const J = await lead(ctx, "supp", "Jo Suppressed"); await inboundReply(ctx, J, "Tell me more?"); await db.query(`INSERT INTO suppressions (email, reason, source, workspace_id) VALUES ($1, 'unsubscribed', 'manual', $2)`, [J.email, ctx.ws]); await makeDue(J);
    sent.length = 0; await followups.runTick(); assert.equal(sent.length, 0);
  });
  await check("SDR off for the thread, or the model unavailable: a CRM task for a person instead of an email", async () => {
    const K = await lead(ctx, "off", "Kit Off"); await inboundReply(ctx, K, "Tell me more?"); await threadState.patch(ctx.ws, ctx.mailbox.id, K.threadId, { aiDisabled: true }); await makeDue(K);
    const L = await lead(ctx, "noai", "Lou NoAI"); await inboundReply(ctx, L, "Tell me more?"); await makeDue(L);
    const saved = nextGenerate; nextGenerate = null; sent.length = 0; await followups.runTick(); nextGenerate = saved;
    assert.equal(sent.length, 0);
    const tasks = (await db.query(`SELECT title FROM crm_tasks WHERE workspace_id=$1 AND title LIKE 'Follow up with%' AND status='open'`, [ctx.ws])).rows.map((r) => r.title);
    assert.ok(tasks.some((t) => /Kit Off/.test(t)) && tasks.some((t) => /Lou NoAI/.test(t)), JSON.stringify(tasks));
  });
  await check("two ticks at once send ONE follow-up, not two", async () => {
    const M = await lead(ctx, "race", "Max Race"); await inboundReply(ctx, M, "Tell me more?"); await makeDue(M); sent.length = 0;
    await Promise.all([followups.runTick(), followups.runTick()]); assert.equal(sent.filter((b) => /checking in/.test(b)).length, 1);
  });
  await check("approval mode: the follow-up waits as a draft", async () => {
    const N = await lead(ctx, "appr", "Nan Approval"); await inboundReply(ctx, N, "Tell me more?"); await settings.updateSettings(ctx.ws, { requireApproval: true }); await makeDue(N); sent.length = 0; await followups.runTick(); await settings.updateSettings(ctx.ws, { requireApproval: false });
    assert.equal(sent.length, 0); assert.equal((await db.query(`SELECT COUNT(*)::int c FROM sdr_drafts WHERE workspace_id=$1 AND thread_id=$2 AND status='pending'`, [ctx.ws, N.threadId])).rows[0].c, 1);
  });
  await check("a person can schedule a follow-up; past dates and far-future dates are refused", async () => {
    const P = await lead(ctx, "manual", "Pam Manual"); await inboundReply(ctx, P, "Tell me more?");
    const call = async (followUpAt) => { let out; await controller.patchThread({ workspaceId: ctx.ws, user: { id: ctx.user }, params: { mailboxId: String(ctx.mailbox.id), threadId: P.threadId }, body: { followUpAt } }, { status: () => ({ json: (j) => { out = j; } }) }); return out; };
    assert.equal((await call(new Date(Date.now() + 3 * 86400000).toISOString())).success, true);
    assert.equal((await threadState.getState(ctx.ws, ctx.mailbox.id, P.threadId)).followup_by, "manual");
    assert.match((await call(new Date(Date.now() - 86400000).toISOString())).message, /future/);
    assert.match((await call(new Date(Date.now() + 200 * 86400000).toISOString())).message, /three months/);
    assert.equal((await call(null)).success, true); assert.equal((await threadState.getState(ctx.ws, ctx.mailbox.id, P.threadId)).follow_up_at, null);
  });
  await check("follow-up settings are validated", async () => { await assert.rejects(() => settings.updateSettings(ctx.ws, { followupDelayDays: 0 }), /1 and 30/); await assert.rejects(() => settings.updateSettings(ctx.ws, { followupMax: 9 }), /0 and 5/); });

  console.log("\n[6] Forward");
  const Q = await lead(ctx, "fwd", "Quin Forward");
  const { msg: fwdMsg } = await inboundReply(ctx, Q, "Can your team cover a wedding on Saturday?");
  const fwd = (to, note) => forward.forward({ workspaceId: ctx.ws, userId: ctx.user, mailboxId: ctx.mailbox.id, threadId: Q.threadId, messageId: fwdMsg.id, to, note });
  await check("forwards with a Fwd: subject, the note and the original headers, and audits it", async () => {
    forwarded.length = 0; const r = await fwd("colleague@example.com", "Can you take this one?");
    assert.equal(r.forwarded, true); assert.equal(forwarded.length, 1); assert.equal(forwarded[0].to, "colleague@example.com");
    const raw = forwarded[0].raw; assert.match(raw, /Subject: Fwd: Re: Quick question/); assert.ok(raw.includes("Can you take this one?")); assert.ok(raw.includes("Forwarded message")); assert.ok(raw.includes("Can your team cover a wedding"));
    assert.equal((await db.query(`SELECT COUNT(*)::int c FROM sdr_forwards WHERE workspace_id=$1`, [ctx.ws])).rows[0].c, 1);
  });
  await check("the forward is not added to the prospect's thread", async () => { assert.equal((await db.query(`SELECT COUNT(*)::int c FROM messages WHERE workspace_id=$1 AND to_address='colleague@example.com'`, [ctx.ws])).rows[0].c, 0); });
  await check("rejects bad addresses, multiple addresses and header injection", async () => { for (const bad of ["not-an-email", "a@b.com, c@d.com", "x@y.com\nBcc: z@z.com", "", "a@b"]) await assert.rejects(() => fwd(bad, ""), /valid email/i, bad); });
  await check("cannot forward a message from another thread or workspace", async () => { await assert.rejects(() => forward.forward({ workspaceId: ctx.ws, userId: ctx.user, mailboxId: ctx.mailbox.id, threadId: "9:other@x.invalid", messageId: fwdMsg.id, to: "a@b.com" }), /not found/i); await assert.rejects(() => forward.forward({ workspaceId: 999999, userId: ctx.user, mailboxId: ctx.mailbox.id, threadId: Q.threadId, messageId: fwdMsg.id, to: "a@b.com" }), /not found/i); });
  await check("a failed send is not recorded as forwarded", async () => { const orig = mailTransport.sendRawEmail; mailTransport.sendRawEmail = async () => { throw new Error("smtp down"); }; const before = (await db.query(`SELECT COUNT(*)::int c FROM sdr_forwards WHERE workspace_id=$1`, [ctx.ws])).rows[0].c; await assert.rejects(() => fwd("colleague@example.com", ""), /smtp down/); mailTransport.sendRawEmail = orig; assert.equal((await db.query(`SELECT COUNT(*)::int c FROM sdr_forwards WHERE workspace_id=$1`, [ctx.ws])).rows[0].c, before); });
  await check("rate limit: more than twenty an hour is refused", async () => { await db.query(`INSERT INTO sdr_forwards (workspace_id, message_id, to_address) SELECT $1, $2, 'bulk@example.com' FROM generate_series(1, 25)`, [ctx.ws, fwdMsg.id]); await assert.rejects(() => fwd("colleague@example.com", ""), /lot of messages/); });

  console.log("\n[7] per-campaign overrides");
  const c2 = (await db.query(`INSERT INTO campaigns (name, subject, body, workspace_id, status) VALUES ('Podcast campaign', 's', 'b', $1, 'Active') RETURNING *`, [ctx.ws])).rows[0];
  const other = (await db.query(`INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id`, [`Other ${stamp}`, `other-${stamp}`])).rows[0].id;
  const otherCampaign = (await db.query(`INSERT INTO campaigns (name, subject, body, workspace_id) VALUES ('Theirs', 's', 'b', $1) RETURNING id`, [other])).rows[0].id;
  await check("listing shows campaigns without overrides as inheriting", async () => { const list = await settings.listOverrides(ctx.ws); const row = list.find((i) => i.campaignId === c2.id); assert.equal(row.hasOverride, false); assert.equal(row.enabled, null); });
  await check("saving, listing and clearing an override", async () => {
    const mt = (await settings.createMeetingType(ctx.ws, { name: `Podcast ${stamp}`, durationMinutes: 45, campaignType: "Podcast" }));
    const saved = await settings.saveOverride(ctx.ws, c2.id, { enabled: true, requireApproval: true, meetingTypeId: mt.id, bookingLink: "https://cal.example.com/podcast", notes: "This is a podcast invite; the call is a 15 minute intro chat." });
    assert.equal(saved.requireApproval, true); assert.equal(saved.hasOverride, true);
    const all = await settings.loadForPrompt(ctx.ws, c2.id);
    assert.deepEqual({ ...all.effective }, { enabled: true, requireApproval: true, bookingLink: "https://cal.example.com/podcast", meetingTypeId: mt.id, notes: "This is a podcast invite; the call is a 15 minute intro chat." });
    const plain = await settings.loadForPrompt(ctx.ws, ctx.campaign.id); assert.equal(plain.effective.bookingLink, "https://cal.example.com/fallback"); assert.equal(plain.effective.notes, "");
  });
  await check("override validation: bad link, other workspace's campaign, other workspace's meeting type", async () => {
    await assert.rejects(() => settings.saveOverride(ctx.ws, c2.id, { bookingLink: "javascript:alert(1)" }), /http/);
    await assert.rejects(() => settings.saveOverride(ctx.ws, otherCampaign, {}), /not found/i);
    await assert.rejects(() => settings.saveOverride(ctx.ws, c2.id, { meetingTypeId: 987654 }), /does not exist/);
  });
  await check("the campaign's notes reach the prompt, and its approval setting is honoured", async () => {
    const prompt = agent.buildSystemPrompt({ brain: {}, knowledgeBase: "", rules: [], meetingTypes: [], resources: [], bookingLink: "", mailbox: {}, campaign: c2, campaignNotes: "This is a podcast invite." });
    assert.match(prompt, /CAMPAIGN-SPECIFIC NOTES[\s\S]*This is a podcast invite\./);
    const pc = await lead({ ...ctx, campaign: c2 }, "pod", "Pod Person"); const camp = (await db.query(`SELECT * FROM campaigns WHERE id=$1`, [c2.id])).rows[0];
    const msg = (await db.query(`INSERT INTO messages (mailbox_id, direction, campaign_id, campaign_lead_id, thread_id, from_address, to_address, subject, body_text, workspace_id) VALUES ($1,'inbound',$2,$3,$4,$5,$6,'Re: x','Tell me more please?',$7) RETURNING *`, [ctx.mailbox.id, c2.id, pc.row.id, pc.threadId, pc.email, ctx.mailbox.email, ctx.ws])).rows[0];
    nextGenerate = reply({ wantsMeeting: false, intent: "question", reply: "Hi,\nSure.\nSam Seller" }); modelCalls.length = 0; sent.length = 0;
    const r = await sdr.reply({ workspaceId: ctx.ws, mailbox: ctx.mailbox, lead: pc.row, campaign: camp, inbound: msg, classification: classifier.classify({ subject: "", body: "Tell me more please?" }) });
    assert.equal(r.status, "Drafted", JSON.stringify(r)); assert.equal(sent.length, 0); assert.equal(modelCalls[0].campaignNotes, "This is a podcast invite; the call is a 15 minute intro chat.");
  });
  await check("a campaign can switch the SDR off even when the workspace has it on", async () => {
    await settings.saveOverride(ctx.ws, c2.id, { enabled: false }); const camp = (await db.query(`SELECT * FROM campaigns WHERE id=$1`, [c2.id])).rows[0];
    const p = await lead({ ...ctx, campaign: c2 }, "off2", "Off Two"); const msg = (await db.query(`INSERT INTO messages (mailbox_id, direction, campaign_id, campaign_lead_id, thread_id, from_address, to_address, subject, body_text, workspace_id) VALUES ($1,'inbound',$2,$3,$4,$5,$6,'Re: x','Interested!',$7) RETURNING *`, [ctx.mailbox.id, c2.id, p.row.id, p.threadId, p.email, ctx.mailbox.email, ctx.ws])).rows[0];
    const r = await sdr.reply({ workspaceId: ctx.ws, mailbox: ctx.mailbox, lead: p.row, campaign: camp, inbound: msg, classification: classifier.classify({ subject: "", body: "Interested!" }) });
    assert.equal(r.reason, "sdr_paused");
  });
  await check("clearing an override returns the campaign to inheriting", async () => { await settings.clearOverride(ctx.ws, c2.id); const row = (await settings.listOverrides(ctx.ws)).find((i) => i.campaignId === c2.id); assert.equal(row.hasOverride, false); });

  console.log("\n[8] calendar connection bookkeeping");
  const googleCalendar = require(`${BE}/services/googleCalendar.service`);
  await check("status reflects the connection; revoked is still reported so the UI can ask to reconnect", async () => { const s1 = await googleCalendar.getUserConnectionStatus(ctx.ws, ctx.user); assert.equal(s1.status, "connected"); await db.query(`UPDATE calendar_connections SET status='revoked' WHERE workspace_id=$1`, [ctx.ws]); assert.equal((await googleCalendar.getUserConnectionStatus(ctx.ws, ctx.user)).status, "revoked"); assert.equal(await googleCalendar.getConnectedForUser(ctx.ws, ctx.user), null); await db.query(`UPDATE calendar_connections SET status='connected' WHERE workspace_id=$1`, [ctx.ws]); });
  await check("no Google credentials in the sandbox: the connect URL refuses cleanly", () => assert.rejects(() => googleCalendar.getUserAuthUrl(ctx.ws, ctx.user), /GOOGLE_CALENDAR/));
  await check("a person can only disconnect their own calendar", async () => { assert.equal((await googleCalendar.disconnectForUser(ctx.ws, 999999)).disconnected, false); });

  agent.generate = originalGenerate;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
