'use strict';
/* FaceitExt – Chrome Web Store / CRX / ZIP handling (no external deps). */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');

const ROOT = path.join(process.env.APPDATA, 'FaceitExtensions');
const INSTALLED = path.join(ROOT, 'installed');

function extractId(input) {
  const m = String(input).match(/(?:^|[\/?=])([a-p]{32})(?:$|[\/?#&])/i) || String(input).match(/[a-p]{32}/i);
  if (!m) throw new Error('Nie znaleziono 32-znakowego ID rozszerzenia w podanym adresie.');
  return (m[1] || m[0]).toLowerCase();
}

function download(url, redirects = 8) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/130.0.0.0' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (!redirects) return reject(new Error('Za dużo przekierowań'));
        return resolve(download(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function crxToZip(buf) {
  if (buf.readUInt32LE(0) === 0x04034b50) return buf; // already a zip
  if (buf.toString('ascii', 0, 4) !== 'Cr24') throw new Error('Nieprawidłowy plik CRX (brak Cr24)');
  const version = buf.readUInt32LE(4);
  if (version === 3) return buf.subarray(12 + buf.readUInt32LE(8));
  if (version === 2) return buf.subarray(16 + buf.readUInt32LE(8) + buf.readUInt32LE(12));
  throw new Error('Nieobsługiwana wersja CRX: ' + version);
}

/* Minimal ZIP extractor (stored + deflate) based on the central directory. */
function unzip(buf, dest) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Uszkodzone archiwum ZIP');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const root = path.resolve(dest);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Błąd katalogu ZIP');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), comLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
    p += 46 + nameLen + extraLen + comLen;

    const out = path.resolve(root, name);
    if (!out.startsWith(root + path.sep) && out !== root) throw new Error('Niebezpieczna ścieżka w ZIP: ' + name);
    if (name.endsWith('/')) { fs.mkdirSync(out, { recursive: true }); continue; }
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!data) throw new Error('Nieobsługiwana kompresja ZIP: ' + method);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
  }
}

/* If manifest.json sits in a single sub-folder (common for GitHub zips), return that folder. */
function findManifestRoot(dir, depth = 0) {
  if (fs.existsSync(path.join(dir, 'manifest.json'))) return dir;
  if (depth > 2) return null;
  for (const d of fs.readdirSync(dir, { withFileTypes: true }))
    if (d.isDirectory()) { const r = findManifestRoot(path.join(dir, d.name), depth + 1); if (r) return r; }
  return null;
}

function readManifest(dir) {
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
  // resolve __MSG_name__ placeholders
  const resolve = v => {
    const k = /^__MSG_(.+)__$/.exec(v || '');
    if (!k) return v;
    const loc = m.default_locale || 'en';
    try {
      const msgs = JSON.parse(fs.readFileSync(path.join(dir, '_locales', loc, 'messages.json'), 'utf8').replace(/^\uFEFF/, ''));
      const hit = Object.entries(msgs).find(([key]) => key.toLowerCase() === k[1].toLowerCase());
      return hit ? hit[1].message : v;
    } catch { return v; }
  };
  return { ...m, name: resolve(m.name), description: resolve(m.description) };
}

function installBuffer(buf, id) {
  const zip = crxToZip(buf);
  const dest = path.join(INSTALLED, id);
  const tmp = dest + '.tmp-' + Date.now();
  fs.mkdirSync(tmp, { recursive: true });
  try {
    unzip(zip, tmp);
    const mroot = findManifestRoot(tmp);
    if (!mroot) throw new Error('Brak manifest.json w paczce');
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(mroot, dest);
    if (mroot !== tmp) fs.rmSync(tmp, { recursive: true, force: true });
    // Chrome writes these on install; Electron refuses dirs whose names start with "_" except known ones
    fs.rmSync(path.join(dest, '_metadata'), { recursive: true, force: true });
    return { id, dir: dest, manifest: readManifest(dest) };
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

async function installFromStore(url) {
  const id = extractId(url);
  const crxUrl = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=130.0.0.0&acceptformat=crx2,crx3&x=id%3D${id}%26uc`;
  const buf = await download(crxUrl);
  if (buf.length < 16) throw new Error('Pusta odpowiedź z Chrome Web Store (rozszerzenie niedostępne?)');
  return installBuffer(buf, id);
}

function installFromZip(zipPath) {
  const buf = fs.readFileSync(zipPath);
  const base = path.basename(zipPath).replace(/\.(zip|crx)$/i, '');
  const id = /^[a-p]{32}$/i.test(base) ? base.toLowerCase()
    : 'local-' + base.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) + '-' + Date.now().toString(36);
  return installBuffer(buf, id);
}

module.exports = { extractId, installFromStore, installFromZip, installBuffer, readManifest, INSTALLED, ROOT };
