// viewer/lib.js — the viewer's PURE helpers: formatting, URL/type/body classification, CSV.
// No DOM, no chrome.*. Loaded as a CLASSIC script ahead of viewer.js — not an ES module, because
// Chrome blocks module imports on file:// (null origin) and opening the viewer (root index.html)
// straight from disk is a supported way to use it. test/viewer-lib.test.js evaluates this same file
// in Node (new Function), so keep it dependency- and side-effect-free.
'use strict';

const fmtBytes = (n) => n == null || n < 0 ? '–' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n > 1e3 ? (n / 1e3).toFixed(1) + ' kB' : n + ' B';
const fmtMs = (n) => n == null || n < 0 || !isFinite(n) ? '–' : n >= 1000 ? (n / 1000).toFixed(2) + ' s' : n >= 10 ? Math.round(n) + ' ms' : n.toFixed(1) + ' ms';

// --- type IS the URL's file extension ('' when there is none) — the Type column shows it and
// the filter chips are built from the extensions actually present in the loaded HAR ---
function extOf(url) {
  try {
    const seg = new URL(url).pathname.split('/').pop();
    const i = seg.lastIndexOf('.');
    return i > 0 ? seg.slice(i + 1).toLowerCase() : '';   // i > 0: a leading dot is a dotfile, not an extension
  } catch { return ''; }   // not a URL — no extension
}

// name/path/host backing the first table column's three display modes
function urlParts(url) {
  try {
    const u = new URL(url);
    let name = decodeURIComponent(u.pathname.replace(/\/+$/, '').split('/').pop() || '') || u.hostname;
    if (u.search) name += u.search.length > 24 ? '?…' : u.search;
    return { name, path: u.pathname + u.search, host: u.hostname };
  } catch { return { name: url, path: url, host: '' }; }   // not a URL — show it raw
}

const prettyJson = (text, mime) => {
  if (text.length >= 2e6 || !((mime || '').includes('json') || /^\s*[[{]/.test(text))) return null;
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return null; /* not JSON after all */ }
};

// Classify + decode an embedded body ONCE — Preview, Response and the Download button all build on it.
// kinds: none | b64error | image {dataUrl} | media {bytes, tag} | binary {bytes} | text {text, bytes?}
function decodeContent(c) {
  if (!c || c.text == null) return { kind: 'none' };
  const mime = (c.mimeType || '').toLowerCase();
  if (c.encoding !== 'base64') return { kind: 'text', text: c.text };
  if (mime.startsWith('image/')) return { kind: 'image', dataUrl: `data:${c.mimeType};base64,${c.text}` };
  let bytes;
  try { bytes = Uint8Array.from(atob(c.text), (ch) => ch.charCodeAt(0)); }
  catch { return { kind: 'b64error' }; }
  if (mime.startsWith('audio/') || mime.startsWith('video/')) return { kind: 'media', bytes, tag: mime.startsWith('audio/') ? 'audio' : 'video' };
  const text = new TextDecoder().decode(bytes);
  const sample = text.slice(0, 1024);
  let ctl = 0;
  for (const ch of sample) { const cc = ch.codePointAt(0); if (cc === 0xFFFD || (cc < 32 && cc !== 9 && cc !== 10 && cc !== 13)) ctl++; }
  if (ctl > sample.length * 0.05) return { kind: 'binary', bytes };   // not text — don't dump mojibake
  return { kind: 'text', text, bytes };
}

// rows (header row first) → CSV text; leading BOM so Excel detects UTF-8.
// Cells starting with = + - @ (or tab/CR) get a leading ' — the standard CSV formula-injection
// guard: a hostile HAR can put '=HYPERLINK(...)' in a URL and Excel would execute it on open.
function toCsv(rows) {
  const esc = (v) => {
    v = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
    return /[",\n]/.test(v) ? '"' + v.replaceAll('"', '""') + '"' : v;
  };
  return '\uFEFF' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
}
