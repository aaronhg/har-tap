// plugins/throttle.js — DevTools-parity network throttling, written against the core plugin seams
// (capture side + popup side in one module). The preset values are Chrome DevTools' own — copied from
// Chromium front_end/core/sdk/NetworkManager.ts, i.e. exactly what the DevTools Network panel sends
// over CDP Network.emulateNetworkConditions: throughput in bytes/s and latency in ms including
// DevTools' adjustment factors, plus the connectionType it derives from each preset. No chrome.* at
// module level: the presets and the capture hooks are unit-tested in Node (test/throttle.test.js).

export const THROTTLE_PRESETS = {
  fast4g: { label: 'Fast 4G', latency: 60 * 2.75, downloadThroughput: 9 * 1000 * 1000 / 8 * 0.9, uploadThroughput: 1.5 * 1000 * 1000 / 8 * 0.9, connectionType: 'cellular4g' },
  slow4g: { label: 'Slow 4G', latency: 150 * 3.75, downloadThroughput: 1.6 * 1000 * 1000 / 8 * 0.9, uploadThroughput: 750 * 1000 / 8 * 0.9, connectionType: 'cellular4g' },
  '3g': { label: '3G', latency: 400 * 5, downloadThroughput: 500 * 1000 / 8 * 0.8, uploadThroughput: 500 * 1000 / 8 * 0.8, connectionType: 'cellular3g' },
  offline: { label: 'Offline', offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0, connectionType: 'none' },
};
export const throttleParams = (p) => ({ offline: !!p.offline, latency: p.latency, downloadThroughput: p.downloadThroughput, uploadThroughput: p.uploadThroughput, connectionType: p.connectionType });

// emulateNetworkConditions is PER SESSION: the same command goes to the root at attach and to every
// OOPIF child — same rule as setCacheDisabled. A failed apply must not leave a lying stamp behind
// (the whole point of _throttling is recording the TRUE conditions): a root failure clears the preset
// so the capture is honestly unthrottled; child failures are counted into the stamp.
async function applyConditions(send, target, sess, isRoot) {
  if (!sess.throttle) return;
  try {
    await send(target, 'Network.emulateNetworkConditions', throttleParams(sess.throttle));
  } catch (e) {
    if (isRoot) {
      sess.throttle = null;
      console.warn('throttle: emulate failed on the root — capture runs UNthrottled', e);
    } else {
      sess.throttleMisses = (sess.throttleMisses || 0) + 1;
      console.warn('throttle: emulate failed on an OOPIF child — that frame is unthrottled', e);
    }
  }
}

export function throttleCapture() {
  return {
    initSession(sess, opts) {
      const key = opts.throttle || 'none';
      if (key === 'none') { sess.throttle = null; return; }
      const p = THROTTLE_PRESETS[key];
      if (!p) return `unknown throttling preset: ${key}`;
      sess.throttle = p;
    },
    onRootAttach: ({ send, tabId, sess }) => applyConditions(send, { tabId }, sess, true),
    onChildAttach: ({ send, child, sess }) => applyConditions(send, child, sess, false),
    status(sess) { return sess.throttle ? { throttle: sess.throttle.label } : null; },
    finalize({ sess, har }) {
      if (!sess.throttle) return null;
      // Stamp the label AND the applied numbers: preset names drift across Chrome versions (Fast 3G
      // became Slow 4G, with different values) — the numbers keep the file self-describing.
      har.log._throttling = {
        label: sess.throttle.label,
        ...throttleParams(sess.throttle),
        ...(sess.throttleMisses ? { unthrottledFrames: sess.throttleMisses } : {}),
      };
      return { throttle: sess.throttle.label };
    },
  };
}

// Popup-side plugin: the DevTools-style select (same menu structure: Disabled / Presets), persisted
// and disabled-during-capture like the base options via optionIds. The presets optgroup is generated
// from THROTTLE_PRESETS so the menu can't drift from the capture side, and the styling ships INSIDE
// optionsHtml (against the host's CSS custom properties) so a consumer embedding this plugin in a
// different popup gets a themed control without editing their host page.
export function throttlePopup() {
  const presets = Object.entries(THROTTLE_PRESETS)
    .map(([key, p]) => `<option value="${key}">${p.label}</option>`).join('');
  return {
    optionsHtml: `
      <style>
        .row-label { justify-content: space-between; }
        .row-label select { font: 12px var(--font); background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 5px 8px; cursor: pointer; }
        .row-label select:disabled { opacity: .6; cursor: default; }
      </style>
      <label class="row-label" for="throttle">Throttling
        <select id="throttle">
          <optgroup label="Disabled"><option value="none" selected>No throttling</option></optgroup>
          <optgroup label="Presets">${presets}</optgroup>
        </select>
      </label>`,
    optionIds: ['throttle'],
    startOpts: ($) => {
      const throttle = $('throttle').value;
      // Offline makes the initial Page.navigate fail BY DESIGN — the failed load is the data —
      // so tell the core that a navigate error is not a fatal start error.
      return { throttle, ...(THROTTLE_PRESETS[throttle]?.offline ? { tolerateNavError: true } : {}) };
    },
    // one inline renderer for both lines: "Capturing… · Fast 4G" while live, "Stopped · … · Fast 4G" after
    renderStatus: (st) => st.throttle ? ` · <b>${st.throttle}</b>` : '',
  };
}
