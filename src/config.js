'use strict';

const os = require('os');
const path = require('path');

function defaultChromePath(platform) {
  if (platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (platform === 'win32') return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  return 'google-chrome';
}

// All folders derive from IDS_ROOT (default ~/ids) so no path is OS-specific;
// set IDS_ROOT (or the individual *_DIR vars) to relocate them.
function loadConfig(env = process.env) {
  const root = env.IDS_ROOT || path.join(os.homedir(), 'ids');
  const port = Number(env.PORT || 3000);

  return {
    port,
    composer: env.COMPOSER || 'stub',
    chromePath: env.CHROME_PATH || defaultChromePath(process.platform),
    publicBaseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    dirs: {
      templates: env.TEMPLATES_DIR || path.join(root, 'templates'),
      proofs: env.PROOFS_DIR || path.join(root, 'output', 'proofs'),
      print: env.PRINT_DIR || path.join(root, 'output', 'print'),
      sftp: env.SFTP_DIR || path.join(root, 'sftp'),
    },
    // Prefix for the sftpPath returned by /render (the path as the SFTP user sees it).
    sftpPathPrefix: env.SFTP_PATH_PREFIX || '/',
    // Stub-only character limits; the html composer does real copyfit in the template.
    fieldLimits: { name: 30, title: 40, phone: 20, email: 40, dept: 40 },
  };
}

module.exports = { loadConfig };
