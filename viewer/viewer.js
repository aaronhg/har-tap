// viewer.js — HAR Tap's viewer (the repo-root index.html): request table + detail pane, no timeline.
// A PURE web page (works from file:// or any static host, drop/open any .har); the only chrome.*
// touch is feature-detected — opened as the extension page it auto-loads the last capture from
// chrome.storage.local (same HAR_KEY the popup downloads from). All HAR-derived strings go into
// the DOM via textContent, never innerHTML — HAR bodies/headers are untrusted page content.
// Pure helpers (formatting, extOf, urlParts, decodeContent, toCsv, …) live in lib.js, loaded
// before this file; both are CLASSIC scripts because Chrome blocks ES modules on file://.
'use strict';

const $ = (id) => document.getElementById(id);
const HAR_KEY = 'harTapHar';

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

// --- state ---
let rows = [];                                // master, in request order
let view = [];                                // filtered + sorted
let sel = null;                               // selected master row (kept only while it passes the filters)
let sort = { key: 'index', dir: 1 };
let activeTypes = new Set();                  // empty = all
let activeTab = 'headers';
let trByRow = new Map();

function ingest(har) {
  // Tolerate foreign/malformed HARs: an entry without request+response can't be shown — skip it
  // (loadHar reports the skip count) rather than letting one bad entry sink the whole file.
  const entries = har.log.entries.filter((e) => e && e.request && e.response);
  const starts = entries.map((e) => Date.parse(e.startedDateTime));  // NaN when missing/garbled
  let t0 = Infinity;
  for (const t of starts) if (t < t0) t0 = t;                        // loop, not Math.min(...spread): 100k+ args blow the stack; NaN never compares true
  if (!Number.isFinite(t0)) t0 = 0;
  rows = entries.map((e, i) => {
    const url = String(e.request.url || '');
    const { name, path, host } = urlParts(url);
    const failed = e._error != null || !e.response.status;
    return {
      e, i, name, path, host,
      url, urlLC: url.toLowerCase(),
      method: String(e.request.method || ''),
      status: e.response.status || 0, failed,
      type: extOf(url),
      // DevTools exports write _transferSize: -1 when unknown — a negative is "no data", not a size
      size: e.response._transferSize >= 0 ? e.response._transferSize
        : e.response.bodySize >= 0 ? e.response.bodySize : null,
      decoded: (e.response.content && e.response.content.size) || 0,
      time: e.time >= 0 ? e.time : null,
      start: starts[i] - t0, started: new Date(starts[i]),           // start is NaN for a bad date — renderers show '–'
    };
  });
  const methods = [...new Set(rows.map((r) => r.method))].sort();
  $('method').replaceChildren(new Option('All methods', 'all'), ...methods.map((m) => new Option(m, m)));
  activeTypes.clear();   // a fresh file brings fresh extensions — stale picks would filter on ghosts
  buildChips();
}

// --- type chips: one per extension present in the file, busiest first ---
function buildChips() {
  const chips = $('chips');
  chips.replaceChildren();
  const allChip = el('button', 'chip', 'All');
  allChip.onclick = () => { activeTypes.clear(); syncChips(); applyFilters(); };
  chips.append(allChip);
  const counts = new Map();
  for (const r of rows) counts.set(r.type, (counts.get(r.type) || 0) + 1);
  const types = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b));
  for (const ty of types) {
    const c = el('button', 'chip', ty || '(none)');
    c.dataset.type = ty;
    c.title = `${counts.get(ty)} request${counts.get(ty) > 1 ? 's' : ''}`;
    c.onclick = () => { activeTypes.has(ty) ? activeTypes.delete(ty) : activeTypes.add(ty); syncChips(); applyFilters(); };
    chips.append(c);
  }
  syncChips();
}
function syncChips() {
  const chips = $('chips');
  if (chips.firstElementChild) chips.firstElementChild.classList.toggle('on', activeTypes.size === 0);
  for (const c of chips.querySelectorAll('[data-type]')) c.classList.toggle('on', activeTypes.has(c.dataset.type));
}

