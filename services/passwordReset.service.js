// Password reset + invite tokens. Only the sha256 of a token is stored; tokens are never logged.
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const db = require("../config/db.config");
const emailService = require("./email.service");

const RESET_TTL_MS = 60 * 60 * 1000;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PER_EMAIL = 5;
const MAX_PER_IP = 30;
const WINDOW = "1 hour";

class ResetError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const INVALID_LINK = "This reset link is invalid or has expired. Request a new one.";

function validatePassword(password) {
  if (typeof password !== "string" || password.length === 0) return "Enter a new password.";
  if (password.length < 8) return "Password must be at least 8 characters.";
  if (password.length > 128) return "Password must be at most 128 characters.";
  if (!/[A-Za-z]/.test(password)) return "Password must include at least one letter.";
  if (!/[0-9]/.test(password)) return "Password must include at least one number.";
  return null;
}

/** Creates a token for a user, invalidating their older unused tokens of the same purpose. Returns the raw token. */
async function issueToken(userId, purpose, ip = null, client = db) {
  const token = crypto.randomBytes(32).toString("hex");
  const ttl = purpose === "invite" ? INVITE_TTL_MS : RESET_TTL_MS;
  await client.query(`UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`, [userId, purpose]);
  await client.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, purpose, expires_at, requested_ip) VALUES ($1, $2, $3, $4, $5)`,
    [userId, sha256(token), purpose, new Date(Date.now() + ttl), ip ? String(ip).slice(0, 64) : null],
  );
  return token;
}

function resetEmail(token) {
  const url = emailService.appUrl(`reset-password?token=${token}`);
  const { html, text } = emailService.renderEmail({
    title: "Reset your password",
    preheader: "Use this link to choose a new ReplyOS password.",
    paragraphs: [
      "We received a request to reset the password for your ReplyOS account.",
      "This link is valid for 60 minutes and can be used once.",
    ],
    cta: { label: "Reset password", url },
    footnote: "If you did not request this, you can safely ignore this email. Your password will not change.",
  });
  return { subject: "Reset your ReplyOS password", html, text };
}

async function sendPasswordChangedEmail(email, firstName) {
  try {
    const { html, text } = emailService.renderEmail({
      title: "Your password was changed",
      preheader: "The password for your ReplyOS account was just changed.",
      paragraphs: [
        `${firstName ? `Hi ${emailService.escapeHtml(firstName)}, the` : "The"} password for your ReplyOS account was just changed.`,
        "If this was you, no further action is needed.",
        "If this wasn't you, please contact support right away so we can secure your account.",
      ],
      cta: { label: "Sign in", url: emailService.appUrl("login") },
    });
    await emailService.send({ to: email, subject: "Your ReplyOS password was changed", html, text, category: "password-changed" });
  } catch (error) {
    console.error("Password changed email failed:", error.message);
  }
}

// Does the lookup/token/email work. Runs in the background so the HTTP response is identical for known and unknown emails.
async function issueAndSendReset(email, ip) {
  try {
    const { rows } = await db.query(
      `SELECT id FROM users WHERE LOWER(email) = $1 AND COALESCE(is_deleted, FALSE) = FALSE ORDER BY id LIMIT 1`,
      [email],
    );
    if (!rows[0]) return;
    const token = await issueToken(rows[0].id, "reset", ip);
    await emailService.send({ to: email, ...resetEmail(token), category: "password-reset" });
  } catch (error) {
    console.error("Password reset request failed:", error.message);
  }
}

const passwordResetService = {
  ResetError,
  validatePassword,
  issueToken,
  sendPasswordChangedEmail,
  sha256,

  /** Returns a promise for the background work (tests await it); callers in the request path should not. */
  async requestReset(rawEmail, ip) {
    const email = String(rawEmail || "").trim().toLowerCase().slice(0, 254);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { limited: false, done: Promise.resolve() };
    const emailHash = sha256(email);
    const ipKey = ip ? String(ip).slice(0, 64) : null;
    // Log first, then count (including this request), so concurrent bursts cannot slip under the limit.
    await db.query(`INSERT INTO password_reset_requests (email_hash, ip) VALUES ($1, $2)`, [emailHash, ipKey]);
    const { rows } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE email_hash = $1)::int AS by_email,
         COUNT(*) FILTER (WHERE $2::text IS NOT NULL AND ip = $2)::int AS by_ip
       FROM password_reset_requests
       WHERE created_at > NOW() - INTERVAL '${WINDOW}' AND (email_hash = $1 OR ip = $2)`,
      [emailHash, ipKey],
    );
    if (rows[0].by_email > MAX_PER_EMAIL || rows[0].by_ip > MAX_PER_IP) return { limited: true, done: Promise.resolve() };
    // Opportunistic cleanup of old log rows.
    if (Math.random() < 0.02) db.query(`DELETE FROM password_reset_requests WHERE created_at < NOW() - INTERVAL '1 day'`).catch(() => {});
    return { limited: false, done: issueAndSendReset(email, ipKey) };
  },

  async validate(token) {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return false;
    const { rows } = await db.query(
      `SELECT 1 FROM password_reset_tokens t JOIN users u ON u.id = t.user_id AND COALESCE(u.is_deleted, FALSE) = FALSE
       WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > NOW()`,
      [sha256(token)],
    );
    return rows.length > 0;
  },

  async resetPassword(token, password) {
    const problem = validatePassword(password);
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) {
      throw new ResetError(INVALID_LINK);
    }
    if (problem) throw new ResetError(problem);
    const passwordHash = await bcrypt.hash(password, 10);
    const client = await db.getClient();
    let user;
    try {
      await client.query("BEGIN");
      // Atomically consume the token so it can only be used once, even under concurrent requests.
      const { rows } = await client.query(
        `UPDATE password_reset_tokens t SET used_at = NOW()
         FROM users u
         WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > NOW()
           AND u.id = t.user_id AND COALESCE(u.is_deleted, FALSE) = FALSE
         RETURNING t.user_id, u.email, u.first_name`,
        [sha256(token)],
      );
      if (!rows[0]) {
        await client.query("ROLLBACK");
        throw new ResetError(INVALID_LINK);
      }
      user = rows[0];
      await client.query(`UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`, [passwordHash, user.user_id]);
      await client.query(`UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`, [user.user_id]);
      await client.query("COMMIT");
    } catch (error) {
      if (!(error instanceof ResetError)) await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    await sendPasswordChangedEmail(user.email, user.first_name);
    return { message: "Your password has been updated. You can sign in now." };
  },
};

module.exports = passwordResetService;
