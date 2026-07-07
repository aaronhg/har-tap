// test/throttle.test.js — the throttling plugin: preset values must be byte-identical to what Chrome
// DevTools sends over CDP (front_end/core/sdk/NetworkManager.ts, incl. connectionType), the capture
// hooks must apply them to the root session and every OOPIF child, and a failed apply must not leave
// a lying _throttling stamp behind. Run: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THROTTLE_PRESETS, throttleParams, throttleCapture, throttlePopup } from '../plugins/throttle.js';

test('presets match Chrome DevTools NetworkManager values', () => {
  assert.deepEqual(throttleParams(THROTTLE_PRESETS.fast4g),
    { offline: false, latency: 165, downloadThroughput: 1012500, uploadThroughput: 168750, connectionType: 'cellular4g' });
  assert.deepEqual(throttleParams(THROTTLE_PRESETS.slow4g),
    { offline: false, latency: 562.5, downloadThroughput: 180000, uploadThroughput: 84375, connectionType: 'cellular4g' });
  assert.deepEqual(throttleParams(THROTTLE_PRESETS['3g']),
    { offline: false, latency: 2000, downloadThroughput: 50000, uploadThroughput: 50000, connectionType: 'cellular3g' });
  assert.deepEqual(throttleParams(THROTTLE_PRESETS.offline),
    { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0, connectionType: 'none' });
});

test('initSession: preset lookup, none, and the unknown-key rejection', () => {
  const plug = throttleCapture();
  const sess = {};
  assert.equal(plug.initSession(sess, { throttle: 'slow4g' }), undefined);
  assert.equal(sess.throttle.label, 'Slow 4G');
  const none = {};
  plug.initSession(none, {});                       // no option → no throttling
  assert.equal(none.throttle, null);
  assert.match(String(plug.initSession({}, { throttle: 'warp10' })), /unknown throttling preset/);
});

test('emulateNetworkConditions goes to the root AND each OOPIF child session', async () => {
  const plug = throttleCapture();
  const sess = {};
  plug.initSession(sess, { throttle: 'slow4g' });
  const calls = [];
  const send = async (target, method, params) => calls.push({ target, method, params });
  await plug.onRootAttach({ send, tabId: 7, sess });
  await plug.onChildAttach({ send, child: { tabId: 7, sessionId: 's1' }, sess });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'Network.emulateNetworkConditions');
  assert.deepEqual(calls[0].target, { tabId: 7 });
  assert.equal(calls[0].params.latency, 562.5);
  assert.deepEqual(calls[1].target, { tabId: 7, sessionId: 's1' });
  assert.deepEqual(calls[0].params, calls[1].params);
  const off = {};
  plug.initSession(off, { throttle: 'none' });      // unthrottled sessions must not send the command
  await plug.onRootAttach({ send, tabId: 7, sess: off });
  assert.equal(calls.length, 2);
});

test('a failed apply cannot leave a lying stamp: root failure clears, child failures are counted', async () => {
  const plug = throttleCapture();
  const failingSend = async () => { throw new Error('target closed'); };
  const rootFail = {};
  plug.initSession(rootFail, { throttle: '3g' });
  await plug.onRootAttach({ send: failingSend, tabId: 7, sess: rootFail });
  assert.equal(rootFail.throttle, null);            // honest: no throttle → no label, no stamp
  assert.equal(plug.status(rootFail), null);
  assert.equal(plug.finalize({ sess: rootFail, har: { log: {} } }), null);

  const childFail = {};
  plug.initSession(childFail, { throttle: '3g' });
  await plug.onChildAttach({ send: failingSend, child: { tabId: 7, sessionId: 's1' }, sess: childFail });
  assert.equal(childFail.throttleMisses, 1);
  const har = { log: {} };
  plug.finalize({ sess: childFail, har });
  assert.equal(har.log._throttling.unthrottledFrames, 1);
});

test('finalize stamps label + the applied values; status reports the label', () => {
  const plug = throttleCapture();
  const sess = {};
  plug.initSession(sess, { throttle: '3g' });
  assert.deepEqual(plug.status(sess), { throttle: '3G' });
  const har = { log: {} };
  assert.deepEqual(plug.finalize({ sess, har }), { throttle: '3G' });
  assert.deepEqual(har.log._throttling, {
    label: '3G', offline: false, latency: 2000,
    downloadThroughput: 50000, uploadThroughput: 50000, connectionType: 'cellular3g',
  });
  assert.equal(plug.finalize({ sess: { throttle: null }, har: { log: {} } }), null);
  assert.equal(plug.status({ throttle: null }), null);
});

test('popup side: options are generated from the presets; offline opts into tolerateNavError', () => {
  const plug = throttlePopup();
  for (const [key, p] of Object.entries(THROTTLE_PRESETS)) {   // menu can't drift from the capture side
    assert.ok(plug.optionsHtml.includes(`value="${key}"`), key);
    assert.ok(plug.optionsHtml.includes(`>${p.label}<`), p.label);
  }
  const $for = (value) => () => ({ value });
  assert.deepEqual(plug.startOpts($for('slow4g')), { throttle: 'slow4g' });
  assert.deepEqual(plug.startOpts($for('none')), { throttle: 'none' });
  assert.deepEqual(plug.startOpts($for('offline')), { throttle: 'offline', tolerateNavError: true });
});
