# HAR Tap

A small **Manifest V3** Chrome extension that captures a tab's network traffic into a standard **HAR 1.2**
file using the browser's [`chrome.debugger`](https://developer.chrome.com/docs/extensions/reference/api/debugger)
API. `chrome.debugger` is the same CDP channel DevTools speaks, so the capture uses `Network.enable` +
`responseReceived`/`loadingFinished` + `getResponseBody` — the exact events the DevTools Network panel shows —
and includes **cross-origin (OOPIF) iframes**, which a naive top-frame tap misses.

It is a load-unpacked developer tool. The `debugger` permission draws heavy Web Store review, and personal
use doesn't need a listing, so this isn't packaged for the store.

## Files

| file | role |
|---|---|
| `manifest.json` | MV3, `debugger` + `tabs` + `storage` + `unlimitedStorage` permissions, module service worker |
| `har.js` | **pure** HAR-entry builder (no `chrome.*`, no Node) — unit-testable in isolation |
| `background.js` | service worker: owns the `chrome.debugger` session, wires CDP events → `HarTap`, handles OOPIF auto-attach |
| `popup.html` / `popup.js` | two-button UI (Start · Stop→Download; URL + checkbox choices persisted; finished HAR saved so Download survives reopen) + live counter + Blob download of `<host>.har` |

`har.js` and `background.js` are split along a "pure logic vs. browser glue" line: `har.js` runs unchanged in
Node, so the HAR assembly can be tested without a browser.

## Install (load unpacked)

1. `chrome://extensions`
2. toggle **Developer mode** (top-right)
3. **Load unpacked** → pick this folder
4. pin **HAR Tap** from the puzzle-piece menu

Reload after edits with the ⟳ button on its card (no build step).

## Use

1. Open the target tab. **Close DevTools on that tab** — only one debugger client per tab.
2. Click **HAR Tap** → **Start**. Chrome shows a yellow *"…is debugging this browser"* bar (expected; the
   page can't read it). With *Reload on start* checked it reloads so the first request ≈ navigation start.
3. Watch the live counter — entries, **wire** bytes (real `encodedDataLength` on the wire), embedded **bodies**
   (only shown when *Embed response bodies* is on), and a **frames** count if a cross-origin iframe attaches.
4. Click **Stop** to end the capture; the second button turns into **Download**. Click **Download** to save
   `<host>.har`. Open it in Chrome DevTools → Network → import, or any HAR viewer.

If the active tab is a page `chrome.debugger` can't attach to (a `chrome://` settings page, the Web Store, …),
the button reads **Start in new tab** and captures the URL in a fresh tab instead — as long as *Reload on start*
is on and a URL is filled in (that new tab needs somewhere to navigate).

A finished capture is saved (`chrome.storage.local`, hence `unlimitedStorage`), so **Download** still works after
you close and reopen the popup. Starting a new capture or downloading clears it.

## Byte accounting — the warm-cache trap

Sizing a capture from `encodedDataLength` alone is unreliable: on a warm cache, a cache hit reports
`encodedDataLength: 0`, so those assets would log 0 bytes. Two mitigations, both here:

- **disable cache** (checkbox, default on) — sends `Network.setCacheDisabled` for the whole session, so every
  request goes over the wire and `encodedDataLength` is real. Unlike `Page.reload`'s `ignoreCache` (which only
  covers the reload's own requests, not later runtime XHR/image loads).
- **embed bodies** (checkbox) — pulls each body via `getResponseBody` into HAR-standard
  `content.text`(+`encoding:base64`) and sets `content.size` to the **decoded** length. Note binary bodies
  come back as base64, so no text re-encoding corruption. Cache-disable alone gives wire-byte sizes; embedding
  bodies is what yields decoded sizes for gzipped text.

## Cross-origin iframes (OOPIF)

A page embedded in a **cross-origin `<iframe>`** becomes an out-of-process iframe: a separate renderer and a
separate CDP target the top-tab Network tap can't see. `background.js` arms
`Target.setAutoAttach {autoAttach, waitForDebuggerOnStart, flatten:true}` on the root before reload. Each child
frame then auto-attaches: it gets its own `Network.enable` + `setCacheDisabled`, re-arms `setAutoAttach` on
itself (auto-attach is **not** recursive — every session must arm its own children), and
`runIfWaitingForDebugger` (the frame is paused at start, so no request is missed).

Child events arrive via `onEvent` with `source.sessionId`. RequestIds are only unique per-session, so `HarTap`
namespaces its request map by `(sessionId, requestId)` or cross-frame requests would collide. The popup shows
a **frames** count once >1 so you can see a child frame attach. (Requires a Chrome with `chrome.debugger`
`sessionId` support — ~M125+.)

## Limits

- **New tab / window**: capture is per attached tab. Content opened in a *new tab* (not an iframe) isn't
  followed — start the capture on that tab.
- **MV3 SW lifetime**: entries live in the service worker's memory. A dense load burst keeps it warm, but a
  long idle mid-capture could evict it.

## License

MIT — see [LICENSE](LICENSE).
