// Verifies the email sign-in code flow in the LOCAL sandbox (NODE_ENV=test keeps emails in memory; nothing is sent).
//   NODE_ENV=test ./dev-local.sh node scripts/login-otp-test.js
const BE = require("path").resolve(__dirname, "..");
const assert = require("assert");
if (process.env.NODE_ENV !== "test") { console.error("Run with NODE_ENV=test so no email can leave the machine."); process.exit(2); }
const db = require(`${BE}/config/db.config`);
const bcrypt = require(`${BE}/node_modules/bcrypt`);
const email = require(`${BE}/services/email.service`);
const otp = require(`${BE}/services/emailLoginOtp.service`);
const userController = require(`${BE}/controllers/user.controller`);

let pass = 0, fail = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log("  PASS", name); }, (e) => { fail++; console.log("  FAIL", name, "->", e.message); });
const stamp = Date.now();
const lastCode = () => { const m = email.outbox.at(-1); const hit = /\b(\d{6})\b/.exec(m.subject); return hit[1]; };
const challengeOf = async (token) => (await db.query(`SELECT * FROM email_login_otps WHERE challenge_hash = encode(sha256($1::bytea), 'hex')`, [token])).rows[0];
const rejects = (fn, code, status) => assert.rejects(fn, (e) => e instanceof otp.OtpError && (!code || e.code === code) && (!status || e.status === status), `expected ${code || ""} ${status || ""}`);
const fakeRes = () => { const r = { headers: {}, cookies: {}, statusCode: 200, body: null }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.cookie = (n, v) => { r.cookies[n] = v; return r; }; r.set = (k, v) => { r.headers[k] = v; return r; }; return r; };

