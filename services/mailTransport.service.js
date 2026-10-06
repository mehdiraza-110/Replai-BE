const nodemailer = require("nodemailer");
const { SendEmailCommand } = require("@aws-sdk/client-sesv2");
const { decryptSecret } = require("../utils/secretBox.util");
const postalService = require("./postal.service");

// One pooled SMTP connection per Maildoso mailbox, reused across cron ticks. Keyed by
// mailbox id + credential fingerprint so a rotated password gets a fresh transport.
const transports = new Map();

function smtpTransportFor(mailbox) {
  const key = `${mailbox.id}:${mailbox.smtp_host}:${mailbox.smtp_port}:${mailbox.password_encrypted}`;
  let transport = transports.get(key);
  if (!transport) {
    for (const existingKey of [...transports.keys()]) {
      if (existingKey.startsWith(`${mailbox.id}:`)) {
        transports.get(existingKey).close();
        transports.delete(existingKey);
      }
    }
    transport = nodemailer.createTransport({
      host: mailbox.smtp_host,
      port: mailbox.smtp_port,
      secure: Number(mailbox.smtp_port) === 465,
      requireTLS: Number(mailbox.smtp_port) !== 465,
      auth: { user: mailbox.email, pass: decryptSecret(mailbox.password_encrypted) },
      pool: true,
      maxConnections: 1,
      connectionTimeout: 20000,
      socketTimeout: 60000,
    });
    transports.set(key, transport);
  }
  return transport;
}

/**
 * Sends an already-built raw MIME message through whichever channel owns the mailbox:
 * Maildoso mailboxes go out over their own authenticated SMTP session, Postal mailboxes through
 * our self-hosted Postal server's HTTP API, everything else
 * through Amazon SES exactly as before. Returns the provider's message id (or null).
 */
async function sendRawEmail({ mailbox, fromAddress, to, raw, sesClient, tags }) {
  if (mailbox.provider === "maildoso") {
    const info = await smtpTransportFor(mailbox).sendMail({
      envelope: { from: mailbox.email, to: [to] },
      raw,
    });
    return info.messageId || null;
  }

  if (mailbox.provider === "postal") {
    return postalService.sendRaw({ mailFrom: mailbox.email, to, raw });
  }

  const response = await sesClient.send(
    new SendEmailCommand({
      FromEmailAddress: fromAddress,
      Destination: { ToAddresses: [to] },
      Content: { Raw: { Data: raw } },
      ConfigurationSetName: mailbox.configuration_set_name || undefined,
      EmailTags: tags && tags.length ? tags : undefined,
    })
  );
  return response.MessageId || null;
}

module.exports = { sendRawEmail };
