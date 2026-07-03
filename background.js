// background.js — the chrome glue (MV3 service worker). Owns the chrome.debugger session per tab, wires
// its onEvent CDP stream into a pure HarTap (har.js), and hands the assembled HAR back to the popup.
// chrome.debugger IS the CDP channel DevTools speaks, so Network.enable + responseReceived/loadingFinished
// + getResponseBody map 1:1 onto the DevTools Network panel.
//
// MV3 lifetime caveat: this SW can be evicted after ~30s idle, which would drop the in-memory entries.
// During an active capture the continuous onEvent stream keeps it warm, so a page's load (a dense burst of
// requests) is fine; a long idle mid-capture is the risk.

import { HarTap } from './har.js';

const sessions = new Map(); // tabId → { tap, includeBodies, disableCache, bodyCap, bodyBudget, bodyBytes, children, started }
const HAR_KEY = 'harTapHar';           // last finished HAR, saved so Download survives a popup reopen
const HAR_META_KEY = 'harTapHarMeta';  // its summary {count, wireBytes, bodyBytes, includeBodies}

// target = a chrome.debugger DebuggerSession: {tabId} for the root, {tabId, sessionId} for an OOPIF child.
const send = (target, method, params = {}) => new Promise((resolve, reject) => {
  chrome.debugger.sendCommand(target, method, params, (res) => {
    const err = chrome.runtime.lastError;
    if (err) reject(new Error(err.message)); else resolve(res);
  });
});
const attach = (tabId) => new Promise((resolve, reject) => {
  chrome.debugger.attach({ tabId }, '1.3', () => {
    const err = chrome.runtime.lastError;
    if (err) reject(new Error(err.message)); else resolve();
  });
});
const detach = (tabId) => new Promise((resolve) => chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; resolve(); }));

chrome.debugger.onEvent.addListener((source, method, params) => {
  const sess = sessions.get(source.tabId);
  if (!sess) return;
  const tap = sess.tap;
  const sid = source.sessionId || '';               // '' = top/root frame; non-empty = an OOPIF child session
  const target = source.sessionId ? { tabId: source.tabId, sessionId: source.sessionId } : { tabId: source.tabId };
  switch (method) {
    case 'Network.requestWillBeSent': tap.requestWillBeSent(params, sid); break;
    case 'Network.responseReceived': tap.responseReceived(params, sid); break;
    case 'Network.loadingFinished': {
      const entry = tap.loadingFinished(params, sid);
      if (entry && sess.includeBodies) recoverBody(target, params.requestId, entry, sess);
      break;
    }
    case 'Network.loadingFailed': tap.loadingFailed(params, sid); break;
    case 'Page.domContentEventFired': if (!sid) tap.domContentEventFired(params); break; // top-page timings only
    case 'Page.loadEventFired': if (!sid) tap.loadEventFired(params); break;
    case 'Target.attachedToTarget': onChildTarget(sess, source.tabId, params); break;    // an OOPIF frame appeared
  }
});

// A cross-origin child frame (OOPIF) auto-attached. Enable the same Network tap on ITS session, disable
// its cache, and recurse (setAutoAttach is NOT recursive — each session must arm its own children). The
// frame is paused (waitForDebuggerOnStart) until we runIfWaitingForDebugger, so we miss none of its requests.
async function onChildTarget(sess, tabId, params) {
  const child = { tabId, sessionId: params.sessionId };
  sess.children = (sess.children || 0) + 1;
  try {
    await send(child, 'Network.enable');
    if (sess.disableCache) await send(child, 'Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {});
    await send(child, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }).catch(() => {});
  } catch { /* child target already gone */ }
  finally { if (params.waitingForDebugger) await send(child, 'Runtime.runIfWaitingForDebugger').catch(() => {}); }
}

// If the user closes the tab, opens DevTools on it (only one debugger client per tab), or Chrome
// detaches us, drop the session so a stale entry can't linger.
chrome.debugger.onDetach.addListener((source) => { sessions.delete(source.tabId); });

async function recoverBody(target, requestId, entry, sess) {
  if (sess.bodyBytes >= sess.bodyBudget) return; // overall memory guard for the SW
  try {
    const r = await send(target, 'Network.getResponseBody', { requestId }); // getResponseBody needs the OWNING session
    if (r && r.body != null) {
      const size = r.base64Encoded ? Math.max(0, (r.body.length * 3 >> 2)) : new TextEncoder().encode(r.body).length;
      if (size <= sess.bodyCap) sess.bodyBytes += sess.tap.attachBody(entry, r.body, r.base64Encoded);
    }
  } catch { /* body evicted / target gone — a tolerated failure */ }
}

