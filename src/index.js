'use strict';

const fs = require('fs');
const { loadConfig } = require('./config');
const { createComposer } = require('./composers');
const { createServer } = require('./server');

const config = loadConfig();
for (const dir of Object.values(config.dirs)) fs.mkdirSync(dir, { recursive: true });

// Binds all interfaces on PORT, plain HTTP: put TLS and access control in front.
const composer = createComposer(config);
createServer(config, composer).listen(config.port, () => {
  console.log(`composition service on :${config.port} (composer=${config.composer})`);
  console.log(`public base URL: ${config.publicBaseUrl}`);
  // Pay Chrome's startup cost now instead of on the first buyer's proof.
  if (composer.warm) composer.warm().then(() => console.log('composer ready'), (err) => console.error('composer warm-up failed:', err.message));
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (composer.close) await composer.close();
    process.exit(0);
  });
}
