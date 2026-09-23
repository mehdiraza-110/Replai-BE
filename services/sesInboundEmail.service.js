const https = require("node:https");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { simpleParser } = require("mailparser");
const db = require("../config/db.config");
const suppressionService = require("./suppression.service");

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
    let envelope;
    try {
      envelope = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
    } catch {
      throw Object.assign(new Error("Invalid SNS message body"), { statusCode: 400 });
    }

    if (envelope.Type === "SubscriptionConfirmation") {
      await confirmSnsSubscription(envelope.SubscribeURL);
      return { status: "SubscriptionConfirmed" };
    }

    if (envelope.Type === "UnsubscribeConfirmation") {
      return { status: "Acknowledged" };
    }

    if (envelope.Type !== "Notification") {
      return { status: "Ignored", reason: `Unhandled SNS message type: ${envelope.Type}` };
    }

    let sesNotification;
    try {
      sesNotification = JSON.parse(envelope.Message);
    } catch {
      throw Object.assign(new Error("SNS notification did not contain a valid SES payload"), { statusCode: 400 });
    }

    return this.handleSesNotification(sesNotification);
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

// SNS requires the subscriber to GET the SubscribeURL once to activate the subscription.
// This endpoint is public/unauthenticated, so a forged "SubscriptionConfirmation" body
// could otherwise be used to make this server fetch an arbitrary attacker-chosen HTTPS
// URL (SSRF) — restrict to real SNS hostnames, not just the https:// scheme.
const SNS_HOSTNAME_PATTERN = /^sns\.[a-z0-9-]+\.amazonaws\.com$/i;

function confirmSnsSubscription(subscribeUrl) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = subscribeUrl ? new URL(subscribeUrl) : null;
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.protocol !== "https:" || !SNS_HOSTNAME_PATTERN.test(parsed.hostname)) {
      reject(Object.assign(new Error("Refusing to confirm SNS subscription: SubscribeURL was not a valid SNS endpoint"), { statusCode: 400 }));
      return;
    }
    https
      .get(subscribeUrl, (res) => {
        res.on("data", () => {});
        res.on("end", resolve);
      })
      .on("error", reject);
  });
}

module.exports = new SesInboundEmailService();
