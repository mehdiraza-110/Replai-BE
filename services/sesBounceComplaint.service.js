const db = require("../config/db.config");
const suppressionService = require("./suppression.service");
const eventLogService = require("./eventLog.service");
const { resolveSnsEnvelope } = require("../utils/snsEnvelope.util");

class SesBounceComplaintService {
  /**
   * Entry point for the SNS HTTPS subscription attached to each domain's Configuration
   * Set event destination (see domain.service.js ensureDomainConfigurationSet). Unlike
   * the inbound-email pipeline, these notifications carry the event data directly — no
   * S3 fetch needed.
   */
  async handleSnsMessage(rawBody) {
    const { handled, result, message } = await resolveSnsEnvelope(rawBody);
    if (handled) return result;
    return this.handleSesEvent(message);
  }

  async handleSesEvent(event) {
    if (event.eventType === "Bounce") return this.handleBounce(event);
    if (event.eventType === "Complaint") return this.handleComplaint(event);
    return { status: "Ignored", reason: `Unhandled event type: ${event.eventType}` };
  }

  /**
   * Only a Permanent (hard) bounce suppresses immediately — a Transient (soft) bounce
   * (mailbox full, greylisting, temporary failure) is just logged, per the design in
   * PlusVibe-Plan.md 12A.2.5: suppressing on the first soft bounce would be overly
   * aggressive and drop leads that would have delivered on retry.
   */
  async handleBounce(event) {
    const recipients = event.bounce?.bouncedRecipients || [];
    const isHard = event.bounce?.bounceType === "Permanent";
    const campaignId = extractCampaignId(event);

    for (const recipient of recipients) {
      const email = recipient.emailAddress?.toLowerCase();
      if (!email) continue;

      if (isHard) {
        await suppressionService.addSuppression({ email, reason: "hard_bounce", source: "ses_bounce", campaignId });
        await db.query(`UPDATE campaign_leads SET status = 'Bounced' WHERE email = $1 AND campaign_id = $2 AND status != 'Bounced'`, [email, campaignId]).catch(() => {});
      }

      await eventLogService.record({
        eventType: isHard ? "ses.bounce.permanent" : "ses.bounce.transient",
        source: "ses",
        status: isHard ? "Success" : "Skipped",
        campaignId,
        leadEmail: email,
        messageId: event.mail?.messageId,
        metadata: { bounceType: event.bounce?.bounceType, bounceSubType: event.bounce?.bounceSubType, diagnosticCode: recipient.diagnosticCode },
      });
    }

    return { status: "Processed", eventType: "Bounce", bounceType: event.bounce?.bounceType, recipientCount: recipients.length, suppressed: isHard };
  }

  /** Any complaint (spam report) suppresses immediately — there is no "soft" complaint. */
  async handleComplaint(event) {
    const recipients = event.complaint?.complainedRecipients || [];
    const campaignId = extractCampaignId(event);

    for (const recipient of recipients) {
      const email = recipient.emailAddress?.toLowerCase();
      if (!email) continue;

      await suppressionService.addSuppression({ email, reason: "complained", source: "ses_complaint", campaignId });

      await eventLogService.record({
        eventType: "ses.complaint",
        source: "ses",
        status: "Success",
        campaignId,
        leadEmail: email,
        messageId: event.mail?.messageId,
        metadata: { complaintFeedbackType: event.complaint?.complaintFeedbackType },
      });
    }

    return { status: "Processed", eventType: "Complaint", recipientCount: recipients.length, suppressed: true };
  }
}

/** campaign_leads.campaign_id (and therefore this) is scoped from the message tags we set at send time. */
function extractCampaignId(event) {
  const tags = event.mail?.tags || {};
  const raw = Array.isArray(tags.campaign_id) ? tags.campaign_id[0] : tags.campaign_id;
  const campaignId = Number(raw);
  return Number.isFinite(campaignId) && campaignId > 0 ? campaignId : null;
}

module.exports = new SesBounceComplaintService();