// --- filtering + sorting ---
// The first column shows Name, Path or URL (DevTools-style, switched in the header menu);
// display, sorting and CSV all follow the active mode.
const NAME_MODES = [['name', 'Name'], ['path', 'Path'], ['url', 'URL']];
let nameMode = 'name';
try { const m = localStorage.getItem('harTapNameMode'); if (NAME_MODES.some(([k]) => k === m)) nameMode = m; } catch { /* default */ }
const saveNameMode = () => { try { localStorage.setItem('harTapNameMode', nameMode); } catch { /* fine */ } };
const nameVal = (r) => nameMode === 'path' ? r.path : nameMode === 'url' ? r.url : r.name;
const nameLabel = () => NAME_MODES.find(([k]) => k === nameMode)[1];

const CMP = {
  index: (a, b) => a.i - b.i,
  name: (a, b) => nameVal(a).localeCompare(nameVal(b)),
  method: (a, b) => a.method.localeCompare(b.method),
  status: (a, b) => a.status - b.status,
  type: (a, b) => a.type.localeCompare(b.type),
  size: (a, b) => (a.size ?? -1) - (b.size ?? -1),
  time: (a, b) => (a.time ?? -1) - (b.time ?? -1),
  started: (a, b) => { const av = Number.isFinite(a.start) ? a.start : -Infinity, bv = Number.isFinite(b.start) ? b.start : -Infinity; return av < bv ? -1 : av > bv ? 1 : 0; },
};

// --- columns: data-driven, so the header's right-click menu can toggle them and Export mirrors
// exactly what's shown. `td` builds the display cell; `csv` yields the machine-friendly value
// (full URL, raw bytes/ms) — the display text is presentation, not the datum.
const COLUMNS = [
  { key: 'index', label: '#', cls: 'num', w: 42, csv: (r) => r.i + 1,
    td: (r) => el('td', 'num dim', r.i + 1) },
  { key: 'name', label: nameLabel, always: true, csv: (r) => nameVal(r),
    td: (r) => { const t = el('td', null, nameVal(r)); t.title = r.url; return t; } },
  { key: 'method', label: 'Method', w: 58, csv: (r) => r.method,
    td: (r) => el('td', 'dim', r.method) },
  { key: 'status', label: 'Status', w: 60, csv: (r) => r.failed ? 'failed' : r.status,
    td: (r) => { const t = el('td', 'c-status', r.failed ? 'failed' : r.status); if (r.e._error) t.title = r.e._error; return t; } },
  { key: 'type', label: 'Type', w: 56, csv: (r) => r.type,
    td: (r) => el('td', 'dim', r.type || '–') },
  { key: 'size', label: 'Size', cls: 'num', w: 70, csvLabel: 'Size (bytes)', csv: (r) => r.size ?? '',
    td: (r) => { const t = el('td', 'num', fmtBytes(r.size)); if (r.decoded && r.decoded !== r.size) t.title = `decoded ${fmtBytes(r.decoded)}`; return t; } },
  { key: 'time', label: 'Time', cls: 'num', w: 66, csvLabel: 'Time (ms)', csv: (r) => r.time == null ? '' : Math.round(r.time * 10) / 10,
    td: (r) => el('td', 'num', fmtMs(r.time)) },
  { key: 'started', label: 'Started', cls: 'num', w: 76, csvLabel: 'Started (+ms)',
    csv: (r) => Number.isFinite(r.start) ? Math.round(r.start) : '',
    td: (r) => {
      if (!Number.isFinite(r.start)) return el('td', 'num dim', '–');   // entry had no parseable startedDateTime
      const t = el('td', 'num dim', '+' + fmtMs(r.start));
      t.title = r.started.toLocaleTimeString(undefined, { hour12: false }) + '.' + String(r.started.getMilliseconds()).padStart(3, '0');
      return t;
    } },
];
let visibleCols = new Set(COLUMNS.map((c) => c.key));
try {
  const saved = JSON.parse(localStorage.getItem('harTapCols'));
  if (Array.isArray(saved) && saved.length) visibleCols = new Set(saved.filter((k) => COLUMNS.some((c) => c.key === k)));
} catch { /* default: all columns */ }
for (const c of COLUMNS) if (c.always) visibleCols.add(c.key);
const saveCols = () => { try { localStorage.setItem('harTapCols', JSON.stringify([...visibleCols])); } catch { /* fine */ } };
const shownCols = () => COLUMNS.filter((c) => visibleCols.has(c.key));
const colLabel = (c, forCsv = false) => {
  const l = (forCsv && c.csvLabel) || c.label;
  return typeof l === 'function' ? l() : l;
};

