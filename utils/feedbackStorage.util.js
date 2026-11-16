const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");

// Support-ticket recordings, in their own private bucket (FEEDBACK_S3_BUCKET), streamed in and
// read back through short-lived signed links, because the bytes are private to the reporter and the support team.

// Recordings live in their own private bucket: FEEDBACK_S3_BUCKET / FEEDBACK_S3_REGION, with the platform AWS keys.
const bucket = () => process.env.FEEDBACK_S3_BUCKET;
const REGION = () => process.env.FEEDBACK_S3_REGION || "us-east-1";
let client = null;

const isConfigured = () => Boolean(bucket() && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

function s3() {
  if (!client) {
    client = new S3Client({ region: REGION(), credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY } });
  }
  return client;
}

// `stream` is the raw request; Content-Length is required so nothing is buffered in memory.
async function putStream(key, stream, contentLength, contentType) {
  await s3().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: stream, ContentLength: contentLength, ContentType: contentType }));
}

async function signedUrl(key, { filename, download } = {}) {
  const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
  const ttl = Math.min(Math.max(Number(process.env.AWS_S3_URL_TTL_SECONDS) || 3600, 60), 43200);
  return getSignedUrl(
    s3(),
    new GetObjectCommand({
      Bucket: bucket(),
      Key: key,
      ...(download && filename ? { ResponseContentDisposition: `attachment; filename="${filename.replace(/[^\w.\- ]/g, "_")}"` } : {}),
    }),
    { expiresIn: ttl },
  );
}

module.exports = { isConfigured, putStream, signedUrl };
