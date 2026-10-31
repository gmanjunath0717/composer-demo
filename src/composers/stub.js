'use strict';

const fs = require('fs/promises');
const zlib = require('zlib');
const { TooLongError } = require('./index');

const FIELDS = ['name', 'title', 'phone', 'email', 'dept'];

function checkFit(fields, limits) {
  for (const f of FIELDS) {
    if (String(fields[f]).length > limits[f]) throw new TooLongError(f);
  }
}

// --- PNG (RGB, no dependencies) -------------------------------------------

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// 3.5x2in card at 300dpi: a white card with one bar per field, bar width
// proportional to text length, plus a red "stub" strip.
function stubCardPng(fields) {
  const w = 1050;
  const h = 600;
  const px = Buffer.alloc(w * h * 3, 255);
  const rect = (x0, y0, x1, y1, [r, g, b]) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 3;
        px[i] = r;
        px[i + 1] = g;
        px[i + 2] = b;
      }
    }
  };
  rect(0, 0, w, 6, [120, 120, 120]);
  rect(0, h - 6, w, h, [120, 120, 120]);
  rect(0, 0, 6, h, [120, 120, 120]);
  rect(w - 6, 0, w, h, [120, 120, 120]);
  rect(0, 0, w, 24, [200, 40, 40]); // marks this as a stub proof
  FIELDS.forEach((f, i) => {
    const barW = Math.min(String(fields[f]).length * 18, w - 160);
    const y = 90 + i * 90;
    rect(80, y, 80 + Math.max(barW, 18), y + (f === 'name' ? 44 : 28), [40, 40, 40]);
  });
  return encodePng(w, h, px);
}

// --- PDF (hand-built, Helvetica text) -------------------------------------

function pdfText(s) {
  return String(s)
    .replace(/[^\x20-\x7e]/g, '?')
    .replace(/([\\()])/g, '\\$1');
}

function stubCardPdf(fields) {
  const lines = [
    ['STUB - NOT PRINT READY', 8],
    [fields.name, 14],
    [fields.title, 9],
    [fields.phone, 9],
    [fields.email, 9],
    [fields.dept, 9],
  ];
  let y = 125;
  const content = lines
    .map(([t, size]) => {
      const op = `BT /F1 ${size} Tf 18 ${y} Td (${pdfText(t)}) Tj ET`;
      y -= size + 8;
      return op;
    })
    .join('\n');

  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 252 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function createStubComposer(config) {
  return {
    async proof({ fields }, outPath) {
      checkFit(fields, config.fieldLimits);
      await fs.writeFile(outPath, stubCardPng(fields));
    },
    async render({ fields }, outPath) {
      checkFit(fields, config.fieldLimits);
      await fs.writeFile(outPath, stubCardPdf(fields));
    },
  };
}

module.exports = { createStubComposer };