(async () => {
  const hash = await bcrypt.hash("CorrectHorse!123", 8);
  const mkUser = async (tag) => (await db.query(`INSERT INTO users (first_name, last_name, email, password_hash, is_verified) VALUES ($1,'Tester',$2,$3,true) RETURNING id, email, first_name`, [tag, `${tag.toLowerCase()}-${stamp}@otp.invalid`, hash])).rows[0];
  const ann = await mkUser("Ann"), bob = await mkUser("Bob"), cat = await mkUser("Cat"), dan = await mkUser("Dan"), eve = await mkUser("Eve");

  console.log("\n[1] issuing a code");
  let c1;
  await check("a code is emailed to the user, in the subject and body, and the address is masked in the answer", async () => {
    c1 = await otp.createChallenge(ann, "203.0.113.5");
    const m = email.outbox.at(-1); assert.equal(m.to, ann.email); assert.match(m.subject, /^\d{6} is your SendVybe sign-in code$/); assert.match(m.text || m.html, /\d{6}/);
    assert.doesNotMatch(c1.email, /ann-/); assert.match(c1.email, /\*+@otp\.invalid$/); assert.equal(c1.expires_in, 300); assert.match(c1.challenge_token, /^[a-f0-9]{64}$/);
  });
  await check("neither the code nor the challenge token is stored in clear", async () => {
    const row = await challengeOf(c1.challenge_token); const code = lastCode();
    assert.notEqual(row.challenge_hash, c1.challenge_token); assert.ok(!JSON.stringify(row).includes(code)); assert.equal(row.otp_hash.length, 64);
  });

  console.log("\n[2] checking a code");
  await check("the right code returns the user once; using it again fails", async () => {
    const code = lastCode(); const r = await otp.verify(c1.challenge_token, code); assert.equal(r.userId, ann.id);
    await rejects(() => otp.verify(c1.challenge_token, code), "OTP_CHALLENGE_INVALID", 401);
  });
  await check("wrong codes count down and lock after 5, and even the right code is refused after that", async () => {
    const c = await otp.createChallenge(bob); const right = lastCode(); const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 4; i >= 1; i--) await rejects(() => otp.verify(c.challenge_token, wrong), "OTP_INCORRECT", 401);
    await rejects(() => otp.verify(c.challenge_token, wrong), "OTP_LOCKED", 429);
    await rejects(() => otp.verify(c.challenge_token, right), "OTP_LOCKED", 429);
  });
  await check("an expired code is refused with a clear reason", async () => {
    const c = await otp.createChallenge(cat); const code = lastCode(); await db.query(`UPDATE email_login_otps SET expires_at = NOW() - INTERVAL '1 second' WHERE challenge_hash = encode(sha256($1::bytea), 'hex')`, [c.challenge_token]);
    await rejects(() => otp.verify(c.challenge_token, code), "OTP_EXPIRED", 401);
  });
  await check("only the newest sign-in attempt can be completed", async () => {
    const first = await otp.createChallenge(dan); const firstCode = lastCode(); const second = await otp.createChallenge(dan); const secondCode = lastCode();
    await rejects(() => otp.verify(first.challenge_token, firstCode), "OTP_CHALLENGE_INVALID", 401);
    assert.equal((await otp.verify(second.challenge_token, secondCode)).userId, dan.id);
  });
  await check("malformed input and unknown tokens are rejected before touching the database", async () => {
    await rejects(() => otp.verify("nope", "123456"), "OTP_CHALLENGE_INVALID", 401);
    const c = await otp.createChallenge(eve); await rejects(() => otp.verify(c.challenge_token, "12ab56"), "OTP_MALFORMED", 400); await rejects(() => otp.verify("a".repeat(64), "123456"), "OTP_CHALLENGE_INVALID", 401);
  });
  await check("a code issued for one sign-in doesn't work on another", async () => {
    const a = await otp.createChallenge(ann); const codeA = lastCode(); const b = await otp.createChallenge(bob); const codeB = lastCode();
    if (codeA !== codeB) await rejects(() => otp.verify(b.challenge_token, codeA), "OTP_INCORRECT", 401);
    assert.equal((await otp.verify(b.challenge_token, codeB)).userId, bob.id); void a;
  });

  console.log("\n[3] resending");
  const fresh = await mkUser("Fay");
  let rc;
  await check("resend is blocked during the cooldown, works after it, and the old code stops working", async () => {
    rc = await otp.createChallenge(fresh); const oldCode = lastCode();
    await rejects(() => otp.resend(rc.challenge_token), "OTP_RESEND_COOLDOWN", 429);
    await db.query(`UPDATE email_login_otps SET last_sent_at = NOW() - INTERVAL '2 minutes' WHERE challenge_hash = encode(sha256($1::bytea), 'hex')`, [rc.challenge_token]);
    const r = await otp.resend(rc.challenge_token); assert.equal(r.resends_remaining, 2); const newCode = lastCode();
    if (newCode !== oldCode) await rejects(() => otp.verify(rc.challenge_token, oldCode), "OTP_INCORRECT", 401);
    assert.equal((await otp.verify(rc.challenge_token, newCode)).userId, fresh.id);
  });
  await check("at most 3 resends per sign-in", async () => {
    const g = await mkUser("Gus"); const c = await otp.createChallenge(g);
    for (let i = 0; i < 3; i++) { await db.query(`UPDATE email_login_otps SET last_sent_at = NOW() - INTERVAL '2 minutes' WHERE challenge_hash = encode(sha256($1::bytea), 'hex')`, [c.challenge_token]); await otp.resend(c.challenge_token); }
    await db.query(`UPDATE email_login_otps SET last_sent_at = NOW() - INTERVAL '2 minutes' WHERE challenge_hash = encode(sha256($1::bytea), 'hex')`, [c.challenge_token]);
    await rejects(() => otp.resend(c.challenge_token), "OTP_RESEND_LIMIT", 429);
  });
  await check("a sign-in can't be kept alive for ever by resending (30 minute cap)", async () => {
    const h = await mkUser("Hal"); const c = await otp.createChallenge(h);
    await db.query(`UPDATE email_login_otps SET created_at = NOW() - INTERVAL '31 minutes', last_sent_at = NOW() - INTERVAL '5 minutes' WHERE challenge_hash = encode(sha256($1::bytea), 'hex')`, [c.challenge_token]);
    await rejects(() => otp.resend(c.challenge_token), "OTP_CHALLENGE_INVALID", 401);
  });

  console.log("\n[4] abuse limits and delivery failures");
  await check("the 6th sign-in attempt within an hour is refused", async () => {
    const i = await mkUser("Ivy"); for (let n = 0; n < 5; n++) await otp.createChallenge(i);
    await rejects(() => otp.createChallenge(i), null, 429);
  });
  await check("if the email can't be sent the user is told, and the unsent code is dead", async () => {
    const j = await mkUser("Jon"); const real = email.send; email.send = async () => ({ ok: false, error: "SendGrid returned 401", detail: "bad key" });
    let token; try { await otp.createChallenge(j); } catch (e) { assert.equal(e.status, 503); assert.match(e.message, /could not send/i); } finally { email.send = real; }
    const rows = (await db.query(`SELECT used_at FROM email_login_otps WHERE user_id = $1`, [j.id])).rows; assert.ok(rows.length === 1 && rows[0].used_at, "the challenge was revoked"); void token;
  });

  console.log("\n[5] the real login endpoints");
  const login = async (body) => { const res = fakeRes(); await userController.login({ body, headers: {}, ip: "203.0.113.9", socket: {} }, res); return res; };
  await check("password right: no session yet, a code is required and emailed", async () => {
    const k = await mkUser("Kim"); process.env.EMAIL_LOGIN_OTP_ENABLED = "true"; const res = await login({ email: k.email, password: "CorrectHorse!123" });
    assert.equal(res.statusCode, 200); assert.equal(res.body.data.requires_otp, true); assert.deepEqual(res.cookies, {}); assert.ok(!res.body.data.token); assert.ok(!res.body.data.user);
    assert.equal(email.outbox.at(-1).to, k.email); global.kim = { k, challenge: res.body.data.challenge_token };
  });
  await check("the right code then gives the normal session: cookie, token and user", async () => {
    const res = fakeRes(); await userController.verifyLoginOtp({ body: { challenge_token: global.kim.challenge, otp: lastCode() } }, res);
    assert.equal(res.statusCode, 200); assert.ok(res.cookies.token); assert.ok(res.body.data.token); assert.equal(res.body.data.user.email, global.kim.k.email); assert.ok(Array.isArray(res.body.data.user.workspaces));
  });
  await check("wrong password: the same generic refusal as before, and no email is sent", async () => {
    const before = email.outbox.length; const k = await mkUser("Lou"); const res = await login({ email: k.email, password: "wrong-password" });
    assert.equal(res.statusCode, 401); assert.equal(res.body.message, "Invalid email or password"); assert.equal(email.outbox.length, before);
  });
  await check("a wrong code gives a clear 401 with attempts left, and no session", async () => {
    const k = await mkUser("Max"); const res1 = await login({ email: k.email, password: "CorrectHorse!123" }); const code = lastCode(); const wrong = code === "123456" ? "654321" : "123456";
    const res = fakeRes(); await userController.verifyLoginOtp({ body: { challenge_token: res1.body.data.challenge_token, otp: wrong } }, res);
    assert.equal(res.statusCode, 401); assert.equal(res.body.code, "OTP_INCORRECT"); assert.equal(res.body.attempts_remaining, 4); assert.deepEqual(res.cookies, {});
  });
  await check("switched off (EMAIL_LOGIN_OTP_ENABLED=false) it is plain password sign-in again", async () => {
    const k = await mkUser("Ned"); process.env.EMAIL_LOGIN_OTP_ENABLED = "false"; const before = email.outbox.length; const res = await login({ email: k.email, password: "CorrectHorse!123" });
    assert.equal(res.statusCode, 200); assert.ok(res.cookies.token); assert.equal(res.body.data.user.email, k.email); assert.equal(email.outbox.length, before); process.env.EMAIL_LOGIN_OTP_ENABLED = "true";
  });
  await check("resend through the endpoint answers with the cooldown", async () => {
    const k = await mkUser("Oz"); const r1 = await login({ email: k.email, password: "CorrectHorse!123" }); const res = fakeRes();
    await userController.resendLoginOtp({ body: { challenge_token: r1.body.data.challenge_token } }, res); assert.equal(res.statusCode, 429); assert.equal(res.body.code, "OTP_RESEND_COOLDOWN"); assert.ok(res.headers["Retry-After"]);
  });

  await db.query(`DELETE FROM email_login_otps WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`%-${stamp}@otp.invalid`]);
  await db.query(`DELETE FROM users WHERE email LIKE $1`, [`%-${stamp}@otp.invalid`]);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
