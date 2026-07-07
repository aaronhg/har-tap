// har.js — a PURE HAR-entry builder. No chrome.* and no Node builtins, so it runs unchanged in a
// service worker AND is unit-testable in Node. capture-core.js feeds it raw CDP events (chrome.debugger's
// onEvent params are the same shapes the DevTools Network domain emits), and this assembles a standard
// HAR 1.2 log (entries + pages/pageTimings) that Chrome DevTools and any HAR viewer can import.
//
// This is the SHARED core: har-tap uses it directly; a downstream consumer (via a git submodule) reuses
// it unchanged. Entry-level extras are namespaced with a leading underscore
// (_transferSize/_initiator/_priority/_resourceType/_session) — non-standard but ignored by HAR readers,
// so adding one never changes how a viewer renders the log.

const hdrArr = (h) => Object.entries(h || {}).map(([name, value]) => ({ name, value: String(value) }));
// Response variant: CDP merges repeated Set-Cookie into ONE header joined by \n — HAR wants one
// header entry per cookie, so split them back out (DevTools does the same).
const respHdrArr = (h) => Object.entries(h || {}).flatMap(([name, value]) =>
  name.toLowerCase() === 'set-cookie'
    ? String(value).split('\n').filter(Boolean).map((v) => ({ name, value: v }))
    : [{ name, value: String(value) }]);
const getH = (h, n) => { if (!h) return ''; const k = Object.keys(h).find((x) => x.toLowerCase() === n); return k ? String(h[k]) : ''; };  // wire headers are lowercase on h2
const qsArr = (u) => { try { const out = []; for (const [name, value] of new URL(u).searchParams) out.push({ name, value }); return out; } catch { return []; } };
const urlParams = (s) => { try { return [...new URLSearchParams(s)].map(([name, value]) => ({ name, value })); } catch { return []; } };
const reqCookies = (h) => { const c = (h && (h.Cookie || h.cookie)) || ''; return c ? String(c).split(/;\s*/).filter(Boolean).map((kv) => { const i = kv.indexOf('='); return { name: i < 0 ? kv : kv.slice(0, i), value: i < 0 ? '' : kv.slice(i + 1) }; }) : []; };
const respCookies = (h) => { const raw = (h && (h['set-cookie'] || h['Set-Cookie'])) || ''; if (!raw) return []; return String(raw).split('\n').filter(Boolean).map((line) => { const [nv, ...attrs] = line.split(/;\s*/); const i = nv.indexOf('='); const c = { name: i < 0 ? nv : nv.slice(0, i), value: i < 0 ? '' : nv.slice(i + 1) }; for (const a of attrs) { const j = a.indexOf('='); const k = (j < 0 ? a : a.slice(0, j)).toLowerCase(); const v = j < 0 ? '' : a.slice(j + 1); if (k === 'path') c.path = v; else if (k === 'domain') c.domain = v; else if (k === 'expires') { const d = new Date(v); c.expires = isNaN(d) ? v : d.toISOString(); } else if (k === 'httponly') c.httpOnly = true; else if (k === 'secure') c.secure = true; else if (k === 'samesite') c.sameSite = v; } return c; }); };
// Buffer.byteLength has no browser equivalent → TextEncoder.
export const byteLen = (s) => new TextEncoder().encode(String(s || '')).length;
// decoded body size from a getResponseBody result (base64 → 3/4 of the string, minus padding).
export const b64Size = (s) => { const n = s.length; const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0; return Math.max(0, (n * 3 >> 2) - pad); };

export class HarTap {
  constructor() {
    this.reqInfo = new Map();          // (sessionId,requestId) → { request, wallTime, type, initiator, priority, pageref, response?, reqExtraHeaders?, respExtraHeaders?, respHeadersText?, bodyWire? }
    this.extra = new Map();            // *ExtraInfo events that arrived BEFORE their requestWillBeSent (CDP order is not guaranteed)
    this.entries = [];
    this.wireBytes = 0;                // running sum of encodedDataLength (real bytes on the wire, headers+body)
    this.browser = null;               // optional log.browser {name, version} — capture-core fills it from the UA
    // One page per TOP-FRAME navigation (the DevTools convention): entries carry the pageref of the page
    // that was current when their request STARTED, and each page gets its own pageTimings.
    this.pages = [];                   // { id, wall, mono, url, domTs, loadTs }
    this.mainFrameId = null;           // set by capture-core (Page.getFrameTree); while null the log stays single-page
  }

