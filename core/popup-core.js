// popup-core.js — the popup UI, factored as a reusable engine. Reads the active tab, drives start/stop via
// the service worker, polls live status, and (having a DOM, unlike the SW) turns the saved HAR into a Blob
// download `<host>.har`. Start is always present; the second button walks Stop → Download after a capture
// finishes; View (always present) opens the viewer. A finished capture is persisted (by the SW) so
// View/Download survive closing/reopening the popup.
//
// This is the SHARED core. har-tap calls initPopup() with no plugins. A downstream consumer can pass a
// popup plugin to add UI — extra option inputs and a results panel — through the seams below, without
// copying this file. With no plugin every seam is inert, so the base popup is unchanged.
//
// Popup plugin surface (all optional):
//   optionsHtml : string          — markup injected into #opt-slot (after the base checkboxes)
//   optionIds   : string[]        — element ids to persist/restore alongside the base options
//   startOpts($) : object         — extra fields merged into the { type:'start' } opts ($ = id → element)
//   renderStatus(st) : string     — extra HTML appended to the live "Capturing…" line
//   renderReady(meta) : string    — HTML for #panel-slot shown in the ready state (and restored on reopen)
//   reset()                       — clear any transient panel state (idle / clear / after download)

export function initPopup(config = {}) {
  const plugins = config.plugins || [];
  const URL_KEY = config.urlKey || 'harTapUrl';
  const OPTS_KEY = config.optsKey || 'harTapOpts';
  const HAR_KEY = config.harKey || 'harTapHar';           // the full saved HAR (large; read only on Download)
  const HAR_META_KEY = config.metaKey || 'harTapHarMeta';  // {count, wireBytes, bodyBytes, includeBodies} for the summary line
  const BASE_OPT_IDS = config.optIds || ['reload', 'nocache', 'bodies'];
  const PLUGIN_OPT_IDS = plugins.flatMap((p) => p.optionIds || []);
  const OPT_IDS = [...BASE_OPT_IDS, ...PLUGIN_OPT_IDS];

  const $ = (id) => document.getElementById(id);
  const msg = (m) => new Promise((res) => chrome.runtime.sendMessage(m, res));
  const fmtBytes = (n) => n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n > 1e3 ? (n / 1e3).toFixed(1) + ' kB' : n + ' B';
  // An option element persists its `.checked` (checkbox) or its `.value` (text/textarea).
  const getOpt = (el) => el && el.type === 'checkbox' ? el.checked : (el ? el.value : undefined);
  const setOpt = (el, v) => { if (!el) return; if (el.type === 'checkbox') el.checked = !!v; else el.value = v ?? ''; };

  let tab = null, capTabId = null, pollTimer = null, uiState = 'idle'; // idle | capturing | ready

  const saveOpts = () => chrome.storage.local.set({ [OPTS_KEY]: Object.fromEntries(OPT_IDS.map((id) => [id, getOpt($(id))])) });
  const setInputsDisabled = (d) => { $('url').disabled = d; for (const id of OPT_IDS) { const el = $(id); if (el) el.disabled = d; } };
  const setBtn = (id, cls, text, disabled, onclick) => { const b = $(id); b.className = cls; b.textContent = text; b.disabled = disabled; b.onclick = onclick; };
  // The status box doubles as the error line: normal status vs. a red error, same block.
  const setStat = (html) => { const s = $('stat'); s.classList.remove('is-err'); s.innerHTML = html; };
  const setErr = (text) => { const s = $('stat'); s.classList.add('is-err'); s.textContent = text; };
  const readyStat = (m) => `Stopped · <b>${m.count}</b> entries · wire <b>${fmtBytes(m.wireBytes)}</b>${m.includeBodies ? ` · bodies <b>${fmtBytes(m.bodyBytes)}</b>` : ''} · ${((m.sinceMs || 0) / 1000).toFixed(2)}s`;

  // Plugins own #panel-slot: rendered from meta in the ready state, cleared otherwise.
  const setPanel = (meta) => { const el = $('panel-slot'); if (!el) return; el.innerHTML = plugins.map((p) => (p.renderReady && meta ? p.renderReady(meta) : '')).join(''); };
  const clearPanel = () => { const el = $('panel-slot'); if (el) el.innerHTML = ''; for (const p of plugins) { try { p.reset && p.reset(); } catch { /* ignore */ } } };

  // Mirrors capture-core.js: pages chrome.debugger can't attach to, so a capture there runs in a fresh tab.
  function cannotAttach(url) {
    try {
      const u = new URL(url);
      if (['chrome:', 'chrome-extension:', 'chrome-untrusted:', 'devtools:', 'view-source:'].includes(u.protocol)) return true;
      if (u.hostname === 'chromewebstore.google.com') return true;
      if (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore')) return true;
      return false;
    } catch { return true; }
  }
  const willOpenNewTab = () => cannotAttach(tab && tab.url) && $('reload').checked && $('url').value.trim() !== '';
  // Tell the user, on the button itself, when Start won't capture the current tab but a fresh one.
  // Only in the idle state, where the left button is Start — in the ready state it's the Clear button.
  function refreshStartLabel() { if (uiState === 'idle') $('start').textContent = willOpenNewTab() ? 'Start in new tab' : 'Start'; }

  async function init() {
    // Let plugins inject their option inputs before we read/wire them.
    const slot = $('opt-slot');
    if (slot) slot.innerHTML = plugins.map((p) => p.optionsHtml || '').join('');
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = t; capTabId = t ? t.id : null;
    // Prefer the URL/options the user last saved; fall back to the active tab's URL and HTML defaults on first use.
    const { [URL_KEY]: savedUrl, [OPTS_KEY]: savedOpts } = await chrome.storage.local.get([URL_KEY, OPTS_KEY]);
    $('url').value = savedUrl || (t ? t.url : '');
    for (const id of OPT_IDS) if (savedOpts && savedOpts[id] !== undefined) setOpt($(id), savedOpts[id]);
    // Persist every edit so the URL and option choices survive closing/reopening the popup.
    $('url').addEventListener('input', () => { chrome.storage.local.set({ [URL_KEY]: $('url').value }); refreshStartLabel(); });
    for (const id of OPT_IDS) { const el = $(id); if (el) el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => { saveOpts(); refreshStartLabel(); }); }
    const st = await msg({ type: 'status', tabId: capTabId });
    if (st.capturing) { enterCapturing(st); return; }
    // A finished-but-not-downloaded capture is kept in storage — restore the Download state on reopen.
    const { [HAR_META_KEY]: meta } = await chrome.storage.local.get(HAR_META_KEY);
    if (meta) { enterReady(); setStat(readyStat(meta)); setPanel(meta); return; }
    enterIdle();
  }

  // --- 3 states across the fixed Start button + the morphing action button ---
  // View is always present and clickable: it opens the viewer (the extension's own index.html).
  const openViewer = () => chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
  function enterIdle() {
    uiState = 'idle';
    setBtn('start', 'primary', 'Start', false, start);
    setBtn('action', 'primary', 'Stop', true, null);   // nothing to stop/download yet
    setBtn('view', '', 'View', false, openViewer);
    setInputsDisabled(false);
    stopPolling();
    clearPanel();
    setStat('Idle');
    refreshStartLabel();
  }
  function enterCapturing(st) {
    uiState = 'capturing';
    setBtn('start', 'primary', 'Start', true, null);   // Start stays visible, disabled mid-capture
    setBtn('action', 'primary', 'Stop', false, stop);
    setBtn('view', '', 'View', false, openViewer);
    setInputsDisabled(true);
    render(st);
    startPolling();
  }
  function enterReady() {
    uiState = 'ready';
    setBtn('start', 'primary', 'Clear', false, doClear);     // discard the saved HAR without downloading
    setBtn('action', 'primary', 'Download', false, doDownload);
    setBtn('view', 'primary', 'View', false, openViewer);    // matches Download: there IS a HAR to view
    setInputsDisabled(false);
    stopPolling();
  }

  function render(st) {
    if (!st || !st.capturing) { setStat('Idle'); return; }
    const frames = st.frames > 1 ? ` · <b>${st.frames}</b> frames` : '';
    const bodies = st.includeBodies ? ` · bodies <b>${fmtBytes(st.bodyBytes)}</b>` : ''; // only when embedding is on
    const extra = plugins.map((p) => (p.renderStatus ? p.renderStatus(st) || '' : '')).join('');
    setStat(`Capturing… <b>${st.count}</b> entries${frames} · wire <b>${fmtBytes(st.wireBytes)}</b>${bodies} · ${(st.sinceMs / 1000).toFixed(0)}s${extra}`);
  }
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(async () => {
      if (!capTabId) return;
      const st = await msg({ type: 'status', tabId: capTabId });
      if (pollTimer) render(st);   // drop a status that arrived after we stopped (else it clobbers the Stopped line)
    }, 500);
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  async function start() {
    let url = $('url').value.trim();
    if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url; // bare host → assume https
    if (url !== $('url').value) { $('url').value = url; chrome.storage.local.set({ [URL_KEY]: url }); }
    const opts = { reload: $('reload').checked, disableCache: $('nocache').checked, includeBodies: $('bodies').checked, url };
    for (const p of plugins) if (p.startOpts) Object.assign(opts, p.startOpts($) || {});
    const r = await msg({ type: 'start', tabId: capTabId, opts });
    if (!r.ok) { setErr(r.error); return; }
    chrome.storage.local.remove([HAR_KEY, HAR_META_KEY]); // a new capture supersedes any saved one
    capTabId = r.tabId || capTabId;      // may be a fresh tab if the active page couldn't be attached
    enterCapturing({ capturing: true, count: 0, wireBytes: 0, bodyBytes: 0, includeBodies: $('bodies').checked, sinceMs: 0 });
  }

  async function stop() {
    stopPolling();                        // before the (possibly slow, body-heavy) build+save so no late poll clobbers the result
    $('action').disabled = true;          // guard against a double-stop during the save
    setStat('Stopping…');
    const r = await msg({ type: 'stop', tabId: capTabId });
    if (!r.ok) { enterIdle(); setErr(r.error); return; }
    enterReady();
    setStat(readyStat(r));                // the HAR itself was saved to storage by the SW; r carries just the summary
    setPanel(r);                          // r carries any plugin extras merged into the meta
  }

  async function doDownload() {
    const { [HAR_KEY]: har } = await chrome.storage.local.get(HAR_KEY);
    if (!har) { enterIdle(); return; }    // nothing saved (already downloaded / cleared)
    const n = har.log.entries.length;
    download(har);
    await chrome.storage.local.remove([HAR_KEY, HAR_META_KEY]);
    enterIdle();
    setStat(`Downloaded <b>${n}</b> entries → .har`);
  }

  function doClear() {
    chrome.storage.local.remove([HAR_KEY, HAR_META_KEY]); // discard the capture, back to idle
    enterIdle();
    setStat('Cleared');
  }

  function download(har) {
    const blob = new Blob([JSON.stringify(har)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const host = (() => { try { return new URL(har.log.pages[0]?.title || (tab && tab.url)).hostname; } catch { return 'capture'; } })();
    const a = document.createElement('a');
    a.href = url; a.download = `${host}.har`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  init();
}
