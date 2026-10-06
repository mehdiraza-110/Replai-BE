const crypto = require("crypto");

// AES-256-GCM string encryption for mailbox credentials. Stored as "iv:tag:ciphertext" (hex).
// No fallback key on purpose: a missing/rotated key must fail loudly instead of quietly
// encrypting passwords under a guessable secret.
function getKey() {
  const secret = process.env.MAILBOX_ENCRYPTION_KEY;
  if (!secret || String(secret).trim().length === 0) {
    throw Object.assign(new Error("MAILBOX_ENCRYPTION_KEY is not configured"), { statusCode: 500 });
  }
  return crypto.createHash("sha256").update(String(secret)).digest();
}

function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return [iv.toString("hex"), cipher.getAuthTag().toString("hex"), encrypted.toString("hex")].join(":");
}

function decryptSecret(payload) {
  const [iv, tag, encrypted] = String(payload || "").split(":");
  if (!iv || !tag || !encrypted) throw new Error("Malformed encrypted secret");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "hex")), decipher.final()]).toString("utf8");
}

module.exports = { encryptSecret, decryptSecret };
