// Verifies the pre-send address check in the LOCAL sandbox: DNS is stubbed and the transport is stubbed, nothing leaves the machine.
//   ./dev-local.sh node scripts/lead-verify-test.js
const BE = require("path").resolve(__dirname, "..");
const assert = require("assert");
const mailTransport = require(`${BE}/services/mailTransport.service`);
let sent = [];
mailTransport.sendRawEmail = async ({ mailbox, to }) => { sent.push({ from: mailbox.email, to }); return "id"; };
const db = require(`${BE}/config/db.config`);
const verify = require(`${BE}/services/leadVerify.service`);
const campaignSend = require(`${BE}/services/campaignSend.service`);

let pass = 0, fail = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log("  PASS", name); }, (e) => { fail++; console.log("  FAIL", name, "->", e.message); });
const stamp = Date.now();
const err = (code) => Object.assign(new Error(code), { code });

// A tiny fake DNS: domain -> { mx, a, a6 } where each is an array, an error code string, or undefined (= no data).
let zone = {};
let lookups = 0;
const answer = (kind) => async (domain) => {
  lookups++;
  const z = zone[domain];
  if (!z) throw err("ENOTFOUND");
  const v = z[kind];
  if (typeof v === "string") throw err(v);
  if (!v) throw err("ENODATA");
  return v;
};
verify.setResolver({ resolveMx: answer("mx"), resolve4: answer("a"), resolve6: answer("a6") });

(async () => {
  console.log("[1] the check itself");
  process.env.LEAD_VERIFY_DNS = "on";
  zone = {
    "good.example": { mx: [{ exchange: "mx.good.example", priority: 10 }] },
    "implicit.example": { a: ["192.0.2.1"] },
    "nullmx.example": { mx: [{ exchange: ".", priority: 0 }] },
    "empty.example": {},
    "flaky.example": { mx: "ETIMEOUT" },
  };
  await check("a domain with an MX is deliverable", async () => assert.equal((await verify.checkAddress("a@good.example")).deliverable, true));
  await check("no MX but an address record is still deliverable (mail servers fall back to it)", async () => assert.equal((await verify.checkAddress("a@implicit.example")).deliverable, true));
  await check("a domain that doesn't exist is not deliverable", async () => { const r = await verify.checkAddress("a@missing.example"); assert.equal(r.deliverable, false); assert.match(r.reason, /doesn't exist/); });
  await check("a domain with no MX and no address record is not deliverable", async () => assert.equal((await verify.checkAddress("a@empty.example")).deliverable, false));
  await check("a null MX (the domain refuses mail) is not deliverable", async () => assert.equal((await verify.checkAddress("a@nullmx.example")).deliverable, false));
  await check("a DNS outage never blocks: the answer is 'can't tell'", async () => { const r = await verify.checkAddress("a@flaky.example"); assert.equal(r.deliverable, null); });
  await check("malformed addresses are rejected", async () => { for (const bad of ["", "nope", "a@b", "a b@good.example", "@good.example"]) assert.equal((await verify.checkAddress(bad)).deliverable, false, bad); });
  await check("answers are cached per domain", async () => { lookups = 0; await verify.checkAddress("x@good.example"); await verify.checkAddress("y@good.example"); assert.equal(lookups, 0); });
  await check("switched off (default): everything passes and no lookup is made", async () => {
    delete process.env.LEAD_VERIFY_DNS; lookups = 0;
    const r = await verify.checkAddress("a@missing.example");
    assert.equal(r.deliverable, true); assert.equal(lookups, 0);
    process.env.LEAD_VERIFY_DNS = "on";
  });

  console.log("[2] in the sender");
  const ws = (await db.query(`INSERT INTO workspaces (name, slug) VALUES ($1,$2) RETURNING id`, [`Verify ${stamp}`, `verify-${stamp}`])).rows[0].id;
  const dom = (await db.query(`INSERT INTO domains (domain, registrar, dns_provider, provider, status, spf_status, dkim_status, dmarc_status, mx_status, workspace_id) VALUES ($1,'Porkbun','Porkbun','Maildoso','Verified','Success','Success','Success','Success',$2) RETURNING id`, [`v-${stamp}.example`, ws])).rows[0].id;
  const mb = (await db.query(`INSERT INTO mailboxes (domain_id, email, local_part, display_name, status, daily_limit, warmup_stage, provider, workspace_id, market_daily_limit) VALUES ($1,$2,'v','V','Active',20,'Steady State','maildoso',$3,1000) RETURNING id`, [dom, `v@v-${stamp}.example`, ws])).rows[0].id;
  const camp = (await db.query(`INSERT INTO campaigns (name, subject, body, workspace_id, status, mailbox_mode, mailbox_ids, window_start, window_end, timezone) VALUES ('verify','s','Hi',$1,'Active','specific',$2,'00:00','23:59','UTC') RETURNING *`, [ws, [mb]])).rows[0];
  const lead = async (email) => (await db.query(`INSERT INTO campaign_leads (campaign_id, email, workspace_id) VALUES ($1,$2,$3) RETURNING id`, [camp.id, email, ws])).rows[0].id;
  const l1 = await lead("ok@good.example"), l2 = await lead("dead@missing.example"), l3 = await lead("dead@empty.example");
  const now = new Date(); if (now.getUTCHours() === 0 && now.getUTCMinutes() === 0) await new Promise((r) => setTimeout(r, 61000));
  for (let i = 0; i < 6; i++) await campaignSend.tickCampaign((await db.query(`SELECT * FROM campaigns WHERE id = $1`, [camp.id])).rows[0]);
  const status = async (id) => (await db.query(`SELECT status, last_error FROM campaign_leads WHERE id = $1`, [id])).rows[0];
  await check("a deliverable lead is sent to", async () => { assert.equal((await status(l1)).status, "Sent"); assert.ok(sent.some((s) => s.to === "ok@good.example")); });
  await check("leads on domains with no mail server are never sent to; they are marked Failed with the reason", async () => {
    for (const id of [l2, l3]) { const s = await status(id); assert.equal(s.status, "Failed"); assert.match(s.last_error, /not sent/); }
    assert.ok(!sent.some((s) => /dead@/.test(s.to)));
  });

  await db.query(`DELETE FROM workspaces WHERE id = $1`, [ws]).catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
