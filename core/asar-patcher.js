'use strict';
process.noAsar = true; // Electron's fs would otherwise treat app.asar as a directory
/*
 * FaceitExt asar patcher (no dependencies).
 * Usage: node asar-patcher.js [path\to\app.asar] [--force] [--unpatch]
 *   or : set ELECTRON_RUN_AS_NODE=1 && FACEIT.exe asar-patcher.js <asar>
 *
 * Strategy: append a new "main.js" (bootstrap + original main.js) at the end of the
 * asar data section and repoint the header entry. Original bytes stay untouched,
 * app.asar.unpacked is untouched. A zero-size marker entry is added to the header so
 * the launcher can detect the patch by reading only the header.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MARKER = 'FACEIT-EXT-BOOTSTRAP';
const MARKER_FILE = 'faceit-ext-bootstrap.marker';
const BOOTSTRAP =
  `/* ${MARKER} */\n` +
  `try { require(require('path').join(process.env.APPDATA, 'FaceitExtensions', 'core', 'loader.js')); } catch (e) { console.error('[FaceitExt] bootstrap failed', e); }\n`;

function readAsar(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const headerSize = head.readUInt32LE(4);       // pickle payload size of header
  const jsonLen = head.readUInt32LE(12);
  const hbuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, hbuf, 0, jsonLen, 16);
  fs.closeSync(fd);
  return { header: JSON.parse(hbuf.toString('utf8')), dataOffset: 8 + headerSize };
}

function isPatched(file) {
  try { return !!readAsar(file).header.files[MARKER_FILE]; } catch { return false; }
}

function integrityOf(buf) {
  const blockSize = 4 * 1024 * 1024;
  const blocks = [];
  for (let i = 0; i < buf.length; i += blockSize)
    blocks.push(crypto.createHash('sha256').update(buf.subarray(i, i + blockSize)).digest('hex'));
  if (!blocks.length) blocks.push(crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
  return { algorithm: 'SHA256', hash: crypto.createHash('sha256').update(buf).digest('hex'), blockSize, blocks };
}

function encodeHeader(header) {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const pad = (4 - (json.length % 4)) % 4;
  const payload = Buffer.alloc(8 + json.length + pad);
  payload.writeUInt32LE(4 + json.length + pad, 0); // pickle payload size
  payload.writeUInt32LE(json.length, 4);            // string length
  json.copy(payload, 8);
  const sizePickle = Buffer.alloc(8);
  sizePickle.writeUInt32LE(4, 0);
  sizePickle.writeUInt32LE(payload.length, 4);
  return Buffer.concat([sizePickle, payload]);
}

function getMainName(header, file, dataOffset) {
  const pj = header.files['package.json'];
  if (!pj) return 'main.js';
  const fd = fs.openSync(file, 'r');
  const b = Buffer.alloc(pj.size);
  fs.readSync(fd, b, 0, pj.size, dataOffset + Number(pj.offset));
  fs.closeSync(fd);
  return (JSON.parse(b.toString('utf8')).main || 'main.js').replace(/^\.\//, '');
}

function patch(file, { force = false } = {}) {
  if (isPatched(file) && !force) return { patched: false, reason: 'already-patched' };
  const raw = fs.readFileSync(file);
  const { header, dataOffset } = readAsar(file);
  const mainName = getMainName(header, file, dataOffset);
  const parts = mainName.split('/');
  let node = header;
  for (const p of parts.slice(0, -1)) node = node.files[p];
  const entry = node.files[parts.at(-1)];
  if (!entry || entry.unpacked) throw new Error('main entry not found: ' + mainName);

  const original = raw.subarray(dataOffset + Number(entry.offset), dataOffset + Number(entry.offset) + entry.size);
  if (original.includes(MARKER) && !force) return { patched: false, reason: 'already-patched' };
  const newMain = Buffer.concat([Buffer.from(BOOTSTRAP), original]);
  const data = raw.subarray(dataOffset);
  const newOffset = data.length;

  node.files[parts.at(-1)] = { ...entry, offset: String(newOffset), size: newMain.length, integrity: integrityOf(newMain) };
  header.files[MARKER_FILE] = { size: 0, offset: '0' };

  const backup = file + '.faceitext.bak';
  if (!fs.existsSync(backup) || !isPatched(file)) fs.copyFileSync(file, backup);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, Buffer.concat([encodeHeader(header), data, newMain]));
  fs.renameSync(tmp, file);
  return { patched: true, main: mainName };
}

function unpatch(file) {
  const backup = file + '.faceitext.bak';
  if (!fs.existsSync(backup)) throw new Error('no backup found');
  fs.copyFileSync(backup, file);
  fs.unlinkSync(backup);
}

function findLatestAsar() {
  const root = path.join(process.env.LOCALAPPDATA, 'FACEIT');
  const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number);
    for (let i = 0; i < 4; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
  const dirs = fs.readdirSync(root).filter(d => /^app-\d/.test(d)).sort((a, b) => cmp(a.slice(4), b.slice(4)));
  if (!dirs.length) throw new Error('FACEIT not found in ' + root);
  return path.join(root, dirs.at(-1), 'resources', 'app.asar');
}

module.exports = { patch, unpatch, isPatched, findLatestAsar, MARKER };

if (require.main === module) {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--')) || findLatestAsar();
  try {
    if (args.includes('--unpatch')) { unpatch(file); console.log('[FaceitExt] restored', file); }
    else console.log('[FaceitExt]', JSON.stringify(patch(file, { force: args.includes('--force') })), file);
  } catch (e) { console.error('[FaceitExt] patch error:', e.message); process.exit(1); }
}