function passes(r) {
  const q = $('q').value.trim().toLowerCase();
  if (q && !r.urlLC.includes(q)) return false;
  if (activeTypes.size && !activeTypes.has(r.type)) return false;
  const st = $('status').value;
  if (st === 'err') { if (!(r.failed || r.status >= 400)) return false; }
  else if (st !== 'all' && Math.floor(r.status / 100) !== +st) return false;
  const m = $('method').value;
  if (m !== 'all' && r.method !== m) return false;
  return true;
}

function applyFilters() {
  view = rows.filter(passes).sort((a, b) => CMP[sort.key](a, b) * sort.dir);
  renderTable();
  renderStats();
  if (sel && !view.includes(sel)) clearSelection();  // the selected request was filtered out
}

// --- request table ---
function renderHeader() {
  const cg = $('grid').querySelector('colgroup');
  cg.replaceChildren();
  const tr = el('tr');
  for (const c of shownCols()) {
    const col = document.createElement('col');
    if (c.w) col.style.width = c.w + 'px';
    cg.append(col);
    const th = el('th', c.cls, colLabel(c));
    if (sort.key === c.key) th.classList.add(sort.dir > 0 ? 'asc' : 'desc');
    th.onclick = () => {
      if (sort.key === c.key) sort.dir *= -1;
      else { sort.key = c.key; sort.dir = 1; }
      renderHeader();
      applyFilters();
    };
    tr.append(th);
  }
  $('grid').tHead.replaceChildren(tr);
}

function renderTable() {
  const frag = document.createDocumentFragment();
  const cols = shownCols();
  trByRow = new Map();
  for (const r of view) {
    const tr = el('tr', r.failed ? 's0' : 's' + Math.floor(r.status / 100));
    if (r === sel) tr.classList.add('sel');
    for (const c of cols) tr.append(c.td(r));
    tr.onclick = () => select(r);
    trByRow.set(r, tr);
    frag.append(tr);
  }
  $('rows').replaceChildren(frag);
  $('no-match').hidden = view.length > 0 || rows.length === 0;
}

// --- header right-click: choose visible columns (choice sticks; Export follows it) ---
function closeColMenu() { document.getElementById('col-menu')?.remove(); }
function showColMenu(x, y) {
  closeColMenu();
  const m = el('div');
  m.id = 'col-menu';
  // top group: what the first column shows — Name / Path / URL (exactly one checked)
  const modeChecks = [];
  for (const [mode, lbl] of NAME_MODES) {
    const it = el('button', 'col-item');
    const ck = el('span', 'ck', nameMode === mode ? '✓' : '');
    modeChecks.push([mode, ck]);
    it.append(ck, el('span', null, lbl));
    it.onclick = () => {
      nameMode = mode;
      for (const [k, c] of modeChecks) c.textContent = k === mode ? '✓' : '';
      saveNameMode(); renderHeader(); applyFilters();   // re-sort too: CMP.name compares the mode's values
    };
    m.append(it);
  }
  m.append(el('div', 'col-sep'));
  for (const c of COLUMNS) {
    if (c.key === 'name') continue;              // represented by the mode group above
    const it = el('button', 'col-item');
    const ck = el('span', 'ck', visibleCols.has(c.key) ? '✓' : '');
    it.append(ck, el('span', null, colLabel(c)));
    it.onclick = () => {                         // menu stays open, DevTools-style
      visibleCols.has(c.key) ? visibleCols.delete(c.key) : visibleCols.add(c.key);
      ck.textContent = visibleCols.has(c.key) ? '✓' : '';
      saveCols(); renderHeader(); renderTable();
    };
    m.append(it);
  }
  m.append(el('div', 'col-sep'));
  const rs = el('button', 'col-item');
  rs.append(el('span', 'ck', ''), el('span', null, 'Reset columns'));
  rs.onclick = () => {
    visibleCols = new Set(COLUMNS.map((c) => c.key));
    nameMode = 'name';
    saveCols(); saveNameMode(); renderHeader(); applyFilters(); closeColMenu();
  };
  m.append(rs);
  document.body.append(m);
  const r = m.getBoundingClientRect();          // clamp inside the viewport
  m.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
  m.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
}

// Export = exactly what the table shows: filtered rows, current order, visible columns only.
function exportCsv() {
  const cols = shownCols();
  const a = el('a');
  a.href = blobUrl(toCsv([cols.map((c) => colLabel(c, true)), ...view.map((r) => cols.map((c) => c.csv(r)))]), 'text/csv');
  a.download = `${harHost}-requests.csv`;
  a.click();
}