  _page() { return this.pages[this.pages.length - 1]; }
  _newPage(p) {
    this.pages.push({ id: 'page_' + (this.pages.length + 1), wall: p.wallTime || 0, mono: p.timestamp ?? null,
      url: p.documentURL || (p.request && p.request.url) || '', domTs: null, loadTs: null });
  }

  // --- CDP event handlers (same names/shapes as the CDP Network domain) ---
  // `sid` = the chrome.debugger child-session id for OOPIF frames (empty for the top/root session).
  // A requestId is only unique WITHIN a session, so different targets reuse '1','2',… — key reqInfo by
  // (sid, requestId) or cross-frame requests collide. getResponseBody still needs the raw requestId+session.
  _key(sid, requestId) { return sid + '\x00' + requestId; }
  requestWillBeSent(p, sid = '') {
    // Page bookkeeping: the first request opens the implicit first page (≈ capture/nav start); after
    // that, a TOP-FRAME Document request — a real navigation, not a redirect hop of one, and not a
    // same-origin iframe's document (those ride the root session too) — opens the next page.
    const isNav = !sid && !p.redirectResponse && p.type === 'Document' && this.mainFrameId != null && p.frameId === this.mainFrameId;
    if (!this.pages.length || isNav) this._newPage(p);
    const k = this._key(sid, p.requestId);
    if (p.redirectResponse) { const ri = this.reqInfo.get(k); if (ri) this._push(ri, p.redirectResponse, p.timestamp, 0, undefined, sid); } // emit the redirect hop
    this.reqInfo.set(k, { request: p.request, wallTime: p.wallTime, type: p.type, initiator: p.initiator, priority: p.request && p.request.initialPriority, pageref: this._page().id });
    const x = this.extra.get(k);                     // ExtraInfo that beat us here (CDP order is not guaranteed)
    if (x) { const ri = this.reqInfo.get(k); if (x.req) ri.reqExtraHeaders = x.req; if (x.resp) { ri.respExtraHeaders = x.resp; ri.respHeadersText = x.respText; } this.extra.delete(k); }
  }
  responseReceived(p, sid = '') { const ri = this.reqInfo.get(this._key(sid, p.requestId)); if (ri) ri.response = p.response; }
  // *ExtraInfo carry the REAL wire headers: the request ones include Cookie/User-Agent (absent from
  // requestWillBeSent.request.headers), the response ones preserve every Set-Cookie (CDP's
  // response.headers merges/drops them). Note a redirect chain reuses the requestId, so on a hop the
  // stash is last-writer-wins — a tolerated approximation (DevTools matches these heuristically too).
  requestWillBeSentExtraInfo(p, sid = '') {
    const k = this._key(sid, p.requestId), ri = this.reqInfo.get(k);
    if (ri) ri.reqExtraHeaders = p.headers;
    else { const x = this.extra.get(k) || {}; x.req = p.headers; this.extra.set(k, x); }
  }
  responseReceivedExtraInfo(p, sid = '') {
    const k = this._key(sid, p.requestId), ri = this.reqInfo.get(k);
    if (ri) { ri.respExtraHeaders = p.headers; ri.respHeadersText = p.headersText; }
    else { const x = this.extra.get(k) || {}; x.resp = p.headers; x.respText = p.headersText; this.extra.set(k, x); }
  }
  // Σ dataReceived.encodedDataLength = the BODY-ONLY wire bytes (loadingFinished's total includes headers).
  dataReceived(p, sid = '') { const ri = this.reqInfo.get(this._key(sid, p.requestId)); if (ri) ri.bodyWire = (ri.bodyWire || 0) + (p.encodedDataLength || 0); }
  loadingFinished(p, sid = '') { const k = this._key(sid, p.requestId); const ri = this.reqInfo.get(k); let e = null; if (ri && ri.response) e = this._push(ri, ri.response, p.timestamp, p.encodedDataLength, undefined, sid); this.reqInfo.delete(k); this.extra.delete(k); return e; }
  loadingFailed(p, sid = '') { const k = this._key(sid, p.requestId); const ri = this.reqInfo.get(k); if (ri && ri.response) this._push(ri, ri.response, p.timestamp, 0, p.errorText, sid); this.reqInfo.delete(k); this.extra.delete(k); }
  // Load events land on the CURRENT page and never overwrite: each navigation fires its pair once, and a
  // late duplicate must not clobber the page it belongs to (the old single-page code let the last
  // navigation's events overwrite the first page's timings).
  domContentEventFired(p) { const pg = this._page(); if (pg && pg.domTs == null) pg.domTs = p.timestamp; }
  loadEventFired(p) { const pg = this._page(); if (pg && pg.loadTs == null) pg.loadTs = p.timestamp; }

