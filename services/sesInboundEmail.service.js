const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { simpleParser } = require("mailparser");
const db = require("../config/db.config");
const suppressionService = require("./suppression.service");
const { resolveSnsEnvelope } = require("../utils/snsEnvelope.util");

// SES inbound receiving is only available in a handful of regions (not necessarily
// the same region used for sending) — configurable independently of AWS_REGION.
const SES_INBOUND_REGION = process.env.SES_INBOUND_REGION || process.env.AWS_REGION || "us-east-1";
const s3Client = new S3Client({ region: SES_INBOUND_REGION });

class SesInboundEmailService {
  /**
   * Entry point for the SNS HTTPS subscription (raw request body, text/plain JSON per SNS).
   * Handles both the one-time SubscriptionConfirmation handshake and ongoing Notifications.
   */
  async handleSnsMessage(rawBody) {
    const { handled, result, message } = await resolveSnsEnvelope(rawBody);
    if (handled) return result;
    return this.handleSesNotification(message);
  }

  /**
   * The decoded SES notification (already JSON.parse'd out of the SNS envelope).
   * SES receipt rules configured with an S3 action deliver the raw MIME message to S3
   * and include the bucket/key here; we fetch and parse it from there.
   */
  async handleSesNotification(sesNotification) {
    const mail = sesNotification?.mail;
    const s3Info = sesNotification?.receipt?.action;
    if (!mail || !s3Info || s3Info.type !== "S3") {
      return { status: "Ignored", reason: "Notification did not include an S3-delivered message" };
    }

    const bucket = s3Info.bucketName;
    const key = `${s3Info.objectKeyPrefix || ""}${s3Info.objectKey}`.replace(/^\/+/, "");
    return this.processStoredEmail({ bucket, key });
  }

  /**
   * Fetches the raw MIME message from S3, parses it, checks for an opt-out reply,
   * and logs it. This is the piece that actually matters for compliance: any reply
   * whose body matches the opt-out pattern suppresses that sender address immediately.
   */
  async processStoredEmail({ bucket, key }) {
    const raw = await fetchRawEmail(bucket, key);
    const parsed = await simpleParser(raw);

    const fromAddress = parsed.from?.value?.[0]?.address?.toLowerCase() || null;
    const toAddress = parsed.to?.value?.[0]?.address?.toLowerCase() || null;
    const bodyText = String(parsed.text || "").trim();
    const isOptOut = fromAddress ? suppressionService.isOptOutText(bodyText) : false;

    if (isOptOut) {
      await suppressionService.addSuppression({
        email: fromAddress,
        reason: "unsubscribed",
        source: "reply_keyword",
      });
    }

    await db.query(
      `INSERT INTO inbound_messages (message_id, from_address, to_address, subject, body_text, s3_bucket, s3_key, is_opt_out)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [parsed.messageId || null, fromAddress, toAddress, parsed.subject || null, bodyText, bucket, key, isOptOut]
    );

    return { status: "Processed", fromAddress, toAddress, isOptOut };
  }
}

function fetchRawEmail(bucket, key) {
  return s3Client
    .send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    .then((result) => streamToBuffer(result.Body));
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

module.exports = new SesInboundEmailService();
