// Email OTP for sign-in. After a correct email + password we create a "challenge": a random opaque token (returned to the
// client, stored only as a sha256) tied to a 6-digit code (stored only as a keyed HMAC) that is emailed to the user.
// The session cookie is issued by the controller only after verify() succeeds. The challenge token is not a JWT and is
// never put in a cookie, so no auth guard or the socket can ever mistake it for a session.
//
// Env: EMAIL_OTP_SECRET (HMAC key for stored codes; falls back to JWT_SECRET), EMAIL_LOGIN_OTP_ENABLED (default on).
const crypto = require("crypto");
const db = require("../config/db.config");
const emailService = require("./email.service");

const OTP_TTL_SECONDS = 5 * 60;
const MAX_ATTEMPTS = 5; // wrong codes per issued code
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_RESENDS = 3; // per challenge
const MAX_CHALLENGES_PER_HOUR = 5; // per user, i.e. password-correct logins
const CHALLENGE_MAX_AGE_MINUTES = 30; // a challenge can't be kept alive by resends forever

class OtpError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

const INVALID_CHALLENGE = "This sign-in has expired. Please sign in again.";
const INVALID_CODE = "That code is incorrect or has expired.";

const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const isChallengeToken = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);

function isEnabled() {
  return String(process.env.EMAIL_LOGIN_OTP_ENABLED ?? "true").trim().toLowerCase() !== "false";
}

function secret() {
  const key = process.env.EMAIL_OTP_SECRET || process.env.JWT_SECRET;
  if (!key) throw new Error("EMAIL_OTP_SECRET (or JWT_SECRET) must be set to use email sign-in codes.");
  return key;
}

// Keyed (a 6-digit space is trivially brute-forced from a bare hash) and bound to the challenge it was issued for.
const hashOtp = (challengeHash, code) => crypto.createHmac("sha256", secret()).update(`${challengeHash}:${code}`).digest("hex");
const generateCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, "0");