// URLs chrome.debugger refuses to attach to (chrome://…, the Web Store, devtools, …). A capture on such a
// page can only run in a fresh, attachable tab.
function cannotAttach(url) {
  try {
    const u = new URL(url);
    if (['chrome:', 'chrome-extension:', 'chrome-untrusted:', 'devtools:', 'view-source:'].includes(u.protocol)) return true;
    if (u.hostname === 'chromewebstore.google.com') return true;
    if (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore')) return true;
    return false;
  } catch { return true; } // no/unparseable URL → treat as unattachable
}

async function startCapture(tabId, opts = {}) {
  const navUrl = (opts.url || '').trim();
  // If the active tab is a page we can't attach to, capture in a new tab instead — but only when Reload is on
  // and a URL is given, since that new tab needs somewhere to navigate.
  let curUrl = '';
  try { curUrl = (await chrome.tabs.get(tabId)).url || ''; } catch { /* tab gone */ }
  if (cannotAttach(curUrl)) {
    if (!(opts.reload !== false && navUrl)) return { ok: false, error: "can't capture this page — enter a URL with Reload on to open it in a new tab" };
    try { tabId = (await chrome.tabs.create({ url: 'about:blank', active: true })).id; }
    catch (e) { return { ok: false, error: 'could not open a new tab: ' + (e instanceof Error ? e.message : String(e)) }; }
  }
  if (sessions.has(tabId)) return { ok: false, error: 'already capturing this tab' };
  const sess = {
    tap: new HarTap(),
    includeBodies: !!opts.includeBodies,
    disableCache: opts.disableCache !== false,
    bodyCap: opts.bodyCap ?? 1024 * 1024,       // skip any single body over this (bytes)
    bodyBudget: opts.bodyBudget ?? 64 * 1024 * 1024, // stop embedding once total base64 bodies pass this
    bodyBytes: 0, children: 0, started: Date.now(),
  };
  try {
    await attach(tabId);
    await send({ tabId }, 'Network.enable');
    // Disable cache for the WHOLE session, not just the reload. Page.reload's ignoreCache only covers the
    // reload's own requests; runtime XHR/image loads still hit the HTTP cache, and a cache hit reports
    // encodedDataLength=0 → byte accounting collapses on a warm run. Disabling cache gives real wire bytes.
    if (sess.disableCache) await send({ tabId }, 'Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {});
    // OOPIF: a page embedded in a CROSS-ORIGIN <iframe> becomes an out-of-process iframe whose network the
    // top session can't see. Auto-attach with flatten routes each child frame's events through onEvent with
    // source.sessionId. Armed BEFORE reload so a child frame is caught the moment it goes cross-origin.
    await send({ tabId }, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }).catch(() => {});
    await send({ tabId }, 'Page.enable').catch(() => {});
    sessions.set(tabId, sess);
    if (opts.reload !== false) {
      // Wipe the HTTP cache so the capture is a real cold load (setCacheDisabled bypasses it for this
      // session; clearBrowserCache also drops what's already stored).
      if (sess.disableCache) await send({ tabId }, 'Network.clearBrowserCache').catch(() => {});
      if (navUrl) {
        // Navigate to the user-supplied URL (may differ from the current tab) instead of reloading in place.
        const res = await send({ tabId }, 'Page.navigate', { url: navUrl }); // first request ≈ nav start
        if (res && res.errorText) throw new Error('navigate failed: ' + res.errorText);
      } else {
        await send({ tabId }, 'Page.reload', { ignoreCache: true }); // first request ≈ nav start
      }
    }
    return { ok: true, tabId };   // may be a freshly-opened tab; the popup switches its polling/stop to it
  } catch (e) {
    sessions.delete(tabId);
    await detach(tabId);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function stopCapture(tabId) {
  const sess = sessions.get(tabId);
  if (!sess) return { ok: false, error: 'not capturing this tab' };
  const sinceMs = Date.now() - sess.started;   // total capture duration, measured at the stop click
  sessions.delete(tabId);
  await detach(tabId);
  const har = sess.tap.build();
  const meta = { count: har.log.entries.length, wireBytes: sess.tap.wireBytes, bodyBytes: sess.bodyBytes, includeBodies: sess.includeBodies, sinceMs };
  // Persist so a finished capture survives the popup closing/reopening. The full HAR (potentially large)
  // is read only when the user clicks Download; the popup restores the summary from the small meta key.
  await chrome.storage.local.set({ [HAR_KEY]: har, [HAR_META_KEY]: meta }).catch(() => {});
  return { ok: true, ...meta };
}

function statusOf(tabId) {
  const sess = sessions.get(tabId);
  if (!sess) return { capturing: false };
  return { capturing: true, count: sess.tap.entries.length, wireBytes: sess.tap.wireBytes, bodyBytes: sess.bodyBytes, includeBodies: sess.includeBodies, sinceMs: Date.now() - sess.started, frames: 1 + (sess.children || 0) };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'start') { startCapture(msg.tabId, msg.opts).then(sendResponse); return true; }
  if (msg.type === 'stop') { stopCapture(msg.tabId).then(sendResponse); return true; }
  if (msg.type === 'status') { sendResponse(statusOf(msg.tabId)); return false; }
});