  _push(ri, resp, finishTs, encoded, errorText, sid = '') {
    const t = resp.timing; const reqTs = t ? t.requestTime : null;
    const span = (a, b) => (t && t[a] >= 0 && t[b] >= 0 ? t[b] - t[a] : -1);
    const send = t ? Math.max(0, t.sendEnd - t.sendStart) : -1;
    const wait = t ? Math.max(0, t.receiveHeadersEnd - t.sendEnd) : -1;
    const totalMs = (reqTs != null && finishTs != null) ? (finishTs - reqTs) * 1000 : -1;
    const receive = (t && totalMs >= 0) ? Math.max(0, totalMs - t.receiveHeadersEnd) : -1;
    const firstOff = t ? [t.dnsStart, t.connectStart, t.sendStart].filter((v) => v >= 0) : [];
    const blocked = t ? (firstOff.length ? Math.max(0, Math.min(...firstOff)) : 0) : -1;
    const timings = { blocked, dns: span('dnsStart', 'dnsEnd'), connect: span('connectStart', 'connectEnd'),
      ssl: span('sslStart', 'sslEnd'), send, wait, receive, _blocked_queueing: blocked >= 0 ? blocked : 0 };
    // *ExtraInfo headers are the REAL wire headers (request side includes Cookie/UA, response side keeps
    // every Set-Cookie) — prefer them over the sanitized ones on the main events when they arrived.
    const reqH = ri.reqExtraHeaders || ri.request.headers;
    const rh = ri.respExtraHeaders || resp.headers || {};
    const post = ri.request.postData; const proto = resp.protocol || 'http/1.1';
    const postMime = getH(reqH, 'content-type') || getH(ri.request.headers, 'content-type');
    // Size split: Σ dataReceived.encodedDataLength (bodyWire) is the body-only wire size for ANY protocol,
    // so headersSize = total − body. Fallbacks: raw header text (HTTP/1.x only), else -1 (spec-legal).
    const bodyWire = ri.bodyWire ?? null;
    const headersSize = encoded > 0 && bodyWire != null ? Math.max(0, encoded - bodyWire)
      : ri.respHeadersText ? byteLen(ri.respHeadersText)
      : resp.headersText ? byteLen(resp.headersText) : -1;
    const e = {
      pageref: ri.pageref || 'page_1',
      startedDateTime: new Date((ri.wallTime || 0) * 1000).toISOString(),
      time: totalMs >= 0 ? totalMs : [timings.dns, timings.connect, send, wait].reduce((s, v) => s + (v > 0 ? v : 0), 0),
      request: { method: ri.request.method, url: ri.request.url, httpVersion: proto, cookies: reqCookies(reqH), headers: hdrArr(reqH),
        queryString: qsArr(ri.request.url),
        headersSize: resp.requestHeadersText ? byteLen(resp.requestHeadersText) : -1,   // raw request line+headers (HTTP/1.x only)
        bodySize: post ? byteLen(post) : 0,
        ...(post ? { postData: { mimeType: postMime, text: post,
          ...(postMime.includes('urlencoded') ? { params: urlParams(post) } : {}) } } : {}) },
      response: { status: resp.status, statusText: resp.statusText || '', httpVersion: proto, cookies: respCookies(rh), headers: respHdrArr(rh),
        // encoded = loadingFinished.encodedDataLength (the FULL wire size); resp.encodedDataLength is only the
        // bytes-so-far at responseReceived (header time) — a tiny partial that must NOT win. Prefer `encoded`.
        // attachBody() later refines this to the true decoded length when a body is embedded (gzipped text:
        // wire < decoded); wire is the honest proxy otherwise.
        content: { size: encoded || resp.encodedDataLength || 0, mimeType: resp.mimeType || '' },
        redirectURL: getH(rh, 'location'), headersSize,
        // spec: bodySize = body-only wire bytes. Exact when dataReceived was summed; otherwise the old
        // whole-message fallback (headers included) keeps the previous behaviour.
        bodySize: bodyWire != null ? bodyWire : (encoded || -1) },
      cache: {}, timings, _resourceType: (ri.type || '').toLowerCase(),
    };
    if (encoded > 0) { e.response._transferSize = encoded; this.wireBytes += encoded; } // wire bytes (headers+body) — DevTools "Size" column
    if (resp.connectionId) e.connection = String(resp.connectionId);
    if (resp.remoteIPAddress) e.serverIPAddress = resp.remoteIPAddress;
    if (ri.initiator) e._initiator = ri.initiator;                 // parser/script/preload + stack
    if (ri.priority) e._priority = ri.priority;                    // VeryHigh/High/Medium/Low/VeryLow
    if (sid) e._session = sid;                                     // OOPIF child session id (absent on top-frame entries) — lets a consumer scope to one frame
    if (errorText) { e.response._error = errorText; e._error = errorText; }
    this.entries.push(e);
    return e;
  }