function codesMatch(expectedHash, challengeHash, code) {
  const actual = Buffer.from(hashOtp(challengeHash, code), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function maskEmail(email) {
  const [local, domain] = String(email).split("@");
  return `${local.slice(0, 1)}${"*".repeat(Math.max(local.length - 1, 2))}@${domain}`;
}

async function sendOtpEmail(user, code) {
  const { html, text } = emailService.renderEmail({
    title: "Your sign-in code",
    preheader: `Your SendVybe sign-in code is ${code}.`,
    paragraphs: [
      `${user.first_name ? `Hi ${emailService.escapeHtml(user.first_name)}, use` : "Use"} this code to finish signing in to SendVybe:`,
      `<span style="display:inline-block;font-size:30px;font-weight:700;letter-spacing:8px;color:#111827;">${code}</span>`,
      `It expires in ${OTP_TTL_SECONDS / 60} minutes and can only be used once.`,
    ],
    footnote: "If you didn't try to sign in, someone may know your password. You can ignore this email, but we recommend changing your password.",
  });
  return emailService.send({ to: user.email, subject: `${code} is your SendVybe sign-in code`, html, text, category: "login-otp" });
}

const emailLoginOtpService = {
  OtpError,
  isEnabled,
  constants: { OTP_TTL_SECONDS, MAX_ATTEMPTS, RESEND_COOLDOWN_SECONDS, MAX_RESENDS, MAX_CHALLENGES_PER_HOUR },

  /** Creates a challenge for a user whose password was just verified and emails the code. `user` needs id, email, first_name. */
  async createChallenge(user, ip = null) {
    const { rows: recent } = await db.query(
      `SELECT COUNT(*)::int AS n FROM email_login_otps WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
      [user.id],
    );
    if (recent[0].n >= MAX_CHALLENGES_PER_HOUR) {
      throw new OtpError("Too many sign-in attempts. Please wait a while and try again.", 429, { retryAfter: 3600 });
    }

    const challengeToken = crypto.randomBytes(32).toString("hex");
    const challengeHash = sha256(challengeToken);
    const code = generateCode();

    const client = await db.getClient();
    try {
      await client.query("BEGIN");
      // Only the newest challenge for a user may be completed.
      await client.query(`UPDATE email_login_otps SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`, [user.id]);
      await client.query(
        `INSERT INTO email_login_otps (user_id, challenge_hash, otp_hash, expires_at, requested_ip)
         VALUES ($1, $2, $3, NOW() + make_interval(secs => $4), $5)`,
        [user.id, challengeHash, hashOtp(challengeHash, code), OTP_TTL_SECONDS, ip ? String(ip).slice(0, 64) : null],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    if (Math.random() < 0.02) db.query(`DELETE FROM email_login_otps WHERE created_at < NOW() - INTERVAL '1 day'`).catch(() => {});

    const sent = await sendOtpEmail(user, code);
    // `skipped` means email.service only stored the message in its in-memory outbox (no SendGrid config): nobody received
    // it, so outside tests that is a failure, not a success.
    const undelivered = !sent.ok || (sent.skipped && process.env.NODE_ENV !== "test");
    if (undelivered) {
      console.error(`Login OTP email not delivered for user ${user.id}: ${sent.skipped ? "SendGrid is not configured (SENDGRID_API_KEY / SENDGRID_FROM_EMAIL)" : sent.detail || sent.error}`);
      await db.query(`UPDATE email_login_otps SET used_at = NOW() WHERE challenge_hash = $1`, [challengeHash]);
      throw new OtpError("We could not send your verification code right now. Please try again in a moment.", 503);
    }
    return {
      challenge_token: challengeToken,
      email: maskEmail(user.email),
      expires_in: OTP_TTL_SECONDS,
      resend_available_in: RESEND_COOLDOWN_SECONDS,
    };
  },

  /** Checks a code. On success the challenge is consumed and the user id is returned; the caller issues the session. */
  async verify(challengeToken, rawCode) {
    const code = String(rawCode ?? "").trim();
    if (!isChallengeToken(challengeToken)) throw new OtpError(INVALID_CHALLENGE, 401, { code: "OTP_CHALLENGE_INVALID" });
    if (!/^\d{6}$/.test(code)) throw new OtpError("Enter the 6-digit code we emailed you.", 400, { code: "OTP_MALFORMED" });
    const challengeHash = sha256(challengeToken);

    // The attempt is counted by the same statement that reads the row, so parallel guesses can't exceed the limit.
    const { rows } = await db.query(
      `UPDATE email_login_otps o SET attempts = attempts + 1
       FROM users u
       WHERE o.challenge_hash = $1 AND o.used_at IS NULL AND o.expires_at > NOW() AND o.attempts < $2
         AND u.id = o.user_id AND COALESCE(u.is_deleted, FALSE) = FALSE
       RETURNING o.id, o.user_id, o.otp_hash, o.attempts`,
      [challengeHash, MAX_ATTEMPTS],
    );
    if (!rows[0]) {
      const { rows: why } = await db.query(
        `SELECT used_at, attempts, expires_at > NOW() AS live FROM email_login_otps WHERE challenge_hash = $1`,
        [challengeHash],
      );
      const row = why[0];
      if (row && !row.used_at && row.live && row.attempts >= MAX_ATTEMPTS) {
        throw new OtpError("Too many incorrect codes. Request a new code.", 429, { code: "OTP_LOCKED" });
      }
      if (row && !row.used_at) throw new OtpError(INVALID_CODE + " Request a new code.", 401, { code: "OTP_EXPIRED" });
      throw new OtpError(INVALID_CHALLENGE, 401, { code: "OTP_CHALLENGE_INVALID" });
    }

    const row = rows[0];
    if (!codesMatch(row.otp_hash, challengeHash, code)) {
      const remaining = Math.max(MAX_ATTEMPTS - row.attempts, 0);
      throw new OtpError(
        remaining > 0 ? `${INVALID_CODE} ${remaining} attempt${remaining === 1 ? "" : "s"} left.` : "Too many incorrect codes. Request a new code.",
        remaining > 0 ? 401 : 429,
        { code: remaining > 0 ? "OTP_INCORRECT" : "OTP_LOCKED", attempts_remaining: remaining },
      );
    }

    // Consume exactly once even if the right code is submitted twice at the same time.
    const { rows: used } = await db.query(
      `UPDATE email_login_otps SET used_at = NOW() WHERE id = $1 AND used_at IS NULL AND expires_at > NOW() RETURNING user_id`,
      [row.id],
    );
    if (!used[0]) throw new OtpError(INVALID_CHALLENGE, 401, { code: "OTP_CHALLENGE_INVALID" });
    await db.query(`UPDATE email_login_otps SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`, [row.user_id]);
    return { userId: row.user_id };
  },

  /** Issues a fresh code for an open challenge (the old code stops working). Rate limited by cooldown and a per-challenge cap. */
  async resend(challengeToken) {
    if (!isChallengeToken(challengeToken)) throw new OtpError(INVALID_CHALLENGE, 401, { code: "OTP_CHALLENGE_INVALID" });
    const challengeHash = sha256(challengeToken);
    const code = generateCode();

    const { rows } = await db.query(
      `UPDATE email_login_otps o
         SET otp_hash = $2, expires_at = NOW() + make_interval(secs => $3), attempts = 0,
             resend_count = resend_count + 1, last_sent_at = NOW()
       FROM users u
       WHERE o.challenge_hash = $1 AND o.used_at IS NULL
         AND o.created_at > NOW() - make_interval(mins => $4)
         AND o.resend_count < $5 AND o.last_sent_at <= NOW() - make_interval(secs => $6)
         AND u.id = o.user_id AND COALESCE(u.is_deleted, FALSE) = FALSE
       RETURNING u.email, u.first_name, o.resend_count`,
      [challengeHash, hashOtp(challengeHash, code), OTP_TTL_SECONDS, CHALLENGE_MAX_AGE_MINUTES, MAX_RESENDS, RESEND_COOLDOWN_SECONDS],
    );
    if (!rows[0]) {
      const { rows: why } = await db.query(
        `SELECT resend_count, created_at > NOW() - make_interval(mins => $2) AS fresh,
                GREATEST(CEIL(EXTRACT(EPOCH FROM (last_sent_at + make_interval(secs => $3) - NOW()))), 1)::int AS wait
         FROM email_login_otps WHERE challenge_hash = $1 AND used_at IS NULL`,
        [challengeHash, CHALLENGE_MAX_AGE_MINUTES, RESEND_COOLDOWN_SECONDS],
      );
      const row = why[0];
      if (!row || !row.fresh) throw new OtpError(INVALID_CHALLENGE, 401, { code: "OTP_CHALLENGE_INVALID" });
      if (row.resend_count >= MAX_RESENDS) {
        throw new OtpError("You've requested too many codes. Please sign in again.", 429, { code: "OTP_RESEND_LIMIT" });
      }
      throw new OtpError(`Please wait ${row.wait} seconds before requesting another code.`, 429, { code: "OTP_RESEND_COOLDOWN", retryAfter: row.wait });
    }

    const sent = await sendOtpEmail(rows[0], code);
    if (!sent.ok || (sent.skipped && process.env.NODE_ENV !== "test")) {
      console.error(`Login OTP resend not delivered: ${sent.skipped ? "SendGrid is not configured" : sent.detail || sent.error}`);
      // Don't charge the user's resend budget or cooldown for a send that never happened.
      await db.query(
        `UPDATE email_login_otps SET resend_count = resend_count - 1, last_sent_at = NOW() - make_interval(secs => $2) WHERE challenge_hash = $1`,
        [challengeHash, RESEND_COOLDOWN_SECONDS],
      );
      throw new OtpError("We could not send your verification code right now. Please try again in a moment.", 503);
    }
    return {
      expires_in: OTP_TTL_SECONDS,
      resend_available_in: RESEND_COOLDOWN_SECONDS,
      resends_remaining: MAX_RESENDS - rows[0].resend_count,
    };
  },
};

module.exports = emailLoginOtpService;
