const multer = require('multer');
const path = require('path');
const fs = require('fs');

// config/multer.config.js
const storage = multer.memoryStorage();

const upload = multer({ storage,
  limits: { fileSize: 500 * 1024 * 1024 } // Limit 500MB
 });

/**
 * Single-file upload for lead files with a hard size cap. An oversized file gets a clear 413 JSON answer instead of a
 * generic failure. Keep the cap in step with the limit shown in the app and with nginx's client_max_body_size.
 */
const leadFileUpload = (maxMb) => {
  const single = multer({ storage, limits: { fileSize: maxMb * 1024 * 1024 } }).single('file');
  return (req, res, next) => {
    single(req, res, (error) => {
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          success: false,
          message: `That file is larger than the ${maxMb} MB limit. Split it into smaller files and upload them one at a time.`,
          code: 'LEAD_FILE_TOO_LARGE',
          data: null,
        });
      }
      return next(error);
    });
  };
};

const saveFileToDisk = (file) => {
  const uploadsDir = path.join(__dirname, '../uploads');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

  const filename = Date.now() + '_' + file.originalname;
  const filepath = path.join(uploadsDir, filename);

  fs.writeFileSync(filepath, file.buffer);
  return `/uploads/${filename}`;
};

module.exports = {
  upload,
  leadFileUpload,
  saveFileToDisk
}
