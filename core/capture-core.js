// capture-core.js — the chrome glue (MV3 service worker), factored as a reusable engine. Owns the
// chrome.debugger session per tab, wires its onEvent CDP stream into a pure HarTap (har.js), and hands
// the assembled HAR back to the popup. chrome.debugger IS the CDP channel DevTools speaks, so
// Network.enable + responseReceived/loadingFinished + getResponseBody map 1:1 onto the DevTools Network panel.
//
// This is the SHARED core. har-tap wires it with the bundled throttle plugin (plugins/throttle.js — also
// the reference plugin). A downstream consumer can pass plugins that add extra behaviour through the hook
// seams below, WITHOUT copying this file. With plugins:[] every seam is a no-op.
//
// Plugin hook surface (all optional, all wrapped so a throwing plugin can't break a capture):
//   initSession(sess, opts) → truthy string aborts the start with that error (e.g. a rejected option)
//   onRootAttach({ send, tabId, sess })      — after Network/Page enable on the root, BEFORE navigate (inject page scripts here)
//   onChildAttach({ send, child, sess })     — after Network.enable on an OOPIF child session
//   onStart({ tabId, sess })                 — capture is live (set a badge, etc.)
//   onEvent({ method, params, sid, target, sess, send })   — every CDP event, before the core HAR switch
//   onLoadingFinished({ entry, params, sid, target, sess, send })  — after the core builds the entry
//   tick({ sess, tabId, send }) + tickMs     — periodic poll (core runs one interval at the min tickMs)
//   finalize({ sess, har }) → object         — merged into the stop result + stored meta (extra fields)
//   status(sess) → object                    — merged into the live status the popup polls
//   onDetach(sess)                           — the debugger detached / tab closed (cleanup)
//
// MV3 lifetime caveat: this SW can be evicted after ~30s idle, which would drop the in-memory entries.
// During an active capture the continuous onEvent stream keeps it warm, so a page's load (a dense burst of
// requests) is fine; a long idle mid-capture is the risk.

import { HarTap } from './har.js';

