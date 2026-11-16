const { readFileSync } = require('node:fs');
const path = require('node:path');

// VERSION (repo root) is the release version, four parts: MAJOR.MINOR.PATCH.BUILD. Every deploy bumps the last one.
// It must ship with the deployed files, or this reports "unknown".
const APP_VERSION = (() => {
  try { return readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim() || 'unknown'; }
  catch { return 'unknown'; }
})();

module.exports = { APP_VERSION };
