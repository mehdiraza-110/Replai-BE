const crypto = require("crypto");
const db = require("../config/db.config");

// Matches a reply whose (unquoted) text is essentially just an opt-out request —
// "OPT OUT", "OPT-OUT", "UNSUBSCRIBE", "REMOVE ME (FROM THIS LIST)", "STOP EMAILING ME", etc.
// Deliberately anchored/short-reply-biased so we don't misfire on a long reply that merely
// mentions "stop" in passing (e.g. "please stop by our booth").
const OPT_OUT_PATTERN = /\b(opt[\s-]?out|unsubscribe|remove me( from (this|your) (list|mailing list))?|take me off (this|your) list|stop emailing me)\b/i;

function isOptOutText(text) {
  const cleaned = String(text || "").trim();
  if (!cleaned) return false;
  if (OPT_OUT_PATTERN.test(cleaned)) return true;
  // A bare "STOP" (the standard SMS-style opt-out keyword) only counts when it's
  // essentially the whole reply, to avoid false-positives on normal prose.
  return /^stop\.?!?$/i.test(cleaned);
}

class SuppressionService {
  isOptOutText(text) {
    return isOptOutText(text);
  }

  /**
   * Workspace for a suppression the caller didn't name: the campaign it refers to, else the
   * workspace of the most recent lead with that address. Returns null when neither exists.
   */
  async resolveWorkspaceId({ email, campaignId = null }) {
    if (campaignId) {
      const { rows } = await db.query(`SELECT workspace_id FROM campaigns WHERE id = $1`, [campaignId]);
      if (rows[0]) return rows[0].workspace_id;
    }
    const { rows } = await db.query(
      `SELECT workspace_id FROM campaign_leads WHERE email = $1 ORDER BY id DESC LIMIT 1`,
      [email]
    );
    return rows[0]?.workspace_id ?? null;
  }

  /**
   * Adds (or refreshes) a suppression for one workspace (unique per workspace + email, so another workspace's
   * opt-out for the same address is independent). Callers without a workspaceId get it derived from
   * campaignId / the lead.
   */
  async addSuppression({ email, reason, source, campaignId = null, workspaceId = null }) {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;

    const resolvedWorkspaceId = workspaceId || (await this.resolveWorkspaceId({ email: normalized, campaignId }));
    if (!resolvedWorkspaceId) {
      console.warn(`Suppression for ${normalized} (${reason}) not recorded: could not determine its workspace`);
      return null;
    }

    const { rows } = await db.query(
      `INSERT INTO suppressions (email, reason, source, campaign_id, workspace_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id, email) DO UPDATE SET
         reason = EXCLUDED.reason,
         source = EXCLUDED.source,
         campaign_id = COALESCE(EXCLUDED.campaign_id, suppressions.campaign_id)
       RETURNING id, email, reason, source, campaign_id, created_at`,
      [normalized, reason, source, campaignId, resolvedWorkspaceId]
    );
    return mapSuppressionRow(rows[0]);
  }

  // workspaceId omitted = check every workspace (conservative: used by callers that have no tenant context).
  async isSuppressed(email, workspaceId = null) {
    const normalized = normalizeEmail(email);
    if (!normalized) return false;
    const { rows } = await db.query(
      `SELECT 1 FROM suppressions WHERE email = $1 AND ($2::int IS NULL OR workspace_id = $2) LIMIT 1`,
      [normalized, workspaceId]
    );
    return rows.length > 0;
  }

  /**
   * Given a list of emails, returns the subset that are currently suppressed
   * (normalized, lowercased). Used to filter lead lists at import and send time.
   */
  async filterSuppressed(emails, workspaceId = null) {
    const normalized = Array.from(new Set((Array.isArray(emails) ? emails : []).map(normalizeEmail).filter(Boolean)));
    if (normalized.length === 0) return new Set();
    const { rows } = await db.query(
      `SELECT email FROM suppressions WHERE email = ANY($1::text[]) AND ($2::int IS NULL OR workspace_id = $2)`,
      [normalized, workspaceId]
    );
    return new Set(rows.map((row) => row.email));
  }

