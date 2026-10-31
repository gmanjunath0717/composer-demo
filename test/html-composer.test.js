'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { after, before, describe, it } = require('node:test');
const { loadConfig } = require('../src/config');
const { createComposer } = require('../src/composers');
const { createServer } = require('../src/server');

const fields = {
  name: 'Jane Doe',
  title: 'Operations Manager',
  phone: '555-0100',
  email: 'jane@example.com',
  dept: 'Operations',
};

const chromeMissing = !fs.existsSync(loadConfig({}).chromePath) && !process.env.CHROME_PATH;

describe('composition service (html composer)', { skip: chromeMissing && 'Chrome not found' }, () => {
  let server;
  let composer;
  let base;
  let root;

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'card-composer-html-'));
    const config = loadConfig({ IDS_ROOT: root, PORT: '0', COMPOSER: 'html' });
    for (const d of Object.values(config.dirs)) fs.mkdirSync(d, { recursive: true });
    composer = createComposer(config);
    server = createServer(config, composer);
    await new Promise((r) => server.listen(0, r));
    base = `http://localhost:${server.address().port}`;
    config.publicBaseUrl = base;
  });

  after(async () => {
    server.close();
    await composer.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const post = (p, body) =>
    fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('/proof is a 1050x600 PNG (3.5x2in at 300dpi)', async () => {
    const res = await post('/proof', { templateId: 'bizcard', version: '1', fields });
    assert.equal(res.status, 200);
    const { proofUrl } = await res.json();
    const buf = Buffer.from(await (await fetch(proofUrl)).arrayBuffer());
    assert.equal(buf.readUInt32BE(16), 1050);
    assert.equal(buf.readUInt32BE(20), 600);
  });

  it('/render is a one-page 4.25x2.75in PDF (trim + bleed + slug)', async () => {
    const res = await post('/render', { orderNo: 'SO2001', lineId: '1', templateId: 'bizcard', version: '1', fields });
    assert.equal(res.status, 200);
    const { pdfUrl } = await res.json();
    const pdf = Buffer.from(await (await fetch(pdfUrl)).arrayBuffer()).toString('latin1');
    assert.ok(pdf.startsWith('%PDF-'));
    assert.match(pdf, /\/MediaBox\s*\[\s*0 0 306 198\s*\]/);
    assert.ok(fs.existsSync(path.join(root, 'sftp', 'SO2001-1-bizcard.pdf')));
  });

  it('shrinks long text to fit but reports too_long when the minimum size still overflows', async () => {
    const fits = await post('/proof', {
      templateId: 'bizcard',
      version: '1',
      fields: { ...fields, title: 'Senior Vice President of Global Operations and Supply Chain' },
    });
    assert.equal(fits.status, 200);

    const tooLong = await post('/proof', {
      templateId: 'bizcard',
      version: '1',
      fields: { ...fields, email: `${'x'.repeat(80)}@example.com` },
    });
    assert.equal(tooLong.status, 422);
    assert.deepEqual(await tooLong.json(), { error: 'too_long', field: 'email' });
  });

  it('treats field text as text, never markup', async () => {
    const res = await post('/proof', {
      templateId: 'bizcard',
      version: '1',
      fields: { ...fields, name: '</script><b>x</b>' },
    });
    assert.equal(res.status, 200);
  });

  it('rejects unknown or path-like templates with 400', async () => {
    for (const [templateId, version] of [['nope', '1'], ['bizcard', '9'], ['bizcard', '../1']]) {
      const res = await post('/proof', { templateId, version, fields });
      assert.equal(res.status, 400, `${templateId}/${version}`);
      assert.equal((await res.json()).error, 'invalid_request');
    }
  });
});
