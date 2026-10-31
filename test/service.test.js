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

describe('composition service (stub composer)', () => {
  let server;
  let base;
  let root;

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'card-composer-'));
    const config = loadConfig({ IDS_ROOT: root, PORT: '0' });
    for (const d of Object.values(config.dirs)) fs.mkdirSync(d, { recursive: true });
    server = createServer(config, createComposer(config));
    await new Promise((r) => server.listen(0, r));
    base = `http://localhost:${server.address().port}`;
    config.publicBaseUrl = base;
  });

  after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const post = (p, body) =>
    fetch(base + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('/proof returns a fetchable PNG url', async () => {
    const res = await post('/proof', { templateId: 'bizcard', version: '1', fields });
    assert.equal(res.status, 200);
    const { proofUrl } = await res.json();
    const img = await fetch(proofUrl);
    assert.equal(img.headers.get('content-type'), 'image/png');
    const buf = Buffer.from(await img.arrayBuffer());
    assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  });

  it('/proof is stable for identical input', async () => {
    const body = { templateId: 'bizcard', version: '1', fields };
    const a = await (await post('/proof', body)).json();
    const b = await (await post('/proof', body)).json();
    assert.equal(a.proofUrl, b.proofUrl);
  });

  it('/proof returns too_long with the offending field', async () => {
    const res = await post('/proof', {
      templateId: 'bizcard',
      version: '1',
      fields: { ...fields, title: 'x'.repeat(200) },
    });
    assert.equal(res.status, 422);
    assert.deepEqual(await res.json(), { error: 'too_long', field: 'title' });
  });

  it('/render writes the PDF and an SFTP copy named <orderNo>-<lineId>-<templateId>.pdf', async () => {
    const res = await post('/render', {
      orderNo: 'SO1001',
      lineId: '1',
      templateId: 'bizcard',
      version: '1',
      fields,
    });
    assert.equal(res.status, 200);
    const { pdfUrl, sftpPath } = await res.json();
    assert.equal(sftpPath, '/SO1001-1-bizcard.pdf');
    assert.ok(fs.existsSync(path.join(root, 'sftp', 'SO1001-1-bizcard.pdf')));
    const pdf = Buffer.from(await (await fetch(pdfUrl)).arrayBuffer());
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  });

  it('rejects missing fields and unsafe ids with 400', async () => {
    const missing = await post('/proof', { templateId: 'bizcard', version: '1', fields: { name: 'x' } });
    assert.equal(missing.status, 400);
    const unsafe = await post('/render', {
      orderNo: '../evil',
      lineId: '1',
      templateId: 'bizcard',
      version: '1',
      fields,
    });
    assert.equal(unsafe.status, 400);
    const bad = await post('/proof', '{not json');
    assert.equal(bad.status, 400);
  });

  it('does not serve files outside the output folders', async () => {
    const res = await fetch(`${base}/files/proofs/..%2f..%2fetc%2fpasswd`);
    assert.equal(res.status, 404);
    const dot = await fetch(`${base}/files/proofs/..`);
    assert.equal(dot.status, 404);
  });
});