  async listSuppressions({ page = 1, limit = 50, search = "", workspaceId } = {}) {
    const pageNum = Math.max(1, Number.parseInt(page, 10) || 1);
    const limitNum = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    const offset = (pageNum - 1) * limitNum;

    const conditions = ["workspace_id = $1"];
    const params = [workspaceId];
    const searchTerm = String(search || "").trim();
    if (searchTerm) {
      params.push(`%${searchTerm}%`);
      conditions.push(`email ILIKE $${params.length}`);
    }
    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const [itemsResult, totalResult] = await Promise.all([
      db.query(
        `SELECT id, email, reason, source, campaign_id, created_at
         FROM suppressions
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limitNum, offset]
      ),
      db.query(`SELECT COUNT(*)::int AS count FROM suppressions ${whereClause}`, params),
    ]);

    const total = totalResult.rows[0]?.count || 0;
    return {
      items: itemsResult.rows.map(mapSuppressionRow),
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.max(1, Math.ceil(total / limitNum)),
    };
  }

  /**
   * Signed, stateless unsubscribe token: HMAC(email + campaignId), no expiry.
   * Unsubscribe links must keep working indefinitely (CAN-SPAM requires honoring
   * them for at least 30 days after send; we don't expire them at all).
   */
  buildUnsubscribeToken({ email, campaignId = null }) {
    const normalized = normalizeEmail(email);
    if (!normalized) {
      throw Object.assign(new Error("A valid email is required to build an unsubscribe token"), { statusCode: 400 });
    }
    // The email is base64url-encoded before joining so "." in the address (e.g. the
    // domain) can never be confused with the "." delimiter between token fields.
    const encodedEmail = Buffer.from(normalized, "utf8").toString("base64url");
    const payload = `${encodedEmail}.${campaignId || 0}`;
    const signature = crypto.createHmac("sha256", getTokenKey()).update(payload).digest("hex");
    return `${payload}.${signature}`;
  }

  buildUnsubscribeUrl({ email, campaignId = null }) {
    const token = this.buildUnsubscribeToken({ email, campaignId });
    const base = String(process.env.APP_BASE_URL || "http://localhost:3001").replace(/\/+$/, "");
    return `${base}/api/v1/unsubscribe/${token}`;
  }

  /**
   * Value for the List-Unsubscribe header (RFC 2369) plus List-Unsubscribe-Post
   * for one-click unsubscribe (RFC 8058), so Gmail/Outlook/Yahoo can show their
   * native unsubscribe button next to the sender name.
   */
  buildListUnsubscribeHeaders({ email, campaignId = null }) {
    const url = this.buildUnsubscribeUrl({ email, campaignId });
    return {
      "List-Unsubscribe": `<${url}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    };
  }

  verifyUnsubscribeToken(token) {
    const raw = String(token || "").trim();
    if (!raw) throw buildTokenError();

    const parts = raw.split(".");
    if (parts.length !== 3) throw buildTokenError();

    const [encodedEmail, campaignIdRaw, signature] = parts;
    const expected = crypto.createHmac("sha256", getTokenKey()).update(`${encodedEmail}.${campaignIdRaw}`).digest("hex");

    const provided = Buffer.from(signature, "utf8");
    const expectedBuffer = Buffer.from(expected, "utf8");
    if (provided.length !== expectedBuffer.length || !crypto.timingSafeEqual(provided, expectedBuffer)) {
      throw buildTokenError();
    }

    let email;
    try {
      email = Buffer.from(encodedEmail, "base64url").toString("utf8");
    } catch {
      throw buildTokenError();
    }
    if (!email || !email.includes("@")) throw buildTokenError();

    const campaignId = Number(campaignIdRaw);
    return { email, campaignId: campaignId > 0 ? campaignId : null };
  }

  async unsubscribeByToken(token) {
    const { email, campaignId } = this.verifyUnsubscribeToken(token);
    // The workspace comes from the campaign (or lead) the token refers to; the token itself carries no workspace.
    const workspaceId = await this.resolveWorkspaceId({ email: email.trim().toLowerCase(), campaignId });
    const suppression = await this.addSuppression({ email, reason: "unsubscribed", source: "link_click", campaignId, workspaceId });
    if (!suppression && workspaceId) {
      // The global suppression row for this address belongs to another workspace, so it can't hold this opt-out.
      // Stop this workspace's own sends to the address instead.
      await db.query(
        `UPDATE campaign_leads SET status = 'Suppressed' WHERE email = $1 AND workspace_id = $2 AND status IN ('Pending', 'Sent')`,
        [email.trim().toLowerCase(), workspaceId]
      );
      return { email: email.trim().toLowerCase() };
    }
    return suppression;
  }
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase() || null;
}

function mapSuppressionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    reason: row.reason,
    source: row.source,
    campaignId: row.campaign_id,
    createdAt: row.created_at,
  };
}

function getTokenKey() {
  const secret = process.env.UNSUBSCRIBE_TOKEN_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw Object.assign(new Error("UNSUBSCRIBE_TOKEN_SECRET is not configured"), { statusCode: 500 });
  }
  return crypto.createHash("sha256").update(secret).digest();
}

function buildTokenError() {
  return Object.assign(new Error("This unsubscribe link is invalid"), { statusCode: 400 });
}

module.exports = new SuppressionService();