function renderStats() {
  // one pass, no spreads (100k+ args overflow the stack), NaN starts skipped
  let wire = 0, dec = 0, errs = 0, min = Infinity, max = -Infinity;
  for (const r of view) {
    if (r.size > 0) wire += r.size;
    if (r.decoded > 0) dec += r.decoded;
    if (r.failed || r.status >= 400) errs++;
    if (Number.isFinite(r.start)) {
      if (r.start < min) min = r.start;
      const end = r.start + (r.time || 0);
      if (end > max) max = end;
    }
  }
  const span = max > min ? max - min : 0;
  const stat = $('stats-line');
  stat.replaceChildren();
  const add = (num, label) => { stat.append(el('b', null, num), ' ' + label + ' · '); };
  add(view.length === rows.length ? String(rows.length) : `${view.length} / ${rows.length}`, 'requests');
  add(fmtBytes(wire), 'transferred');
  add(fmtBytes(dec), 'resources');
  add(String(errs), 'errors');
  stat.append(el('b', null, fmtMs(span)), ' span');
}

// --- selection + detail pane ---
function select(r) {
  if (sel && trByRow.get(sel)) trByRow.get(sel).classList.remove('sel');
  sel = r;
  const tr = trByRow.get(r);
  if (tr) { tr.classList.add('sel'); tr.scrollIntoView({ block: 'nearest' }); }
  $('d-method').textContent = r.method;
  $('d-url').textContent = r.url;
  $('dl').hidden = (r.e.response.content || {}).text == null;   // Download lives in the tab bar's corner
  $('detail').hidden = false;
  $('splitter').hidden = false;
  renderTab();
}

function clearSelection() {
  if (sel && trByRow.get(sel)) trByRow.get(sel).classList.remove('sel');
  sel = null;
  freeObjectUrls();
  $('detail').hidden = true;
  $('splitter').hidden = true;
}

// Blob URLs backing media previews/downloads live exactly as long as the tab render that made them.
let objectUrls = [];
function freeObjectUrls() { for (const u of objectUrls) URL.revokeObjectURL(u); objectUrls = []; }
function blobUrl(bytes, mime) { const u = URL.createObjectURL(new Blob([bytes], { type: mime || 'application/octet-stream' })); objectUrls.push(u); return u; }

function kvGrid(pairs) {
  const g = el('div', 'kv');
  for (const [k, v] of pairs) { g.append(el('span', 'k', k), el('span', 'v', v)); }
  return g;
}
function section(title, count, node, open = true) {
  const d = el('details'); d.open = open;
  const s = el('summary', null, title + ' ');
  if (count != null) s.append(el('span', null, `(${count})`));
  d.append(s, node);
  return d;
}
const headerGrid = (hs) => kvGrid((hs || []).map((h) => [h.name, h.value]));

function renderTab() {
  if (!sel) return;
  for (const b of $('tabs').querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === activeTab);
  freeObjectUrls();
  const body = $('tab-body');
  body.replaceChildren(TAB[activeTab](sel));
  body.scrollTop = 0;
}

const TAB = { headers: tabHeaders, payload: tabPayload, preview: tabPreview, response: tabResponse, timing: tabTiming };

function tabHeaders(r) {
  const e = r.e, box = el('div');
  const respH = e.response.headers || [], reqH = e.request.headers || [];   // foreign HARs may omit the arrays
  const gen = [
    ['Request URL', r.url],
    ['Method', r.method],
    ['Status', r.failed ? `failed${e._error ? ' — ' + e._error : ''}` : `${r.status} ${e.response.statusText || ''}`.trim()],
    ['Protocol', e.response.httpVersion || ''],
    ['Remote address', e.serverIPAddress || ''],
    ['Type', `${r.type} · ${(e.response.content && e.response.content.mimeType) || '—'}`],
    ['Priority', e._priority || ''],
  ].filter(([, v]) => v !== '');
  box.append(section('General', null, kvGrid(gen)));
  box.append(section('Response headers', respH.length, headerGrid(respH)));
  box.append(section('Request headers', reqH.length, headerGrid(reqH)));
  return box;
}