  // spec: content.compression = bytes saved by content-encoding = decoded size − body wire size.
  // Only written when bodySize is the EXACT body-only wire figure (bodySize + headersSize == transfer
  // total, i.e. the dataReceived-sum path) — the whole-message fallback would fake the number.
  _compression(entry, decodedSize) {
    const r = entry.response;
    if (r.bodySize >= 0 && r.headersSize >= 0 && r._transferSize != null
      && r.bodySize + r.headersSize === r._transferSize && decodedSize - r.bodySize >= 0) {
      r.content.compression = decodedSize - r.bodySize;
    }
  }

  // Attach a recovered body (a getResponseBody result) onto an entry _push returned — HAR-standard
  // content.text[+encoding], which DevTools reads. Refines content.size to the DECODED length.
  attachBody(entry, body, base64Encoded) {
    if (!entry || body == null) return 0;
    entry.response.content.text = body;
    if (base64Encoded) entry.response.content.encoding = 'base64';
    const size = base64Encoded ? b64Size(body) : byteLen(body);
    entry.response.content.size = size;
    this._compression(entry, size);
    return size;
  }

  // Refine an entry's content.size to a known DECODED length without embedding the body (measure-only).
  setDecodedSize(entry, size) { if (entry && size >= 0) { entry.response.content.size = size; this._compression(entry, size); } return size; }

  // Assemble the final HAR — entries sorted by startedDateTime (request/initiation order, the DevTools
  // convention); one log.pages[] element per top-frame navigation, each timed against its OWN nav start.
  build(creator = 'har-tap') {
    const entries = [...this.entries].sort((a, b) => (Date.parse(a.startedDateTime) || 0) - (Date.parse(b.startedDateTime) || 0));
    const ms = (ts, anchor) => (ts != null && anchor != null) ? Math.round((ts - anchor) * 1e6) / 1e3 : -1;
    const pages = this.pages.map((pg) => ({
      startedDateTime: new Date(pg.wall * 1000).toISOString(), id: pg.id,
      title: pg.url,
      pageTimings: { onContentLoad: ms(pg.domTs, pg.mono), onLoad: ms(pg.loadTs, pg.mono) },
    }));
    return { log: { version: '1.2', creator: { name: creator, version: '1' },
      ...(this.browser ? { browser: this.browser } : {}), pages, entries } };
  }
}
