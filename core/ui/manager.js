/* FaceitExt manager UI logic – runs in the faceit.com page, talks to the loader via window.faceitExt (preload IPC bridge). */
(function () {
  const api = window.faceitExt;
  const tpl = window.__FACEIT_EXT_UI__;
  if (!api || !tpl || document.getElementById('faceit-ext-host')) return;

  // Trusted Types-safe HTML assignment
  let tt = null;
  try { tt = window.trustedTypes && trustedTypes.createPolicy('faceit-ext', { createHTML: s => s }); } catch (_) {}
  const html = s => (tt ? tt.createHTML(s) : s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const host = document.createElement('div');
  host.id = 'faceit-ext-host';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = tpl.css;
  root.appendChild(style);
  const wrap = document.createElement('div');
  wrap.innerHTML = html(tpl.html);
  root.appendChild(wrap);
  (document.body || document.documentElement).appendChild(host);

  const $ = id => root.getElementById(id);
  const overlay = $('fe-overlay'), list = $('fe-list'), status = $('fe-status');
  let busy = false;

  function setStatus(type, msg, spin) {
    if (!msg) { status.hidden = true; return; }
    status.hidden = false;
    status.className = 'fe-status ' + type;
    status.innerHTML = html((spin ? '<span class="fe-spin"></span>' : '') + esc(msg));
    if (type === 'ok') setTimeout(() => { if (status.textContent === msg) status.hidden = true; }, 4000);
  }

  function render(items) {
    $('fe-empty').hidden = items.length > 0;
    const on = items.filter(i => i.enabled).length;
    $('fe-badge').hidden = on === 0;
    $('fe-badge').textContent = on;
    list.innerHTML = html(items.map((e, i) => `
      <li class="fe-item ${e.enabled ? '' : 'off'}" data-id="${esc(e.id)}" style="animation-delay:${i * 30}ms">
        <div class="fe-ico" style="${e.icon ? `background-image:url('${e.icon}')` : ''}">${e.icon ? '' : esc((e.name || '?')[0])}</div>
        <div class="fe-meta">
          <div class="fe-name">${esc(e.name)}${e.version ? `<span class="fe-tag">v${esc(e.version)}</span>` : ''}${e.manifestVersion ? `<span class="fe-tag">MV${esc(e.manifestVersion)}</span>` : ''}</div>
          <div class="fe-desc" title="${esc(e.description)}">${esc(e.description || e.id)}</div>
        </div>
        <label class="fe-switch" title="Włącz / wyłącz">
          <input type="checkbox" data-act="toggle" ${e.enabled ? 'checked' : ''}><span class="fe-slider"></span>
        </label>
        <button class="fe-del" data-act="remove" title="Usuń">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12H7L6 9z"/></svg>
        </button>
      </li>`).join(''));
  }

  async function run(promise, okMsg) {
    const r = await promise;
    if (!r || !r.ok) throw new Error((r && r.error) || 'Nieznany błąd');
    if (Array.isArray(r.data)) render(r.data);
    if (okMsg) setStatus('ok', okMsg);
    return r.data;
  }

  const refresh = () => run(api.list()).catch(e => setStatus('err', e.message));

  async function guarded(label, fn) {
    if (busy) return;
    busy = true; $('fe-install').disabled = true;
    setStatus('info', label, true);
    try { await fn(); } catch (e) { setStatus('err', e.message); }
    finally { busy = false; $('fe-install').disabled = false; }
  }

  const installZip = p => p && guarded('Instalowanie z paczki…', () =>
    run(api.installZip(p), 'Zainstalowano. Odśwież stronę, aby aktywować content-scripty.'));

  // open / close
  const open = () => { overlay.hidden = false; refresh(); setTimeout(() => $('fe-url').focus(), 50); };
  const close = () => { overlay.hidden = true; };
  $('fe-open').addEventListener('click', open);
  $('fe-close').addEventListener('click', close);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !overlay.hidden) close(); });

  // store install
  $('fe-form').addEventListener('submit', e => {
    e.preventDefault();
    const url = $('fe-url').value.trim();
    if (!/[a-p]{32}/i.test(url)) return setStatus('err', 'Podaj poprawny link z Chrome Web Store (zawierający 32-znakowe ID).');
    guarded('Pobieranie z Chrome Web Store…', async () => {
      await run(api.installStore(url), 'Zainstalowano. Odśwież stronę, aby aktywować content-scripty.');
      $('fe-url').value = '';
    });
  });

  // zip: click + drag&drop
  const drop = $('fe-drop');
  drop.addEventListener('click', async () => { const r = await api.pickZip(); if (r && r.ok) installZip(r.data); });
  drop.addEventListener('keydown', e => { if (e.key === 'Enter') drop.click(); });
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('fe-over'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('fe-over'); }));
  drop.addEventListener('drop', e => {
    const f = e.dataTransfer.files[0];
    if (!f) return;
    if (!/\.(zip|crx)$/i.test(f.name)) return setStatus('err', 'Obsługiwane są tylko pliki .zip i .crx');
    installZip(api.pathForFile(f));
  });

  // list actions
  list.addEventListener('change', e => {
    if (e.target.dataset.act !== 'toggle') return;
    const id = e.target.closest('.fe-item').dataset.id;
    run(api.toggle(id, e.target.checked), e.target.checked ? 'Włączono rozszerzenie.' : 'Wyłączono rozszerzenie.')
      .catch(err => { setStatus('err', err.message); refresh(); });
  });
  list.addEventListener('click', e => {
    const btn = e.target.closest('[data-act="remove"]');
    if (!btn) return;
    const item = btn.closest('.fe-item');
    const name = item.querySelector('.fe-name').firstChild.textContent;
    if (!confirm(`Usunąć rozszerzenie „${name}”?`)) return;
    item.style.opacity = '0';
    run(api.remove(item.dataset.id), 'Usunięto rozszerzenie.').catch(err => setStatus('err', err.message));
  });

  $('fe-reload').addEventListener('click', () => api.reloadPage());

  // keep the host alive if the SPA re-renders <body>
  new MutationObserver(() => { if (!host.isConnected) (document.body || document.documentElement).appendChild(host); })
    .observe(document.documentElement, { childList: true, subtree: false });

  refresh();
})();
