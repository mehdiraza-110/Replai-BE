const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const path = require("path");
const crypto = require("crypto");
const dotenv = require("dotenv");


const s3 = new S3Client({
  region: "ca-central-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  },
});

const uploadToS3 = async (file, folderName) => {
  // Use .webp extension (images are converted to WebP before upload)
  const ext = '.webp';
  // Generate random filename using random characters (alphanumeric)
  const randomString = crypto.randomBytes(16).toString("hex");
  const filename = `${randomString}${ext}`;
  const bucket = process.env.AWS_BUCKET_NAME;
  const key = `${folderName}/${filename}`;

  console.log(`Uploading ${filename} to S3...`);

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: file?.buffer,
    ContentType: file?.mimetype || 'image/webp',
  });

  try {
    await s3.send(command);
    const url = `https://${bucket}.s3.ca-central-1.amazonaws.com/${key}`;
    console.log(`Upload successful: ${url}`);
    return url;
  } catch (err) {
    console.error("S3 Upload Error:", err);
    throw err;
  }
};

/**
 * Uploads a PDF document to S3
 * @param {Object} file - File object with buffer and mimetype
 * @param {string} folderName - Folder name in S3 bucket
 * @returns {Promise<string>} - S3 URL of uploaded file
 */
const uploadPDFToS3 = async (file, folderName) => {
  // Get original file extension or default to .pdf
  const originalExt = path.extname(file.originalname || '') || '.pdf';
  // Generate random filename
  const randomString = crypto.randomBytes(16).toString("hex");
  const filename = `${randomString}${originalExt}`;
  const bucket = process.env.AWS_BUCKET_NAME;
  const key = `${folderName}/${filename}`;

  console.log(`Uploading PDF ${filename} to S3...`);

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: file?.buffer,
    ContentType: file?.mimetype || 'application/pdf',
  });

  try {
    await s3.send(command);
    const url = `https://${bucket}.s3.ca-central-1.amazonaws.com/${key}`;
    console.log(`PDF upload successful: ${url}`);
    return url;
  } catch (err) {
    console.error("S3 PDF Upload Error:", err);
    throw err;
  }
};

/**
 * Uploads a document (PDF, image, or DOCX) to S3
 * @param {Object} file - File object with buffer, mimetype, and originalname
 * @param {string} folderName - Folder name in S3 bucket
 * @returns {Promise<string>} - S3 URL of uploaded file
 */
const uploadDocumentToS3 = async (file, folderName) => {
  // Get original file extension from originalname or infer from mimetype
  let originalExt = path.extname(file.originalname || '');
  
  // If no extension in originalname, infer from mimetype
  if (!originalExt) {
    const mimeToExt = {
      'application/pdf': '.pdf',
      'image/jpeg': '.jpg',
      'image/jpg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
      'application/msword': '.doc'
    };
    originalExt = mimeToExt[file.mimetype] || '.pdf';
  }
  
  // Generate random filename
  const randomString = crypto.randomBytes(16).toString("hex");
  const filename = `${randomString}${originalExt}`;
  const bucket = process.env.AWS_BUCKET_NAME;
  const key = `${folderName}/${filename}`;

  console.log(`Uploading document ${filename} to S3...`);

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: file?.buffer,
    ContentType: file?.mimetype || 'application/pdf',
  });

  try {
    await s3.send(command);
    const url = `https://${bucket}.s3.ca-central-1.amazonaws.com/${key}`;
    console.log(`Document upload successful: ${url}`);
    return url;
  } catch (err) {
    console.error("S3 Document Upload Error:", err);
    throw err;
  }
};

/**
 * Uploads a video or image file to S3 (preserves original extension)
 * @param {Object} file - File object with buffer, mimetype, and originalname
 * @param {string} folderName - Folder name in S3 bucket
 * @returns {Promise<string>} - S3 URL of uploaded file
 */
const uploadMediaToS3 = async (file, folderName) => {
  // Get original file extension from originalname or infer from mimetype
  let originalExt = path.extname(file.originalname || '');
  
  // If no extension in originalname, infer from mimetype
  if (!originalExt) {
    const mimeToExt = {
      'image/jpeg': '.jpg',
      'image/jpg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'video/mp4': '.mp4',
      'video/mpeg': '.mpeg',
      'video/quicktime': '.mov',
      'video/x-msvideo': '.avi',
      'video/webm': '.webm'
    };
    originalExt = mimeToExt[file.mimetype] || '.mp4';
  }
  
  // Generate random filename
  const randomString = crypto.randomBytes(16).toString("hex");
  const filename = `${randomString}${originalExt}`;
  const bucket = process.env.AWS_BUCKET_NAME;
  const key = `${folderName}/${filename}`;

  console.log(`Uploading media ${filename} to S3...`);

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: file?.buffer,
    ContentType: file?.mimetype || 'video/mp4',
  });

  try {
    await s3.send(command);
    const url = `https://${bucket}.s3.ca-central-1.amazonaws.com/${key}`;
    console.log(`Media upload successful: ${url}`);
    return url;
  } catch (err) {
    console.error("S3 Media Upload Error:", err);
    throw err;
  }
};

/**
 * Deletes an image from S3 given its full URL
 * @param {string} imageUrl - The full URL of the image (e.g. https://your-bucket.s3.ca-central-1.amazonaws.com/folder/file.png)
 */
const deleteFromS3 = async (imageUrl) => {
  try {
    const bucket = process.env.AWS_BUCKET_NAME;

    // Extract the S3 object key from the full URL
    const urlPrefix = `https://${bucket}.s3.ca-central-1.amazonaws.com/`;
    const key = imageUrl.replace(urlPrefix, "");
    
    // Only delete if the image is from your bucket
    if (!imageUrl.startsWith(urlPrefix)) {
      console.log("Skipping delete — image is not from S3:", urlPrefix);
      return true;
    }
    if (!key || key.includes("https://")) {
      throw new Error("Invalid image URL or bucket mismatch.");
    }

    const command = new DeleteObjectCommand({
      Bucket: bucket,
      Key: key
    });

    await s3.send(command);
    console.log(`Deleted successfully: ${key}`);
    return true;
  } catch (err) {
    console.error("S3 Delete Error:", err);
    throw err;
  }
};

module.exports =  {
  uploadToS3,
  uploadPDFToS3,
  uploadDocumentToS3,
  uploadMediaToS3,
  deleteFromS3
};
