// Verifies that assigning domains to a client enrols never-warmed own-server mailboxes in the warm-up network with
// priority, that the engine serves them first, and that they are released to the client automatically once ready.
// LOCAL sandbox only; the sender is stubbed, nothing is sent.   ./dev-local.sh node scripts/assign-warmup-test.js
const BE = require("path").resolve(__dirname, "..");
const assert = require("assert");
const mailTransport = require(`${BE}/services/mailTransport.service`);
mailTransport.sendRawEmail = async () => "id";
const db = require(`${BE}/config/db.config`);
const engine = require(`${BE}/services/warmnetEngine.service`);
const warmnet = require(`${BE}/services/warmnet.service`);
const adminOrder = require(`${BE}/services/adminOrder.service`);

let pass = 0, fail = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log("  PASS", name); }, (e) => { fail++; console.log("  FAIL", name, "->", e.message); });
const stamp = Date.now();
const created = { ws: [], domains: [], mailboxes: [], seeds: [], users: [] };

(async () => {
  const mkWs = async (tag) => { const id = (await db.query(`INSERT INTO workspaces (name, slug) VALUES ($1,$2) RETURNING id`, [`${tag} ${stamp}`, `${tag.toLowerCase()}-${stamp}`])).rows[0].id; created.ws.push(id); return id; };
  const src = await mkWs("Source"), client = await mkWs("Client"), client2 = await mkWs("Client2");
  const admin = (await db.query(`INSERT INTO users (first_name, last_name, email, password_hash) VALUES ('A','D',$1,'x') RETURNING id`, [`assign-${stamp}@x.invalid`])).rows[0].id; created.users.push(admin);
  const mkDomain = async (name, provider, ws) => { const id = (await db.query(`INSERT INTO domains (domain, registrar, dns_provider, provider, status, spf_status, dkim_status, dmarc_status, mx_status, workspace_id) VALUES ($1,'P','P',$2,'Verified','Success','Success','Success','Success',$3) RETURNING id`, [`${name}-${stamp}.invalid`, provider, ws])).rows[0].id; created.domains.push(id); return id; };
  const mkBox = async (domainId, domain, local, ws, state, opts = {}) => {
    const id = (await db.query(`INSERT INTO mailboxes (domain_id, email, local_part, display_name, status, daily_limit, warmup_stage, provider, workspace_id, market_daily_limit) VALUES ($1,$2,$3,'P','Paused',0,'Paused','postal',$4,0) RETURNING id`, [domainId, `${local}@${domain}-${stamp}.invalid`, local, ws])).rows[0].id;
    created.mailboxes.push(id);
    if (state) await db.query(`INSERT INTO warmnet_mailboxes (mailbox_id, state, started_at, ramp_day, priority_at) VALUES ($1,$2,$3,$4,$5)`, [id, state, opts.started || (state === "queued" ? null : new Date()), opts.ramp || 1, opts.priority || null]);
    return id;
  };
  const seed = (await db.query(`INSERT INTO warmnet_seeds (email, display_name, provider, imap_host, smtp_host, username, password_encrypted, daily_receive_cap) VALUES ($1,'S','gmail','i','s',$1,'x',1000) RETURNING id`, [`seed-${stamp}@x.invalid`])).rows[0].id; created.seeds.push(seed);
  const state = async (id) => (await db.query(`SELECT wm.state, wm.priority_at, wm.started_at, m.status FROM warmnet_mailboxes wm JOIN mailboxes m ON m.id = wm.mailbox_id WHERE wm.mailbox_id = $1`, [id])).rows[0];

  try {
    console.log("enrolment");
    const dPostal = await mkDomain("own", "Postal", client);
    const [fresh, queued, warming, paused, ready] = [
      await mkBox(dPostal, "own", "fresh", client, null),
      await mkBox(dPostal, "own", "queued", client, "queued"),
      await mkBox(dPostal, "own", "warming", client, "warming"),
      await mkBox(dPostal, "own", "paused", client, "paused"),
      await mkBox(dPostal, "own", "ready", client, "ready"),
    ];
    const dMaildoso = await mkDomain("md", "Maildoso", client);
    const md = await mkBox(dMaildoso, "md", "m1", client, null);
    let r;
    await check("result counts", async () => { r = await warmnet.enrollAssigned([dPostal, dMaildoso]); assert.deepEqual(r, { domains: 1, enrolled: 1, started: 1, prioritised: 3, alreadyWarmed: 1, skippedProvider: 1 }); });
    await check("never-warmed mailbox starts warming with priority", async () => { const s = await state(fresh); assert.equal(s.state, "warming"); assert.ok(s.priority_at); assert.ok(s.started_at); });
    await check("queued is started and prioritised; warming gets priority", async () => { assert.equal((await state(queued)).state, "warming"); assert.ok((await state(queued)).priority_at); assert.ok((await state(warming)).priority_at); });
    await check("paused and ready are left alone", async () => { assert.equal((await state(paused)).state, "paused"); assert.equal((await state(paused)).priority_at, null); assert.equal((await state(ready)).state, "ready"); assert.equal((await state(ready)).priority_at, null); });
    await check("Maildoso domain is not enrolled", async () => assert.equal(await state(md), undefined));
    await check("domain gets its warm-up link row", async () => assert.equal((await db.query(`SELECT 1 FROM warmnet_domains WHERE domain_id = $1`, [dPostal])).rowCount, 1));
    await check("running it again changes nothing", async () => { const again = await warmnet.enrollAssigned([dPostal]); assert.equal(again.enrolled, 0); assert.equal(again.started, 0); assert.equal((await state(fresh)).state, "warming"); });

    console.log("engine order");
    const dOrd = await mkDomain("ord", "Postal", src);
    const normal = await mkBox(dOrd, "ord", "normal", src, "warming");       // enrolled earlier, no priority
    const prio = await mkBox(dOrd, "ord", "prio", src, "warming", { priority: new Date() });
    const relNoPrio = await mkBox(dOrd, "ord", "released", src, "released");
    await check("priority mailboxes are served before the rest", async () => {
      const order = [];
      const original = engine.sendInitial;
      engine.sendInitial = async (row) => { order.push(row.mailbox_id); return true; };
      try {
        await engine.sendDue({ ...engine.DEFAULTS, enabled: true }, { hours: 12, weekday: "Tue", date: "2026-11-10" }, { sent: 0, failed: 0, skippedNoSeed: 0, skippedBlocklisted: 0 });
      } finally { engine.sendInitial = original; }
      const mine = order.filter((id) => [normal, prio, relNoPrio, fresh, queued, warming].includes(id));
      const idx = (id) => mine.indexOf(id);
      assert.ok(idx(prio) !== -1 && idx(normal) !== -1, "both were sent");
      assert.ok(idx(prio) < idx(normal), `priority first: ${JSON.stringify(mine)}`);
      assert.ok(idx(fresh) < idx(normal) && idx(queued) < idx(normal) && idx(warming) < idx(normal), "assigned mailboxes before the normal one");
      assert.ok(idx(prio) < idx(relNoPrio), "priority before a released mailbox");
    });

    console.log("automatic release");
    const dRel = await mkDomain("rel", "Postal", client);
    const longAgo = new Date(Date.now() - 9 * 86400000);
    const addMsgs = async (box) => { for (let k = 0; k < 25; k++) await db.query(`INSERT INTO warmnet_messages (mailbox_id, seed_id, direction, kind, thread_key, rfc_message_id, subject, status, placement, sent_at) VALUES ($1,$2,'to_seed','initial',$3,$4,'x','sent',$5, NOW() - INTERVAL '2 days')`, [box, seed, `t${box}${k}`.slice(0, 60), `<${box}-${k}-${stamp}@t>`, k < 23 ? "inbox" : "spam"]); };
    const pr = await mkBox(dRel, "rel", "pr", client, "warming", { started: longAgo, ramp: 9, priority: new Date() });
    const plain = await mkBox(dRel, "rel", "plain", client, "warming", { started: longAgo, ramp: 9 });
    const dRel2 = await mkDomain("rel2", "Postal", client2);
    const pr2 = await mkBox(dRel2, "rel2", "pr2", client2, "warming", { started: longAgo, ramp: 9, priority: new Date() });
    for (const b of [pr, plain, pr2]) await addMsgs(b);
    const summary = { sent: 0, failed: 0, ready: 0, released: 0 };
    await engine.rollOver({ ...engine.DEFAULTS, enabled: true }, { date: "2099-01-01", weekday: "Tue", hours: 9 }, summary);
    await check("a ready priority mailbox is released to its client", async () => { const s = await state(pr); assert.equal(s.state, "released"); assert.equal(s.status, "Active"); });
    await check("a ready normal mailbox still waits for a manual release", async () => { const s = await state(plain); assert.equal(s.state, "ready"); assert.equal(s.status, "Paused"); });
    await check("a client workspace with no strategy gets a default one", async () => { assert.equal((await state(pr2)).state, "released"); const n = (await db.query(`SELECT COUNT(*)::int AS n FROM warmup_strategies WHERE workspace_id = $1 AND is_deleted = FALSE`, [client2])).rows[0].n; assert.equal(n, 1); });
    await check("released mailbox keeps warming at maintenance volume", async () => assert.ok(summary.released >= 2));

    console.log("assign end to end");
    const dFlow = await mkDomain("flow", "Postal", src);
    const f1 = await mkBox(dFlow, "flow", "a", src, null);
    const f2 = await mkBox(dFlow, "flow", "b", src, null);
    const dFlowMd = await mkDomain("flowmd", "Maildoso", src);
    await mkBox(dFlowMd, "flowmd", "c", src, null);
    const flowName = `flow-${stamp}.invalid`, mdName = `flowmd-${stamp}.invalid`;
    await check("preview says how many mailboxes will start warming", async () => { const p = await adminOrder.previewAssignDomains([flowName, mdName], client); assert.deepEqual({ d: p.warmup.willEnroll.domains, m: p.warmup.willEnroll.mailboxes }, { d: 1, m: 2 }); });
    await check("assigning enrols them with priority and says so", async () => {
      const res = await adminOrder.assignDomains(admin, client, { domains: [flowName, mdName] });
      assert.equal(res.warmup.enrollment.enrolled, 2);
      assert.equal(res.warmup.enrollment.skippedProvider, 1);
      for (const id of [f1, f2]) { const s = await state(id); assert.equal(s.state, "warming"); assert.ok(s.priority_at); }
      assert.equal((await db.query(`SELECT workspace_id FROM domains WHERE id = $1`, [dFlow])).rows[0].workspace_id, client);
    });
    await check("returning to the pool enrols nothing", async () => {
      const pool = (await db.query(`SELECT id FROM workspaces WHERE slug = 'koval-group' AND is_deleted = FALSE`)).rows[0];
      if (!pool) return; // sandbox without the platform workspace
      const dBack = await mkDomain("back", "Postal", client);
      const b = await mkBox(dBack, "back", "x", client, null);
      const res = await adminOrder.assignDomains(admin, pool.id, { domains: [`back-${stamp}.invalid`] });
      assert.equal(res.warmup.enrollment, undefined);
      assert.equal(await state(b), undefined);
    });
  } finally {
    const ids = created.mailboxes;
    await db.query(`DELETE FROM warmnet_messages WHERE mailbox_id = ANY($1::int[])`, [ids]);
    await db.query(`DELETE FROM warmnet_seeds WHERE id = ANY($1::int[])`, [created.seeds]);
    await db.query(`DELETE FROM warmnet_mailboxes WHERE mailbox_id = ANY($1::int[])`, [ids]);
    await db.query(`DELETE FROM warmnet_domains WHERE domain_id = ANY($1::int[])`, [created.domains]);
    await db.query(`DELETE FROM workspace_usage_events WHERE workspace_id = ANY($1::int[])`, [created.ws]).catch(() => {});
    await db.query(`DELETE FROM domain_assignments WHERE domain_id = ANY($1::int[])`, [created.domains]).catch(() => {});
    await db.query(`UPDATE mailboxes SET warmup_strategy_id = NULL WHERE id = ANY($1::int[])`, [ids]);
    await db.query(`DELETE FROM warmup_strategies WHERE workspace_id = ANY($1::int[])`, [created.ws]);
    await db.query(`DELETE FROM mailboxes WHERE id = ANY($1::int[])`, [ids]);
    await db.query(`DELETE FROM domains WHERE id = ANY($1::int[])`, [created.domains]);
    await db.query(`DELETE FROM event_logs WHERE app_workspace_id = ANY($1::int[])`, [created.ws]).catch(() => {});
    await db.query(`DELETE FROM workspaces WHERE id = ANY($1::int[])`, [created.ws]).catch((e) => console.log("cleanup:", e.message));
    await db.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [created.users]).catch(() => {});
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
