'use strict';
/* FaceitExt preload bridge – exposes a minimal IPC API on faceit.com pages only. */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

if (/(^|\.)faceit\.com$/i.test(location.hostname) && window === window.top) {
  const call = (ch, ...a) => ipcRenderer.invoke('faceit-ext:' + ch, ...a);
  const bridge = {
    list: () => call('get-list'),
    installStore: url => call('install-store', url),
    installZip: p => call('install-zip', p),
    pickZip: () => call('pick-zip'),
    toggle: (id, on) => call('toggle', id, on),
    remove: id => call('remove', id),
    reloadPage: () => call('reload-page'),
    pathForFile: f => { try { return webUtils ? webUtils.getPathForFile(f) : f.path; } catch { return f && f.path; } },
  };
  try { contextBridge.exposeInMainWorld('faceitExt', bridge); }
  catch { window.faceitExt = bridge; } // contextIsolation disabled
}
