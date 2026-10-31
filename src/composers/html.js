'use strict';

const { spawn } = require('child_process');
const fsSync = require('fs');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { TooLongError, UnknownTemplateError } = require('./index');

// Renders templates/<templateId>/<version>/card.html in headless Chrome. The template does its own copyfit and reports overflow
// through body[data-overflow]. One Chrome stays running and is driven over the
// DevTools protocol, because launching Chrome per request costs ~5s here.

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BUNDLED_TEMPLATES = path.join(__dirname, '..', '..', 'templates');
const TIMEOUT_MS = 30000;
const PROOF_VIEWPORT = { width: 336, height: 192 }; // 3.5x2in trim at 96 css px/in
const PROOF_SCALE = 3.125; // 96 * 3.125 = 300 dpi -> 1050x600 PNG

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p.resolve(msg.result);
      } else {
        for (const l of this.listeners) l(msg);
      }
    });
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('Chrome connection closed'));
      this.pending.clear();
    });
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, TIMEOUT_MS);
      this.pending.set(id, {
        method,
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  waitEvent(sessionId, method) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`${method} timed out`));
      }, TIMEOUT_MS);
      const listener = (msg) => {
        if (msg.method !== method || msg.sessionId !== sessionId) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(msg.params);
      };
      this.listeners.add(listener);
    });
  }
}

async function launchBrowser(chromePath) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chrome-'));
  const proc = spawn(chromePath, [
    '--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', `--user-data-dir=${dir}`, '--remote-debugging-port=0', 'about:blank',
  ], { stdio: 'ignore' });
  let failure = null;
  proc.once('error', (err) => { failure = err; });
  proc.once('exit', () => { failure = failure || new Error('Chrome exited during startup'); });

  try {
    // Chrome writes the chosen port and browser WebSocket path here once it is listening.
    const portFile = path.join(dir, 'DevToolsActivePort');
    const deadline = Date.now() + TIMEOUT_MS;
    let info = null;
    while (!info) {
      if (failure) throw failure;
      if (Date.now() > deadline) throw new Error('Chrome did not start in time');
      try {
        const lines = (await fs.readFile(portFile, 'utf8')).trim().split('\n');
        if (lines.length >= 2) info = lines;
      } catch {
        // not written yet
      }
      if (!info) await sleep(50);
    }
    const ws = new WebSocket(`ws://127.0.0.1:${info[0]}${info[1]}`);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('could not connect to Chrome DevTools')), { once: true });
    });
    return { proc, dir, cdp: new Cdp(ws) };
  } catch (err) {
    proc.kill();
    await fs.rm(dir, { recursive: true, force: true });
    throw err;
  }
}

async function loadTemplate(templatesDir, templateId, version) {
  if (!SAFE.test(templateId) || !SAFE.test(version)) throw new UnknownTemplateError(templateId, version);
  for (const dir of [templatesDir, BUNDLED_TEMPLATES]) {
    try {
      return await fs.readFile(path.join(dir, templateId, version, 'card.html'), 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  throw new UnknownTemplateError(templateId, version);
}

function createHtmlComposer(config) {
  const chromePath = config.chromePath;
  if (path.isAbsolute(chromePath) && !fsSync.existsSync(chromePath)) {
    throw new Error(`Chrome not found at ${chromePath}; set CHROME_PATH`);
  }

  let browserP = null;
  let current = null;

  // Started on first use and restarted if Chrome dies.
  function getBrowser() {
    if (!browserP) {
      browserP = launchBrowser(chromePath).then((b) => {
        current = b;
        b.proc.once('exit', () => {
          if (current === b) { current = null; browserP = null; }
          fs.rm(b.dir, { recursive: true, force: true }).catch(() => {});
        });
        return b;
      });
      browserP.catch(() => { browserP = null; });
    }
    return browserP;
  }

  process.once('exit', () => { if (current) current.proc.kill(); });

  async function compose(mode, { templateId, version, fields }, outPath) {
    const template = await loadTemplate(config.dirs.templates, templateId, version);
    // "<" escaped so a field value can never close the script tag.
    const data = JSON.stringify({ mode, fields }).replace(/</g, '\\u003c');
    const page = template.replace('<!--CARD_DATA-->', `<script>window.CARD=${data}</script>`);

    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'card-'));
    let cdp = null;
    let targetId = null;
    try {
      const file = path.join(work, 'card.html');
      await fs.writeFile(file, page);
      ({ cdp } = await getBrowser());
      ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await cdp.send('Page.enable', {}, sessionId);
      const loaded = cdp.waitEvent(sessionId, 'Page.loadEventFired');
      await cdp.send('Page.navigate', { url: pathToFileURL(file).href }, sessionId);
      await loaded;

      const { result } = await cdp.send('Runtime.evaluate', {
        expression: "document.body.getAttribute('data-overflow')",
        returnByValue: true,
      }, sessionId);
      if (typeof result.value !== 'string') throw new Error('template did not report copyfit (data-overflow missing)');
      if (result.value) throw new TooLongError(result.value.split(',')[0]);

      let out;
      if (mode === 'proof') {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          ...PROOF_VIEWPORT, deviceScaleFactor: PROOF_SCALE, mobile: false,
        }, sessionId);
        out = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      } else {
        out = await cdp.send('Page.printToPDF', {
          preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false,
        }, sessionId);
      }
      await fs.writeFile(outPath, Buffer.from(out.data, 'base64'));
    } finally {
      if (cdp && targetId) await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
      await fs.rm(work, { recursive: true, force: true });
    }
  }

  return {
    proof: (req, outPath) => compose('proof', req, outPath),
    render: (req, outPath) => compose('print', req, outPath),
    async warm() {
      await getBrowser();
    },
    async close() {
      const b = current;
      current = null;
      browserP = null;
      if (b) b.proc.kill();
    },
  };
}

module.exports = { createHtmlComposer };