function tabPayload(r) {
  const e = r.e, box = el('div');
  const qs = e.request.queryString || [];
  if (qs.length) box.append(section('Query string parameters', qs.length, headerGrid(qs)));
  const post = e.request.postData;
  if (post && post.text != null) {
    const mime = (post.mimeType || '').toLowerCase();
    let node;
    if (mime.includes('urlencoded')) {
      node = kvGrid([...new URLSearchParams(post.text)]);
    } else {
      node = bodyViewer(post.text, mime);
    }
    box.append(section(`Request body`, null, node));
    if (post.mimeType) box.append(el('p', 'note', post.mimeType));
  } else if (!qs.length) {
    box.append(el('p', 'note', 'No query string and no request body.'));
  }
  return box;
}

const NOT_EMBEDDED = 'Body not embedded in this HAR — capture with “Embed response bodies” on to inspect it here.';
const B64_ERROR = 'Body is base64 but failed to decode.';

// A truncating <pre>: huge bodies start clipped behind a "Show all" button.
const TRUNC_AT = 300000, TRUNC_TO = 100000;
function prePane(text) {
  const wrap = el('div');
  const pre = el('pre', 'body-pre');
  wrap.append(pre);
  if (text.length > TRUNC_AT) {
    pre.textContent = text.slice(0, TRUNC_TO);
    const more = el('button', 'link-btn', `Show all (${fmtBytes(text.length)} of text)`);
    more.onclick = () => { pre.textContent = text; more.remove(); };
    wrap.append(more);
  } else {
    pre.textContent = text;
  }
  return wrap;
}

// Request-body renderer (Payload tab): pretty/raw toggle when it parses as JSON.
function bodyViewer(text, mime) {
  const pretty = prettyJson(text, mime);
  if (pretty === null || pretty === text) return prePane(text);
  const box = el('div');
  const seg = el('div', 'seg-row');
  const holder = el('div');
  const bp = el('button', 'on', 'Pretty'), br = el('button', null, 'Raw');
  const show = (s) => holder.replaceChildren(prePane(s));
  bp.onclick = () => { bp.classList.add('on'); br.classList.remove('on'); show(pretty); };
  br.onclick = () => { br.classList.add('on'); bp.classList.remove('on'); show(text); };
  seg.append(bp, br);
  box.append(seg, holder);
  show(pretty);
  return box;
}

// Preview = the rendered view (image, player, prettified JSON) — like DevTools' Preview tab.
function tabPreview(r) {
  const c = r.e.response.content || {}, box = el('div');
  const d = decodeContent(c);
  if (d.kind === 'none') box.append(el('p', 'note', NOT_EMBEDDED));
  else if (d.kind === 'b64error') box.append(el('p', 'note', B64_ERROR));
  else if (d.kind === 'image') { const img = el('img', 'body-img'); img.src = d.dataUrl; img.alt = r.name; box.append(img); }
  else if (d.kind === 'media') {
    const m = el(d.tag, 'body-media');                     // plays the CAPTURED bytes, not a re-fetch
    m.controls = true;
    m.src = blobUrl(d.bytes, c.mimeType);
    box.append(m);
  } else if (d.kind === 'binary') box.append(el('p', 'note', `Binary body — ${fmtBytes(d.bytes.length)} · no preview for ${c.mimeType || 'unknown type'}.`));
  else box.append(prePane(prettyJson(d.text, c.mimeType) ?? d.text));
  return box;
}

// Response = the raw body text (+ size/MIME meta); non-text bodies point at Preview.
function tabResponse(r) {
  const c = r.e.response.content || {}, box = el('div');
  const meta = kvGrid([
    ['MIME type', c.mimeType || '—'],
    ['Decoded size', fmtBytes(c.size)],
    ['Transferred', fmtBytes(r.size)],
  ]);
  const d = decodeContent(c);
  box.append(meta);   // size/MIME meta on top, body below
  if (d.kind === 'none') box.append(el('p', 'note', NOT_EMBEDDED));
  else if (d.kind === 'b64error') box.append(el('p', 'note', B64_ERROR));
  else if (d.kind === 'text') box.append(prePane(d.text));
  else box.append(el('p', 'note', `Binary body — ${fmtBytes(c.size)} · rendered in the Preview tab.`));
  return box;
}

