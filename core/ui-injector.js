'use strict';
/* FaceitExt UI injector – injects the manager button + modal into faceit.com web views. */
const fs = require('fs');
const path = require('path');

const UI = path.join(__dirname, 'ui');
const read = f => fs.readFileSync(path.join(UI, f), 'utf8');
const isFaceit = url => { try { return /(^|\.)faceit\.com$/i.test(new URL(url).hostname); } catch { return false; } };

function buildScript() {
  // read on every injection so UI edits apply without restarting FACEIT
  return `(function(){
    if (document.getElementById('faceit-ext-host')) return;
    window.__FACEIT_EXT_UI__ = { html: ${JSON.stringify(read('manager.html'))}, css: ${JSON.stringify(read('manager.css'))} };
    ${read('manager.js')}
  })();`;
}

function attachUi(wc, log = console.log) {
  const inject = () => {
    if (wc.isDestroyed() || !isFaceit(wc.getURL())) return;
    wc.executeJavaScript(buildScript(), true).catch(e => log('UI inject error', e.message));
  };
  wc.on('did-finish-load', inject);
  wc.on('did-navigate-in-page', inject); // SPA navigation can wipe body children
}

module.exports = { attachUi, isFaceit };
