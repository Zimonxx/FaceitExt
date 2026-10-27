'use strict';
/*
 * FaceitExt loader – required from FACEIT's main.js by the bootstrap line.
 * Runs in the Electron MAIN process of the FACEIT social client only.
 * It never touches FACEIT AC, FACEIT_AC.sys or cs2.exe.
 */
const { app, session, ipcMain, dialog, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const crx = require('./crx-manager');
const { attachUi } = require('./ui-injector');

const ROOT = crx.ROOT;
const EXT_DIR = crx.INSTALLED;
const CONFIG = path.join(ROOT, 'config.json');
const LOG = path.join(ROOT, 'loader.log');

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.map(x => x instanceof Error ? x.stack : typeof x === 'object' ? JSON.stringify(x) : x).join(' ')}\n`;
  try { fs.appendFileSync(LOG, line); } catch {}
  console.log('[FaceitExt]', ...a);
}

function loadConfig() {
  try { const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); c.extensions ||= []; return c; }
  catch { return { extensions: [] }; }
}
function saveConfig(c) { fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2)); }

/* ---------- session handling (FACEIT may use non-default partitions) ---------- */
const sessions = new Set();
const loaded = new Map(); // `${sessionKey}|${ourId}` -> electron extension id
const sKey = s => (sessions.has(s) ? [...sessions].indexOf(s) : -1);

const api = s => s.extensions && s.extensions.loadExtension ? s.extensions : s; // Electron >= 36 vs older

async function loadInto(s, ext) {
  const k = `${sKey(s)}|${ext.id}`;
  if (loaded.has(k)) return;
  const dir = path.join(EXT_DIR, ext.id);
  if (!fs.existsSync(dir)) return;
  try {
    const e = await api(s).loadExtension(dir, { allowFileAccess: true });
    loaded.set(k, e.id);
    log(`Załadowano rozszerzenie: ${ext.name} (${e.id})`);
  } catch (err) { log(`Błąd ładowania ${ext.id}:`, err); }
}

function unloadFrom(s, ext) {
  const k = `${sKey(s)}|${ext.id}`;
  const eid = loaded.get(k);
  if (!eid) return;
  try { api(s).removeExtension(eid); } catch (e) { log('removeExtension', e); }
  loaded.delete(k);
}

async function registerSession(s) {
  if (!s || sessions.has(s)) return;
  sessions.add(s);
  const preload = path.join(__dirname, 'preload.js');
  try {
    if (s.registerPreloadScript) s.registerPreloadScript({ type: 'frame', filePath: preload, id: 'faceit-ext' });
    else s.setPreloads([...s.getPreloads(), preload]);
  } catch (e) { log('preload register', e); }
  for (const ext of loadConfig().extensions) if (ext.enabled) await loadInto(s, ext);
}

const forAll = fn => Promise.all([...sessions].map(fn));

/* ---------- metadata ---------- */
function listExtensions() {
  return loadConfig().extensions.map(ext => {
    let manifest = {};
    try { manifest = crx.readManifest(path.join(EXT_DIR, ext.id)); } catch {}
    let icon = null;
    const icons = manifest.icons || {};
    const best = Object.keys(icons).sort((a, b) => b - a)[0];
    if (best) {
      try {
        const f = path.join(EXT_DIR, ext.id, icons[best]);
        icon = `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;
      } catch {}
    }
    return { ...ext, version: manifest.version, description: manifest.description, manifestVersion: manifest.manifest_version, icon,
      loaded: [...loaded.keys()].some(k => k.endsWith('|' + ext.id)) };
  });
}

async function register(result, source) {
  const c = loadConfig();
  const entry = { id: result.id, name: result.manifest.name || result.id, enabled: true, source, installedAt: new Date().toISOString() };
  const i = c.extensions.findIndex(e => e.id === result.id);
  if (i >= 0) { await forAll(s => unloadFrom(s, c.extensions[i])); c.extensions[i] = { ...c.extensions[i], ...entry }; }
  else c.extensions.push(entry);
  saveConfig(c);
  await forAll(s => loadInto(s, entry));
  return listExtensions();
}

/* ---------- IPC ---------- */
const wrap = fn => async (_e, ...args) => {
  try { return { ok: true, data: await fn(...args) }; }
  catch (err) { log('IPC error', err); return { ok: false, error: err.message || String(err) }; }
};

function setupIpc() {
  ipcMain.handle('faceit-ext:get-list', wrap(() => listExtensions()));
  ipcMain.handle('faceit-ext:install-store', wrap(async url => register(await crx.installFromStore(url), url)));
  ipcMain.handle('faceit-ext:install-zip', wrap(async p => register(crx.installFromZip(p), 'zip:' + path.basename(p))));
  ipcMain.handle('faceit-ext:pick-zip', wrap(async () => {
    const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), {
      title: 'Wybierz paczkę rozszerzenia', properties: ['openFile'],
      filters: [{ name: 'Rozszerzenia Chrome', extensions: ['zip', 'crx'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  }));
  ipcMain.handle('faceit-ext:toggle', wrap(async (id, enabled) => {
    const c = loadConfig();
    const ext = c.extensions.find(e => e.id === id);
    if (!ext) throw new Error('Nie znaleziono rozszerzenia');
    ext.enabled = !!enabled;
    saveConfig(c);
    await forAll(s => (enabled ? loadInto(s, ext) : unloadFrom(s, ext)));
    return listExtensions();
  }));
  ipcMain.handle('faceit-ext:remove', wrap(async id => {
    const c = loadConfig();
    const ext = c.extensions.find(e => e.id === id);
    if (ext) await forAll(s => unloadFrom(s, ext));
    c.extensions = c.extensions.filter(e => e.id !== id);
    saveConfig(c);
    fs.rmSync(path.join(EXT_DIR, id), { recursive: true, force: true });
    return listExtensions();
  }));
  ipcMain.handle('faceit-ext:reload-page', wrap(() => {
    for (const w of BrowserWindow.getAllWindows()) if (/faceit\.com/.test(w.webContents.getURL())) w.webContents.reload();
  }));
}

/* ---------- boot ---------- */
(function boot() {
  if (global.__faceitExtLoaded) return;
  global.__faceitExtLoaded = true;
  fs.mkdirSync(EXT_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG)) saveConfig({ extensions: [] });
  log(`Loader start – FACEIT ${app.getVersion()}, Electron ${process.versions.electron}`);

  setupIpc();
  app.on('session-created', s => { registerSession(s); });
  app.on('web-contents-created', (_e, wc) => { registerSession(wc.session); attachUi(wc, log); });
  app.whenReady().then(() => registerSession(session.defaultSession)).catch(e => log('whenReady', e));
})();

module.exports = { loadConfig, listExtensions };
