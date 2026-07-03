// har.js — a PURE HAR-entry builder. No chrome.* and no Node builtins, so it runs unchanged in a
// service worker AND is unit-testable in Node. background.js feeds it raw CDP events (chrome.debugger's
// onEvent params are the same shapes the DevTools Network domain emits), and this assembles a standard
// HAR 1.2 log (entries + pages/pageTimings) that Chrome DevTools and any HAR viewer can import.

const hdrArr = (h) => Object.entries(h || {}).map(([name, value]) => ({ name, value: String(value) }));
const qsArr = (u) => { try { const out = []; for (const [name, value] of new URL(u).searchParams) out.push({ name, value }); return out; } catch { return []; } };
const reqCookies = (h) => { const c = (h && (h.Cookie || h.cookie)) || ''; return c ? String(c).split(/;\s*/).filter(Boolean).map((kv) => { const i = kv.indexOf('='); return { name: i < 0 ? kv : kv.slice(0, i), value: i < 0 ? '' : kv.slice(i + 1) }; }) : []; };
const respCookies = (h) => { const raw = (h && (h['set-cookie'] || h['Set-Cookie'])) || ''; if (!raw) return []; return String(raw).split('\n').filter(Boolean).map((line) => { const [nv, ...attrs] = line.split(/;\s*/); const i = nv.indexOf('='); const c = { name: i < 0 ? nv : nv.slice(0, i), value: i < 0 ? '' : nv.slice(i + 1) }; for (const a of attrs) { const j = a.indexOf('='); const k = (j < 0 ? a : a.slice(0, j)).toLowerCase(); const v = j < 0 ? '' : a.slice(j + 1); if (k === 'path') c.path = v; else if (k === 'domain') c.domain = v; else if (k === 'expires') c.expires = v; else if (k === 'httponly') c.httpOnly = true; else if (k === 'secure') c.secure = true; else if (k === 'samesite') c.sameSite = v; } return c; }); };
// Buffer.byteLength has no browser equivalent → TextEncoder.
export const byteLen = (s) => new TextEncoder().encode(String(s || '')).length;
// decoded body size from a getResponseBody result (base64 → 3/4 of the string, minus padding).
export const b64Size = (s) => { const n = s.length; const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0; return Math.max(0, (n * 3 >> 2) - pad); };

export class HarTap {
  constructor() {
    this.reqInfo = new Map();          // (sessionId,requestId) → { request, wallTime, type, initiator, priority, response? }
    this.entries = [];
    this.wireBytes = 0;                // running sum of encodedDataLength (real bytes on the wire, headers+body)
    this.navMono = null; this.navWall = null; this.domTs = null; this.loadTs = null;
    this.pageUrl = '';
  }

  // --- CDP event handlers (same names/shapes as the CDP Network domain) ---
  // `sid` = the chrome.debugger child-session id for OOPIF frames (empty for the top/root session).
  // A requestId is only unique WITHIN a session, so different targets reuse '1','2',… — key reqInfo by
  // (sid, requestId) or cross-frame requests collide. getResponseBody still needs the raw requestId+session.
  _key(sid, requestId) { return sid + '\x00' + requestId; }
  requestWillBeSent(p, sid = '') {
    if (this.navMono == null && !sid) { this.navMono = p.timestamp; this.navWall = p.wallTime; this.pageUrl = p.documentURL || (p.request && p.request.url) || ''; } // first ROOT request ≈ navigation start
    const k = this._key(sid, p.requestId);
    if (p.redirectResponse) { const ri = this.reqInfo.get(k); if (ri) this._push(ri, p.redirectResponse, p.timestamp, 0); } // emit the redirect hop
    this.reqInfo.set(k, { request: p.request, wallTime: p.wallTime, type: p.type, initiator: p.initiator, priority: p.request && p.request.initialPriority });
  }
  responseReceived(p, sid = '') { const ri = this.reqInfo.get(this._key(sid, p.requestId)); if (ri) ri.response = p.response; }
  loadingFinished(p, sid = '') { const k = this._key(sid, p.requestId); const ri = this.reqInfo.get(k); let e = null; if (ri && ri.response) e = this._push(ri, ri.response, p.timestamp, p.encodedDataLength); this.reqInfo.delete(k); return e; }
  loadingFailed(p, sid = '') { const k = this._key(sid, p.requestId); const ri = this.reqInfo.get(k); if (ri && ri.response) this._push(ri, ri.response, p.timestamp, 0, p.errorText); this.reqInfo.delete(k); }
  domContentEventFired(p) { this.domTs = p.timestamp; }
  loadEventFired(p) { this.loadTs = p.timestamp; }