export function createCapture(config = {}) {
  const plugins = config.plugins || [];
  const creator = config.creator || 'har-tap';
  const HAR_KEY = config.harKey || 'harTapHar';           // last finished HAR, saved so Download survives a popup reopen
  const HAR_META_KEY = config.metaKey || 'harTapHarMeta';  // its summary {count, wireBytes, bodyBytes, includeBodies}

  const sessions = new Map(); // tabId → { tap, includeBodies, disableCache, bodyCap, bodyBudget, bodyBytes, children, started, _tick }
  // log.browser for the HAR — the SW's UA names the Chrome doing the capturing.
  const BROWSER = (() => { try { const m = (navigator.userAgent || '').match(/Chrome\/([\d.]+)/); return m ? { name: 'Chrome', version: m[1] } : null; } catch { return null; } })();
  const tickMs = Math.min(Infinity, ...plugins.map((p) => (p.tickMs > 0 ? p.tickMs : Infinity)));

  // Run a plugin hook across all plugins, isolating failures. Sync form for observers; hooks that must
  // complete before the next CDP command (onRootAttach/onChildAttach) use the async form.
  const runHook = (name, arg) => { for (const p of plugins) { if (p[name]) { try { p[name](arg); } catch (e) { console.warn('capture: plugin', name, 'threw', e); } } } };
  const runHookAsync = async (name, arg) => { for (const p of plugins) { if (p[name]) { try { await p[name](arg); } catch (e) { console.warn('capture: plugin', name, 'threw', e); } } } };

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

  function startTick(tabId, sess) {
    if (!isFinite(tickMs)) return;
    sess._tick = setInterval(() => runHook('tick', { sess, tabId, send }), tickMs);
  }
  function stopTick(sess) { if (sess && sess._tick) { clearInterval(sess._tick); sess._tick = null; } }

  chrome.debugger.onEvent.addListener((source, method, params) => {
    const sess = sessions.get(source.tabId);
    if (!sess) return;
    const tap = sess.tap;
    const sid = source.sessionId || '';               // '' = top/root frame; non-empty = an OOPIF child session
    const target = source.sessionId ? { tabId: source.tabId, sessionId: source.sessionId } : { tabId: source.tabId };
    // Plugin observers see EVERY event before the core HAR handling (request tallies, a network gate, dialog
    // auto-accept, …). Entry-dependent work waits for onLoadingFinished below, where the entry exists.
    runHook('onEvent', { method, params, sid, target, sess, send });
    switch (method) {
      case 'Network.requestWillBeSent': tap.requestWillBeSent(params, sid); break;
      case 'Network.requestWillBeSentExtraInfo': tap.requestWillBeSentExtraInfo(params, sid); break;   // real wire request headers (Cookie/UA)
      case 'Network.responseReceived': tap.responseReceived(params, sid); break;
      case 'Network.responseReceivedExtraInfo': tap.responseReceivedExtraInfo(params, sid); break;     // full Set-Cookie list + raw header text
      case 'Network.dataReceived': tap.dataReceived(params, sid); break;                               // body-only wire bytes → bodySize/headersSize split
      case 'Network.loadingFinished': {
        const entry = tap.loadingFinished(params, sid);
        if (entry && sess.includeBodies) recoverBody(target, params.requestId, entry, sess);
        if (entry) runHook('onLoadingFinished', { entry, params, sid, target, sess, send });
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
      await runHookAsync('onChildAttach', { send, child, sess });   // a plugin can inject its page script into this frame
      await send(child, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }).catch(() => {});
    } catch { /* child target already gone */ }
    finally { if (params.waitingForDebugger) await send(child, 'Runtime.runIfWaitingForDebugger').catch(() => {}); }
  }

  // If the user closes the tab, opens DevTools on it (only one debugger client per tab), or Chrome
  // detaches us, drop the session so a stale entry can't linger.
  chrome.debugger.onDetach.addListener((source) => {
    const sess = sessions.get(source.tabId);
    if (sess) { stopTick(sess); runHook('onDetach', sess); }
    sessions.delete(source.tabId);
  });

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
      tap: Object.assign(new HarTap(), { browser: BROWSER }),
      includeBodies: !!opts.includeBodies,
      disableCache: opts.disableCache !== false,
      bodyCap: opts.bodyCap ?? 1024 * 1024,       // skip any single body over this (bytes)
      bodyBudget: opts.bodyBudget ?? 64 * 1024 * 1024, // stop embedding once total base64 bodies pass this
      bodyBytes: 0, children: 0, started: Date.now(), _tick: null,
    };
    // Plugins seed their own per-session state (and can reject the start, e.g. a bad plugin option).
    for (const p of plugins) {
      if (!p.initSession) continue;
      let err = null;
      try { err = p.initSession(sess, opts); } catch (e) { err = e instanceof Error ? e.message : String(e); }
      if (err) return { ok: false, error: String(err) };
    }
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
      // Tell the tap which frame is the TOP one: only its Document requests open a new HAR page
      // (same-origin iframes ride the root session too and must not split the log).
      try { sess.tap.mainFrameId = (await send({ tabId }, 'Page.getFrameTree'))?.frameTree?.frame?.id || null; }
      catch { /* stays null → single-page log, as before */ }
      await runHookAsync('onRootAttach', { send, tabId, sess });   // inject page scripts before the navigate, so they run on the new document
      sessions.set(tabId, sess);
      runHook('onStart', { tabId, sess });
      startTick(tabId, sess);
      if (opts.reload !== false) {
        // Wipe the HTTP cache so the capture is a real cold load (setCacheDisabled bypasses it for this
        // session; clearBrowserCache also drops what's already stored).
        if (sess.disableCache) await send({ tabId }, 'Network.clearBrowserCache').catch(() => {});
        if (navUrl) {
          // Navigate to the user-supplied URL (may differ from the current tab) instead of reloading in place.
          const res = await send({ tabId }, 'Page.navigate', { url: navUrl }); // first request ≈ nav start
          // opts.tolerateNavError (set by a plugin's startOpts): the nav is EXPECTED to fail and the failed
          // load is the data — e.g. offline throttling — so don't turn it into a fatal start error.
          if (res && res.errorText && !opts.tolerateNavError) throw new Error('navigate failed: ' + res.errorText);
        } else {
          await send({ tabId }, 'Page.reload', { ignoreCache: true }); // first request ≈ nav start
        }
      }
      return { ok: true, tabId };   // may be a freshly-opened tab; the popup switches its polling/stop to it
    } catch (e) {
      stopTick(sess);
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
    stopTick(sess);
    await detach(tabId);
    const har = sess.tap.build(creator);
    let meta = { count: har.log.entries.length, wireBytes: sess.tap.wireBytes, bodyBytes: sess.bodyBytes, includeBodies: sess.includeBodies, sinceMs };
    // Plugins contribute extra result fields merged into the stored meta + the reply.
    for (const p of plugins) { if (p.finalize) { try { const x = p.finalize({ sess, har }); if (x) meta = { ...meta, ...x }; } catch (e) { console.warn('capture: plugin finalize threw', e); } } }
    // Persist so a finished capture survives the popup closing/reopening. The full HAR (potentially large)
    // is read only when the user clicks Download; the popup restores the summary from the small meta key.
    await chrome.storage.local.set({ [HAR_KEY]: har, [HAR_META_KEY]: meta }).catch(() => {});
    return { ok: true, ...meta };
  }

  function statusOf(tabId) {
    const sess = sessions.get(tabId);
    if (!sess) return { capturing: false };
    let st = { capturing: true, count: sess.tap.entries.length, wireBytes: sess.tap.wireBytes, bodyBytes: sess.bodyBytes, includeBodies: sess.includeBodies, sinceMs: Date.now() - sess.started, frames: 1 + (sess.children || 0) };
    for (const p of plugins) { if (p.status) { try { const x = p.status(sess); if (x) st = { ...st, ...x }; } catch (e) { console.warn('capture: plugin status threw', e); } } }
    return st;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'start') { startCapture(msg.tabId, msg.opts).then(sendResponse); return true; }
    if (msg.type === 'stop') { stopCapture(msg.tabId).then(sendResponse); return true; }
    if (msg.type === 'status') { sendResponse(statusOf(msg.tabId)); return false; }
  });

  // Expose the internals a plugin's own module-level code might need (e.g. registering an extra onMessage
  // handler that reads a session). Returning them keeps createCapture a black box for the common case.
  return { sessions, send, startCapture, stopCapture, statusOf };
}