function tabTiming(r) {
  const t = r.e.timings || {}, box = el('div');
  const PHASES = [['blocked', 'Blocked'], ['dns', 'DNS'], ['connect', 'Connect'], ['ssl', 'SSL'],
    ['send', 'Send'], ['wait', 'Waiting'], ['receive', 'Receive']];
  // HAR counts ssl INSIDE connect — subtract it for the stacked bar so segments sum to the total.
  const segVal = (k) => k === 'connect' && t.connect >= 0 && t.ssl > 0 ? t.connect - t.ssl : t[k];
  const segs = PHASES.map(([k, label]) => [k, label, segVal(k)]).filter(([, , v]) => v > 0);
  const total = segs.reduce((s, [, , v]) => s + v, 0);
  if (total > 0) {
    const bar = el('div', 'tbar');
    for (const [k, label, v] of segs) {
      const s = el('span', 'ph-' + k);
      s.style.flex = `${v / total} 1 0`;
      s.title = `${label} — ${fmtMs(v)}`;
      bar.append(s);
    }
    box.append(bar);
  }
  const grid = el('div', 'ph-table');
  for (const [k, label] of PHASES) {
    grid.append(el('span', 'sw ph-' + k), el('span', null, label), el('span', 'ms', fmtMs(t[k])));
  }
  grid.append(el('span'), el('span', 'tot', 'Total'), el('span', 'ms tot', fmtMs(r.time)));
  box.append(grid, el('p', 'note', 'SSL time is part of Connect; the bar shows Connect with SSL split out.'));
  return box;
}

// --- loading ---
let harHost = 'har';   // filename stem for CSV export, from the captured page's host
function loadHar(har, sourceNote) {
  if (!har || !har.log || !Array.isArray(har.log.entries)) { showLoadError('Not a HAR: missing log.entries.'); return; }
  clearSelection();
  ingest(har);
  $('empty').hidden = true;
  $('main').hidden = false;
  $('stats').hidden = false;
  try { harHost = new URL(har.log.pages?.[0]?.title || rows[0]?.url).hostname; } catch { harHost = 'har'; }
  document.title = harHost === 'har' ? 'HAR Tap — viewer' : harHost + ' — HAR Tap';
  applyFilters();
  $('table-pane').focus();
  const skipped = har.log.entries.length - rows.length;
  if (sourceNote || skipped) {
    toast(`Loaded ${rows.length} requests from ${sourceNote || 'file'}` +
      (skipped ? ` · skipped ${skipped} malformed entr${skipped > 1 ? 'ies' : 'y'}` : ''));
  }
}

async function readFile(file) {
  let har;                       // parse and load fail differently — don't blame JSON for a load bug
  try { har = JSON.parse(await file.text()); }
  catch { showLoadError(`${file.name} isn't valid JSON.`); return; }
  try { loadHar(har, file.name); }
  catch (e) { console.error(e); showLoadError(`Couldn't load ${file.name} — ${e.message || e}`); }
}

function showLoadError(msg) {
  if ($('empty').hidden) { toast(msg); return; }
  const e = $('load-err');
  e.textContent = msg;
  e.hidden = false;
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2500);
}

