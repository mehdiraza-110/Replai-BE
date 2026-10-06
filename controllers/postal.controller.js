const { simpleParser } = require("mailparser");
const postalService = require("../services/postal.service");
const postalEventsService = require("../services/postalEvents.service");
const sesInboundEmailService = require("../services/sesInboundEmail.service");

// Public — Postal calls these directly, authenticated by the shared ?token= secret.
function authorized(req, res) {
  if (postalService.isValidWebhookToken(req.query.token)) return true;
  res.status(401).json({ success: false, message: "Unauthorized" });
  return false;
}

async function receiveEvent(req, res) {
  if (!authorized(req, res)) return;
  try {
    const result = await postalEventsService.handleEvent(req.body);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message || "Unable to process event" });
  }
}

// Postal HTTP endpoint with "include raw message" enabled: { rcpt_to, mail_from, message (base64), base64: true }.
async function receiveInbound(req, res) {
  if (!authorized(req, res)) return;
  try {
    const { message, base64 } = req.body || {};
    if (!message) return res.status(400).json({ success: false, message: "Missing message" });
    const raw = base64 === false || base64 === "false" ? Buffer.from(message) : Buffer.from(message, "base64");
    const parsed = await simpleParser(raw);
    const result = await sesInboundEmailService.processParsedEmail({ parsed, bucket: "postal", key: parsed.messageId || null });
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message || "Unable to process inbound message" });
  }
}

module.exports = { receiveEvent, receiveInbound };
