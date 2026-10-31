'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const http = require('http');
const path = require('path');
const { TooLongError, UnknownTemplateError } = require('./composers');

const FIELDS = ['name', 'title', 'phone', 'email', 'dept'];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/; // ends up in file names, so keep it tight
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_BODY = 64 * 1024;

class BadRequest extends Error {}

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isBuf ? headers['Content-Type'] : 'application/json',
    ...headers,
  });
  res.end(isBuf ? body : JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new BadRequest('body too large');
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BadRequest('body is not valid JSON');
  }
}

function requireStr(obj, key, re) {
  const v = obj[key];
  if (typeof v !== 'string' || v === '') throw new BadRequest(`${key} is required`);
  if (re && !re.test(v)) throw new BadRequest(`${key} has invalid characters or length`);
  return v;
}

function parseCompose(body, extraKeys = []) {
  if (!body || typeof body !== 'object') throw new BadRequest('body must be an object');
  const out = {};
  for (const k of extraKeys) out[k] = requireStr(body, k, ID_RE);
  out.templateId = requireStr(body, 'templateId', ID_RE);
  out.version = requireStr(body, 'version');
  if (!body.fields || typeof body.fields !== 'object') throw new BadRequest('fields is required');
  out.fields = {};
  for (const f of FIELDS) {
    if (typeof body.fields[f] !== 'string') throw new BadRequest(`fields.${f} must be a string`);
    out.fields[f] = body.fields[f];
  }
  return out;
}

function createServer(config, composer) {
  const url = (kind, name) => `${config.publicBaseUrl}/files/${kind}/${name}`;

  async function proof(req, res) {
    const p = parseCompose(await readJson(req));
    const hash = crypto.createHash('sha1').update(JSON.stringify(p)).digest('hex').slice(0, 20);
    const name = `${p.templateId}-${hash}.png`;
    await composer.proof(p, path.join(config.dirs.proofs, name));
    send(res, 200, { proofUrl: url('proofs', name) });
  }

  async function render(req, res) {
    const p = parseCompose(await readJson(req), ['orderNo', 'lineId']);
    const name = `${p.orderNo}-${p.lineId}-${p.templateId}.pdf`;
    const printPath = path.join(config.dirs.print, name);
    await composer.render(p, printPath);
    await fs.copyFile(printPath, path.join(config.dirs.sftp, name));
    send(res, 200, { pdfUrl: url('print', name), sftpPath: `${config.sftpPathPrefix}${name}` });
  }

  async function serveFile(kind, name, res) {
    const dir = kind === 'proofs' ? config.dirs.proofs : config.dirs.print;
    if (!FILE_RE.test(name)) return send(res, 404, { error: 'not_found' });
    try {
      const data = await fs.readFile(path.join(dir, name));
      const type = name.endsWith('.png') ? 'image/png' : 'application/pdf';
      send(res, 200, data, { 'Content-Type': type });
    } catch {
      send(res, 404, { error: 'not_found' });
    }
  }

  return http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && pathname === '/health') {
        return send(res, 200, { ok: true, composer: config.composer });
      }
      if (req.method === 'POST' && pathname === '/proof') return await proof(req, res);
      if (req.method === 'POST' && pathname === '/render') return await render(req, res);
      const m = req.method === 'GET' && pathname.match(/^\/files\/(proofs|print)\/([^/]+)$/);
      if (m) return await serveFile(m[1], m[2], res);
      send(res, 404, { error: 'not_found' });
    } catch (err) {
      if (err instanceof TooLongError) return send(res, 422, { error: 'too_long', field: err.field });
      if (err instanceof BadRequest || err instanceof UnknownTemplateError) {
        return send(res, 400, { error: 'invalid_request', detail: err.message });
      }
      console.error(err);
      send(res, 500, { error: 'internal_error' });
    }
  });
}

module.exports = { createServer };