// --- UI wiring ---
function wireUi() {
  if (location.protocol === 'file:') $('example').hidden = true;   // fetch is blocked on file://
  // toolbar (the type chips are per-file — buildChips() runs at ingest)
  $('q').oninput = applyFilters;
  $('status').onchange = applyFilters;
  $('method').onchange = applyFilters;
  $('reset').onclick = () => { $('q').value = ''; $('status').value = 'all'; $('method').value = 'all'; activeTypes.clear(); syncChips(); applyFilters(); };

  for (const id of ['open', 'open2']) $(id).onclick = () => $('file').click();
  $('file').onchange = () => { if ($('file').files[0]) readFile($('file').files[0]); $('file').value = ''; };

  // table header: sorting is wired per-th inside renderHeader; right-click picks columns
  renderHeader();
  $('grid').tHead.addEventListener('contextmenu', (ev) => { ev.preventDefault(); showColMenu(ev.clientX, ev.clientY); });
  document.addEventListener('pointerdown', (ev) => { if (!ev.target.closest('#col-menu')) closeColMenu(); });

  // export the current list (footer button, next to the numbers it exports)
  $('export').onclick = exportCsv;

  // detail pane
  $('close').onclick = clearSelection;
  for (const b of $('tabs').querySelectorAll('[data-tab]')) b.onclick = () => { activeTab = b.dataset.tab; renderTab(); };
  $('copy-url').onclick = async () => {
    if (!sel) return;
    await navigator.clipboard.writeText(sel.url);
    $('copy-url').textContent = 'Copied';
    setTimeout(() => { $('copy-url').textContent = 'Copy URL'; }, 1200);
  };

  // Download (tab-bar corner): decodes on demand, saves via a transient <a download> —
  // no chrome.downloads permission, works from file:// too.
  $('dl').onclick = () => {
    if (!sel) return;
    const c = sel.e.response.content || {};
    const d = decodeContent(c);
    const url = d.kind === 'image' ? d.dataUrl
      : d.bytes ? blobUrl(d.bytes, c.mimeType)
      : d.kind === 'text' ? blobUrl(d.text, c.mimeType || 'text/plain')
      : null;
    if (!url) return;
    const a = el('a');
    a.href = url;
    a.download = sel.name.split('?')[0] || 'body';
    a.click();
  };

  // splitter: drag to resize the detail pane; width sticks for next time
  const splitter = $('splitter'), detail = $('detail');
  try {
    const w = +localStorage.getItem('harTapDetailW');
    if (w) detail.style.flex = `0 0 ${Math.min(w, window.innerWidth - 320)}px`;
  } catch { /* storage unavailable — default width */ }
  splitter.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    splitter.setPointerCapture(ev.pointerId);
    splitter.classList.add('active');
    const startX = ev.clientX, startW = detail.getBoundingClientRect().width;
    const move = (e) => {
      const w = Math.min(Math.max(startW + (startX - e.clientX), 280), window.innerWidth - 320);
      detail.style.flex = `0 0 ${w}px`;
    };
    const up = () => {
      splitter.removeEventListener('pointermove', move);
      splitter.classList.remove('active');
      try { localStorage.setItem('harTapDetailW', String(Math.round(detail.getBoundingClientRect().width))); } catch { /* fine */ }
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up, { once: true });
  });

  // keyboard: ↑↓ walk the table, ←→ cycle the detail tabs, Enter jumps to the detail pane, Esc comes back
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeColMenu();
    if (ev.target.closest('input, select, textarea')) { if (ev.key === 'Escape') ev.target.blur(); return; }
    if (ev.key === 'Escape') { $('table-pane').focus(); return; }
    if (!view.length) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const i = sel ? view.indexOf(sel) : -1;
      select(view[ev.key === 'ArrowDown' ? Math.min(view.length - 1, i + 1) : Math.max(0, i <= 0 ? 0 : i - 1)]);
    } else if ((ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') && sel) {
      ev.preventDefault();
      const keys = [...$('tabs').querySelectorAll('[data-tab]')].map((b) => b.dataset.tab);
      const i = keys.indexOf(activeTab);
      activeTab = keys[(i + (ev.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length];
      renderTab();
    } else if (ev.key === 'Enter' && sel) {
      $('detail').focus();
    }
  });

  // drag & drop anywhere; the overlay is pointer-events:none so the window keeps the events
  let dragDepth = 0;
  window.addEventListener('dragenter', (ev) => { if (ev.dataTransfer?.types.includes('Files')) { dragDepth++; $('drop-overlay').hidden = false; } });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop-overlay').hidden = true; } });
  window.addEventListener('dragover', (ev) => ev.preventDefault());
  window.addEventListener('drop', (ev) => {
    ev.preventDefault();
    dragDepth = 0;
    $('drop-overlay').hidden = true;
    const f = ev.dataTransfer.files[0];
    if (f) readFile(f);
  });
}

async function boot() {
  wireUi();
  // ?har=<url> deep-links a HAR (e.g. the hosted demo: /?har=test/fixtures/sample.har).
  // Same-origin always works; a cross-origin URL needs CORS from that server; file:// can't fetch.
  const src = new URLSearchParams(location.search).get('har');
  if (src) {
    try {
      const r = await fetch(src);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      loadHar(await r.json(), src.split('/').pop() || src);
      return;
    } catch (e) {
      console.error(e);
      showLoadError(`Couldn't load ${src} — ${e.message || e}`);
    }
  }
  // Opened as the extension page? Auto-load the last capture the popup saved.
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    let har = null;
    try { ({ [HAR_KEY]: har } = await chrome.storage.local.get(HAR_KEY)); }
    catch { /* not running as an extension page */ }
    if (har) {
      try { loadHar(har, 'the last capture'); }
      catch (e) { console.error(e); showLoadError(`Couldn't load the saved capture — ${e.message || e}`); }
    }
  }
}

boot();
