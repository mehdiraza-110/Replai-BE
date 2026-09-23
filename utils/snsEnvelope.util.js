const https = require("node:https");

// SNS requires the subscriber to GET the SubscribeURL once to activate the subscription.
// These HTTPS endpoints are public/unauthenticated, so a forged "SubscriptionConfirmation"
// body could otherwise be used to make this server fetch an arbitrary attacker-chosen HTTPS
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

/**
 * Parses a raw SNS HTTPS delivery body (text/plain JSON) and resolves the subscription
 * handshake automatically. Returns:
 *   - { handled: true, result } for SubscriptionConfirmation / UnsubscribeConfirmation / unrecognized types
 *   - { handled: false, message } for a real Notification, with `message` already
 *     JSON.parse'd out of the SNS envelope, ready for the caller to interpret.
 */
async function resolveSnsEnvelope(rawBody) {
  let envelope;
  try {
    envelope = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
  } catch {
    throw Object.assign(new Error("Invalid SNS message body"), { statusCode: 400 });
  }

  if (envelope.Type === "SubscriptionConfirmation") {
    await confirmSnsSubscription(envelope.SubscribeURL);
    return { handled: true, result: { status: "SubscriptionConfirmed" } };
  }

  if (envelope.Type === "UnsubscribeConfirmation") {
    return { handled: true, result: { status: "Acknowledged" } };
  }

  if (envelope.Type !== "Notification") {
    return { handled: true, result: { status: "Ignored", reason: `Unhandled SNS message type: ${envelope.Type}` } };
  }

  let message;
  try {
    message = JSON.parse(envelope.Message);
  } catch {
    throw Object.assign(new Error("SNS notification did not contain valid JSON"), { statusCode: 400 });
  }

  return { handled: false, message };
}

module.exports = { resolveSnsEnvelope, confirmSnsSubscription };
