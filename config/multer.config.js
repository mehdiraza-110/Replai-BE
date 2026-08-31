const multer = require('multer');
const path = require('path');
const fs = require('fs');

// config/multer.config.js
const storage = multer.memoryStorage();

const upload = multer({ storage,
  limits: { fileSize: 500 * 1024 * 1024 } // Limit 500MB
 });

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
  saveFileToDisk
}
