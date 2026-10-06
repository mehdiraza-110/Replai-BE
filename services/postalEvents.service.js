const db = require("../config/db.config");
const suppressionService = require("./suppression.service");
const eventLogService = require("./eventLog.service");

/**
 * Postal webhook events -> the same suppression/event-log path SES bounces use
 * (sesBounceComplaint.service.js). Configure a Postal webhook for the events
 * MessageDeliveryFailed and MessageBounced pointing at /api/v1/postal/events?token=...
 */
class PostalEventsService {
  async handleEvent(body) {
    const event = body?.event;
    const payload = body?.payload || {};

    if (event === "MessageDeliveryFailed") return this.handleDeliveryFailed(payload);
    if (event === "MessageBounced") return this.handleBounced(payload);
    return { status: "Ignored", reason: `Unhandled event: ${event}` };
  }

  // status HardFail = permanent rejection by the recipient server; SoftFail is retried by Postal.
  async handleDeliveryFailed(payload) {
    const isHard = payload.status === "HardFail";
    return this.record({
      email: payload.message?.to,
      rfcMessageId: payload.message?.message_id,
      postalMessageId: payload.message?.id,
      isHard,
      detail: payload.output || payload.details,
      kind: payload.status,
    });
  }

  // An asynchronous DSN arrived at the return path for a message we already sent.
  async handleBounced(payload) {
    return this.record({
      email: payload.original_message?.to,
      rfcMessageId: payload.original_message?.message_id,
      postalMessageId: payload.original_message?.id,
      isHard: true,
      detail: payload.bounce?.subject,
      kind: "Bounced",
    });
  }

  async record({ email, rfcMessageId, postalMessageId, isHard, detail, kind }) {
    const address = String(email || "").toLowerCase().trim();
    if (!address) return { status: "Ignored", reason: "No recipient in event" };

    const campaignId = await this.findCampaignId(address, rfcMessageId);

    if (isHard) {
      await suppressionService.addSuppression({ email: address, reason: "hard_bounce", source: "postal_bounce", campaignId });
      if (campaignId) {
        await db
          .query(`UPDATE campaign_leads SET status = 'Bounced' WHERE email = $1 AND campaign_id = $2 AND status != 'Bounced'`, [address, campaignId])
          .catch(() => {});
      }
    }

    await eventLogService.record({
      eventType: isHard ? "postal.bounce.permanent" : "postal.bounce.transient",
      source: "postal",
      status: isHard ? "Success" : "Skipped",
      campaignId,
      leadEmail: address,
      messageId: rfcMessageId || (postalMessageId ? String(postalMessageId) : null),
      metadata: { kind, detail: String(detail || "").slice(0, 500) },
    });

    return { status: "Processed", suppressed: isHard };
  }

  /** Our Message-ID is stored with angle brackets; Postal may report it with or without. */
  async findCampaignId(email, rfcMessageId) {
    if (!rfcMessageId) return null;
    const bare = String(rfcMessageId).replace(/^<|>$/g, "");
    const { rows } = await db.query(
      `SELECT campaign_id FROM campaign_leads WHERE email = $1 AND rfc_message_id IN ($2, $3) LIMIT 1`,
      [email, bare, `<${bare}>`]
    );
    return rows[0]?.campaign_id || null;
  }
}

module.exports = new PostalEventsService();