  _push(ri, resp, finishTs, encoded, errorText) {
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
    const rh = resp.headers || {}; const post = ri.request.postData; const proto = resp.protocol || 'http/1.1';
    const e = {
      pageref: 'page_1',
      startedDateTime: new Date((ri.wallTime || 0) * 1000).toISOString(),
      time: totalMs >= 0 ? totalMs : [timings.dns, timings.connect, send, wait].reduce((s, v) => s + (v > 0 ? v : 0), 0),
      request: { method: ri.request.method, url: ri.request.url, httpVersion: proto, cookies: reqCookies(ri.request.headers), headers: hdrArr(ri.request.headers),
        queryString: qsArr(ri.request.url), headersSize: -1, bodySize: post ? byteLen(post) : 0,
        ...(post ? { postData: { mimeType: (ri.request.headers || {})['Content-Type'] || '', text: post } } : {}) },
      response: { status: resp.status, statusText: resp.statusText || '', httpVersion: proto, cookies: respCookies(rh), headers: hdrArr(rh),
        // encoded = loadingFinished.encodedDataLength (the FULL wire size); resp.encodedDataLength is only the
        // bytes-so-far at responseReceived (header time) — a tiny partial that must NOT win. Prefer `encoded`.
        // attachBody() later refines this to the true decoded length when a body is embedded (gzipped text:
        // wire < decoded); wire is the honest proxy otherwise.
        content: { size: encoded || resp.encodedDataLength || 0, mimeType: resp.mimeType || '' },
        redirectURL: rh.location || rh.Location || '', headersSize: -1, bodySize: encoded || -1 },
      cache: {}, timings, _resourceType: (ri.type || '').toLowerCase(),
    };
    if (encoded > 0) { e.response._transferSize = encoded; this.wireBytes += encoded; } // wire bytes (headers+body) — DevTools "Size" column
    if (resp.connectionId) e.connection = String(resp.connectionId);
    if (resp.remoteIPAddress) e.serverIPAddress = resp.remoteIPAddress;
    if (ri.initiator) e._initiator = ri.initiator;                 // parser/script/preload + stack
    if (ri.priority) e._priority = ri.priority;                    // VeryHigh/High/Medium/Low/VeryLow
    if (errorText) { e.response._error = errorText; e._error = errorText; }
    this.entries.push(e);
    return e;
  }

  // Attach a recovered body (a getResponseBody result) onto an entry _push returned — HAR-standard
  // content.text[+encoding], which DevTools reads. Refines content.size to the DECODED length.
  attachBody(entry, body, base64Encoded) {
    if (!entry || body == null) return 0;
    entry.response.content.text = body;
    if (base64Encoded) entry.response.content.encoding = 'base64';
    const size = base64Encoded ? b64Size(body) : byteLen(body);
    entry.response.content.size = size;
    return size;
  }

  // Assemble the final HAR — entries sorted by startedDateTime (request/initiation order, the DevTools
  // convention) with log.pages[].pageTimings.
  build(creator = 'har-tap') {
    const entries = [...this.entries].sort((a, b) => (Date.parse(a.startedDateTime) || 0) - (Date.parse(b.startedDateTime) || 0));
    const ms = (ts) => (ts != null && this.navMono != null) ? Math.round((ts - this.navMono) * 1e6) / 1e3 : -1;
    const pages = this.navWall != null ? [{
      startedDateTime: new Date(this.navWall * 1000).toISOString(), id: 'page_1',
      title: this.pageUrl || (entries[0] && entries[0].request.url) || '',
      pageTimings: { onContentLoad: ms(this.domTs), onLoad: ms(this.loadTs) },
    }] : [];
    return { log: { version: '1.2', creator: { name: creator, version: '1' }, pages, entries } };
  }
}
