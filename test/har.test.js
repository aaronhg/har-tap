// test/har.test.js — unit tests for har.js, the pure HAR-entry builder: feed it the same CDP
// event shapes chrome.debugger emits (Network domain) and assert on the HAR 1.2 output.
// Run: npm test (node --test, no dependencies).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HarTap, byteLen, b64Size } from '../core/har.js';

const approx = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? 'approx'}: ${a} != ${b}`);

const T0 = 1751800000;   // wall clock, seconds (CDP wallTime)
const M0 = 5000;         // monotonic clock, seconds (CDP timestamp/requestTime)

// CDP timing: requestTime in seconds, phase offsets in ms relative to it
const fullTiming = () => ({ requestTime: M0 + 0.1, dnsStart: 5, dnsEnd: 15, connectStart: 15,
  connectEnd: 80, sslStart: 50, sslEnd: 80, sendStart: 80, sendEnd: 81, receiveHeadersEnd: 200 });

// drive one request through requestWillBeSent → responseReceived → loadingFinished
function run(tap, o = {}) {
  const { id = '1', sid = '', url = 'https://example.com/', method = 'GET', reqHeaders = {},
    respHeaders = {}, status = 200, mime = 'text/html', timing = fullTiming(),
    wallTime = T0 + 0.1, ts = M0 + 0.1, finishTs = M0 + 0.35, encoded = 1234, type = 'Document', post,
    frameId } = o;
  tap.requestWillBeSent({ requestId: id, timestamp: ts, wallTime, documentURL: url, frameId,
    request: { url, method, headers: reqHeaders, initialPriority: 'High', ...(post ? { postData: post } : {}) },
    type, initiator: { type: 'other' } }, sid);
  tap.responseReceived({ requestId: id, response: { status, statusText: 'OK', headers: respHeaders,
    mimeType: mime, protocol: 'h2', timing, encodedDataLength: 100, remoteIPAddress: '1.2.3.4',
    connectionId: 7 } }, sid);
  return tap.loadingFinished({ requestId: id, timestamp: finishTs, encodedDataLength: encoded }, sid);
}

test('timings: phase spans, blocked from first offset, receive from finish timestamp', () => {
  const e = run(new HarTap());
  assert.equal(e.timings.blocked, 5);        // min(dnsStart, connectStart, sendStart)
  assert.equal(e.timings.dns, 10);
  assert.equal(e.timings.connect, 65);       // HAR: ssl is contained IN connect
  assert.equal(e.timings.ssl, 30);
  approx(e.timings.send, 1);
  approx(e.timings.wait, 119);               // receiveHeadersEnd - sendEnd
  approx(e.time, 250);                       // (loadingFinished.timestamp - requestTime) * 1000
  approx(e.timings.receive, 50);             // time - receiveHeadersEnd
});

test('keep-alive: reused connection reports -1 for dns/connect/ssl', () => {
  const e = run(new HarTap(), { timing: { requestTime: M0 + 0.1, dnsStart: -1, dnsEnd: -1,
    connectStart: -1, connectEnd: -1, sslStart: -1, sslEnd: -1, sendStart: 0.5, sendEnd: 1, receiveHeadersEnd: 100 } });
  assert.equal(e.timings.dns, -1);
  assert.equal(e.timings.connect, -1);
  assert.equal(e.timings.ssl, -1);
  approx(e.timings.blocked, 0.5);
});

test('sizes: wire bytes come from loadingFinished, not the partial at responseReceived', () => {
  const tap = new HarTap();
  const e = run(tap, { encoded: 4321 });     // responseReceived carried encodedDataLength: 100
  assert.equal(e.response._transferSize, 4321);
  assert.equal(e.response.content.size, 4321);
  assert.equal(e.response.bodySize, 4321);
  assert.equal(tap.wireBytes, 4321);
});

test('request side: startedDateTime, query string, cookies, post data, extras', () => {
  const e = run(new HarTap(), { url: 'https://example.com/api?x=1&y=two', method: 'POST',
    reqHeaders: { Cookie: 'a=1; b=2', 'Content-Type': 'application/x-www-form-urlencoded' },
    post: 'k=v&k2=v2' });
  assert.equal(e.startedDateTime, new Date((T0 + 0.1) * 1000).toISOString());
  assert.deepEqual(e.request.queryString, [{ name: 'x', value: '1' }, { name: 'y', value: 'two' }]);
  assert.deepEqual(e.request.cookies, [{ name: 'a', value: '1' }, { name: 'b', value: '2' }]);
  assert.equal(e.request.postData.mimeType, 'application/x-www-form-urlencoded');
  assert.equal(e.request.postData.text, 'k=v&k2=v2');
  assert.equal(e.request.bodySize, 9);
  assert.equal(e.serverIPAddress, '1.2.3.4');
  assert.equal(e.connection, '7');
  assert.equal(e._priority, 'High');
  assert.equal(e._resourceType, 'document');
});

test('response cookies: multi-line set-cookie with attributes', () => {
  const e = run(new HarTap(), { respHeaders: {
    'set-cookie': 'sid=x; Path=/; HttpOnly; Secure; SameSite=Lax\nother=y; Domain=.example.com; Expires=Wed, 01 Jan 2031 00:00:00 GMT' } });
  const [c1, c2] = e.response.cookies;
  assert.equal(c1.name, 'sid');
  assert.equal(c1.value, 'x');
  assert.equal(c1.path, '/');
  assert.equal(c1.httpOnly, true);
  assert.equal(c1.secure, true);
  assert.equal(c1.sameSite, 'Lax');
  assert.equal(c2.name, 'other');
  assert.equal(c2.domain, '.example.com');
  assert.equal(c2.expires, '2031-01-01T00:00:00.000Z');   // spec-style ISO, not the raw RFC string
});

test('ExtraInfo: wire headers win — Cookie/UA on the request, every Set-Cookie on the response', () => {
  const tap = new HarTap();
  // request ExtraInfo arrives BEFORE requestWillBeSent (CDP order is not guaranteed) → stashed
  tap.requestWillBeSentExtraInfo({ requestId: '1', headers: { cookie: 'sid=abc', 'user-agent': 'UA/1' } });
  tap.requestWillBeSent({ requestId: '1', timestamp: M0 + 0.1, wallTime: T0 + 0.1,
    documentURL: 'https://example.com/',
    request: { url: 'https://example.com/', method: 'GET', headers: { Accept: 'text/html' } }, type: 'Document' });
  tap.responseReceived({ requestId: '1', response: { status: 200, statusText: 'OK',
    headers: { 'content-type': 'text/html', 'set-cookie': 'a=1; Path=/' },   // CDP-merged view: one cookie lost
    mimeType: 'text/html', protocol: 'h2', timing: fullTiming() } });
  tap.responseReceivedExtraInfo({ requestId: '1',
    headers: { 'content-type': 'text/html', 'set-cookie': 'a=1; Path=/\nb=2; Secure' } });
  const e = tap.loadingFinished({ requestId: '1', timestamp: M0 + 0.3, encodedDataLength: 1000 });
  assert.deepEqual(e.request.cookies, [{ name: 'sid', value: 'abc' }]);
  assert.ok(e.request.headers.some((h) => h.name === 'user-agent' && h.value === 'UA/1'));
  const setCookies = e.response.headers.filter((h) => h.name === 'set-cookie');
  assert.equal(setCookies.length, 2);                     // split back into one header entry per cookie
  assert.equal(e.response.cookies.length, 2);
  assert.equal(e.response.cookies[1].secure, true);
});

test('dataReceived splits wire bytes: bodySize is body-only, headersSize the rest, compression recorded', () => {
  const tap = new HarTap();
  tap.requestWillBeSent({ requestId: '1', timestamp: M0 + 0.1, wallTime: T0 + 0.1,
    documentURL: 'https://example.com/a.js',
    request: { url: 'https://example.com/a.js', method: 'GET', headers: {} }, type: 'Script' });
  tap.responseReceived({ requestId: '1', response: { status: 200, statusText: 'OK', headers: {},
    mimeType: 'application/javascript', protocol: 'h2', timing: fullTiming() } });
  tap.dataReceived({ requestId: '1', encodedDataLength: 400 });
  tap.dataReceived({ requestId: '1', encodedDataLength: 434 });
  const e = tap.loadingFinished({ requestId: '1', timestamp: M0 + 0.3, encodedDataLength: 1234 });
  assert.equal(e.response.bodySize, 834);                 // Σ dataReceived
  assert.equal(e.response.headersSize, 400);              // total − body
  assert.equal(e.response._transferSize, 1234);
  tap.setDecodedSize(e, 2000);                            // gzip: decoded > wire body
  assert.equal(e.response.content.compression, 1166);     // 2000 − 834
});

test('headersSize falls back to raw header text; no compression without the exact body split', () => {
  const tap = new HarTap();
  const headersText = 'HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\n';
  tap.requestWillBeSent({ requestId: '1', timestamp: M0 + 0.1, wallTime: T0 + 0.1,
    documentURL: 'https://example.com/x',
    request: { url: 'https://example.com/x', method: 'GET', headers: {} }, type: 'XHR' });
  tap.responseReceived({ requestId: '1', response: { status: 200, statusText: 'OK', headers: {},
    mimeType: 'text/plain', protocol: 'http/1.1', timing: fullTiming(),
    headersText, requestHeadersText: 'GET /x HTTP/1.1\r\nHost: example.com\r\n\r\n' } });
  const e = tap.loadingFinished({ requestId: '1', timestamp: M0 + 0.3, encodedDataLength: 500 });
  assert.equal(e.response.headersSize, headersText.length);
  assert.equal(e.request.headersSize, 38);
  assert.equal(e.response.bodySize, 500);                 // no dataReceived → old whole-message fallback
  tap.setDecodedSize(e, 600);
  assert.equal(e.response.content.compression, undefined); // fallback bodySize would fake the number
});

test('postData.params: urlencoded bodies are parsed alongside text; log.browser is emitted', () => {
  const tap = new HarTap();
  tap.browser = { name: 'Chrome', version: '138.0.7204.49' };
  const e = run(tap, { url: 'https://example.com/api', method: 'POST',
    reqHeaders: { 'Content-Type': 'application/x-www-form-urlencoded' }, post: 'k=v&k2=v%202' });
  assert.equal(e.request.postData.text, 'k=v&k2=v%202');
  assert.deepEqual(e.request.postData.params, [{ name: 'k', value: 'v' }, { name: 'k2', value: 'v 2' }]);
  assert.deepEqual(tap.build().log.browser, { name: 'Chrome', version: '138.0.7204.49' });
});

test('redirect: redirectResponse emits the hop as its own entry', () => {
  const tap = new HarTap();
  tap.requestWillBeSent({ requestId: '1', timestamp: M0 + 0.1, wallTime: T0 + 0.1,
    documentURL: 'https://example.com/old',
    request: { url: 'https://example.com/old', method: 'GET', headers: {}, initialPriority: 'VeryHigh' },
    type: 'Document', initiator: { type: 'other' } });
  tap.requestWillBeSent({ requestId: '1', timestamp: M0 + 0.2, wallTime: T0 + 0.2,
    documentURL: 'https://example.com/new',
    request: { url: 'https://example.com/new', method: 'GET', headers: {}, initialPriority: 'VeryHigh' },
    type: 'Document', initiator: { type: 'other' },
    redirectResponse: { status: 302, statusText: 'Found', headers: { location: '/new' }, mimeType: '',
      protocol: 'h2', timing: fullTiming() } });
  tap.responseReceived({ requestId: '1', response: { status: 200, statusText: 'OK', headers: {},
    mimeType: 'text/html', protocol: 'h2', timing: { ...fullTiming(), requestTime: M0 + 0.2 } } });
  tap.loadingFinished({ requestId: '1', timestamp: M0 + 0.5, encodedDataLength: 900 });
  assert.equal(tap.entries.length, 2);
  const [hop, fin] = tap.entries;
  assert.equal(hop.response.status, 302);
  assert.equal(hop.response.redirectURL, '/new');
  assert.equal(hop.request.url, 'https://example.com/old');
  assert.equal(fin.request.url, 'https://example.com/new');
  assert.equal(fin.response.status, 200);
});

test('loadingFailed: entry carries _error; without a response nothing is emitted', () => {
  const tap = new HarTap();
  tap.requestWillBeSent({ requestId: '1', timestamp: M0 + 0.1, wallTime: T0 + 0.1,
    documentURL: 'https://example.com/a',
    request: { url: 'https://example.com/a', method: 'GET', headers: {} }, type: 'Image' });
  tap.responseReceived({ requestId: '1', response: { status: 200, statusText: 'OK', headers: {},
    mimeType: 'image/png', protocol: 'h2', timing: fullTiming() } });
  tap.loadingFailed({ requestId: '1', timestamp: M0 + 0.3, errorText: 'net::ERR_ABORTED' });
  tap.requestWillBeSent({ requestId: '2', timestamp: M0 + 0.2, wallTime: T0 + 0.2,
    documentURL: 'https://example.com/b',
    request: { url: 'https://example.com/b', method: 'GET', headers: {} }, type: 'Image' });
  tap.loadingFailed({ requestId: '2', timestamp: M0 + 0.4, errorText: 'net::ERR_BLOCKED_BY_CLIENT' });
  assert.equal(tap.entries.length, 1);       // no headers ever arrived for '2' — nothing to log
  assert.equal(tap.entries[0]._error, 'net::ERR_ABORTED');
  assert.equal(tap.entries[0].response._error, 'net::ERR_ABORTED');
});

test('OOPIF: the same requestId in two sessions does not collide', () => {
  const tap = new HarTap();
  const rootUrl = 'https://root.example/', childUrl = 'https://child.example/';
  const resp = () => ({ status: 200, statusText: 'OK', headers: {}, mimeType: 'text/html',
    protocol: 'h2', timing: fullTiming() });
  tap.requestWillBeSent({ requestId: '1', timestamp: M0 + 0.1, wallTime: T0 + 0.1, documentURL: rootUrl,
    request: { url: rootUrl, method: 'GET', headers: {} }, type: 'Document' }, '');
  tap.requestWillBeSent({ requestId: '1', timestamp: M0 + 0.11, wallTime: T0 + 0.11, documentURL: childUrl,
    request: { url: childUrl, method: 'GET', headers: {} }, type: 'Document' }, 'sess-child');
  tap.responseReceived({ requestId: '1', response: resp() }, '');
  tap.responseReceived({ requestId: '1', response: resp() }, 'sess-child');
  tap.loadingFinished({ requestId: '1', timestamp: M0 + 0.3, encodedDataLength: 10 }, '');
  tap.loadingFinished({ requestId: '1', timestamp: M0 + 0.3, encodedDataLength: 20 }, 'sess-child');
  assert.deepEqual(tap.entries.map((e) => e.request.url).sort(), [childUrl, rootUrl].sort());
});

test('attachBody: HAR-standard content.text, size refined to the DECODED length', () => {
  const tap = new HarTap();
  const e = run(tap, { encoded: 50 });
  const size = tap.attachBody(e, Buffer.from('hello').toString('base64'), true);
  assert.equal(size, 5);
  assert.equal(e.response.content.size, 5);  // was 50 (wire) before the body arrived
  assert.equal(e.response.content.encoding, 'base64');
  assert.equal(e.response.content.text, 'aGVsbG8=');
  const e2 = run(tap, { id: '2', url: 'https://example.com/2' });
  tap.attachBody(e2, '中文', false);
  assert.equal(e2.response.content.size, 6); // UTF-8 bytes, not string length
  assert.equal(e2.response.content.encoding, undefined);
});

test('build: entries sorted by start time, pageTimings relative to nav start', () => {
  const tap = new HarTap();
  run(tap, { id: '1', url: 'https://example.com/', wallTime: T0 + 0.1, ts: M0 + 0.1 });
  run(tap, { id: '2', url: 'https://example.com/late', wallTime: T0 + 2, ts: M0 + 2,
    timing: { ...fullTiming(), requestTime: M0 + 2 }, finishTs: M0 + 2.2 });
  run(tap, { id: '3', url: 'https://example.com/early', wallTime: T0 + 0.5, ts: M0 + 0.5,
    timing: { ...fullTiming(), requestTime: M0 + 0.5 }, finishTs: M0 + 0.7 });
  tap.domContentEventFired({ timestamp: M0 + 0.5 });
  tap.loadEventFired({ timestamp: M0 + 0.8 });
  const har = tap.build();
  assert.deepEqual(har.log.entries.map((e) => e.request.url),
    ['https://example.com/', 'https://example.com/early', 'https://example.com/late']);
  const page = har.log.pages[0];
  assert.equal(page.id, 'page_1');
  assert.equal(page.title, 'https://example.com/');
  approx(page.pageTimings.onContentLoad, 400);
  approx(page.pageTimings.onLoad, 700);
  assert.equal(har.log.version, '1.2');
  assert.equal(har.log.creator.name, 'har-tap');
});

test('multi-page: each top-frame navigation opens a page with its own timings', () => {
  const tap = new HarTap();
  tap.mainFrameId = 'F0';
  run(tap, { id: '1', url: 'https://example.com/', frameId: 'F0' });
  run(tap, { id: '2', url: 'https://example.com/app.js', type: 'Script', frameId: 'F0',
    wallTime: T0 + 0.3, ts: M0 + 0.3, timing: { ...fullTiming(), requestTime: M0 + 0.3 }, finishTs: M0 + 0.4 });
  tap.domContentEventFired({ timestamp: M0 + 0.5 });
  tap.loadEventFired({ timestamp: M0 + 0.8 });
  run(tap, { id: '3', url: 'https://example.com/checkout', frameId: 'F0',
    wallTime: T0 + 5, ts: M0 + 5, timing: { ...fullTiming(), requestTime: M0 + 5 }, finishTs: M0 + 5.2 });
  tap.domContentEventFired({ timestamp: M0 + 5.4 });
  tap.loadEventFired({ timestamp: M0 + 5.9 });
  const har = tap.build();
  assert.equal(har.log.pages.length, 2);
  const [p1, p2] = har.log.pages;
  assert.equal(p1.id, 'page_1');
  assert.equal(p2.id, 'page_2');
  assert.equal(p2.title, 'https://example.com/checkout');
  approx(p1.pageTimings.onContentLoad, 400);
  approx(p1.pageTimings.onLoad, 700);        // page_1 keeps ITS events — nav 2's must not clobber them
  approx(p2.pageTimings.onContentLoad, 400); // …and page_2 is timed against its OWN nav start
  approx(p2.pageTimings.onLoad, 900);
  assert.deepEqual(har.log.entries.map((e) => e.pageref), ['page_1', 'page_1', 'page_2']);
});

test('same-origin iframe docs and navigation redirects do not open pages', () => {
  const tap = new HarTap();
  tap.mainFrameId = 'F0';
  run(tap, { id: '1', url: 'https://example.com/', frameId: 'F0' });
  run(tap, { id: '2', url: 'https://example.com/embed', frameId: 'IF1',   // iframe doc on the root session
    wallTime: T0 + 0.2, ts: M0 + 0.2, timing: { ...fullTiming(), requestTime: M0 + 0.2 }, finishTs: M0 + 0.3 });
  assert.equal(tap.pages.length, 1);
  tap.requestWillBeSent({ requestId: '3', timestamp: M0 + 2, wallTime: T0 + 2, frameId: 'F0',
    documentURL: 'https://example.com/old',
    request: { url: 'https://example.com/old', method: 'GET', headers: {} }, type: 'Document' });
  tap.requestWillBeSent({ requestId: '3', timestamp: M0 + 2.1, wallTime: T0 + 2.1, frameId: 'F0',
    documentURL: 'https://example.com/new',
    request: { url: 'https://example.com/new', method: 'GET', headers: {} }, type: 'Document',
    redirectResponse: { status: 302, statusText: 'Found', headers: { location: '/new' }, protocol: 'h2',
      timing: { ...fullTiming(), requestTime: M0 + 2 } } });
  assert.equal(tap.pages.length, 2);         // the redirect continuation must not open page_3
  tap.responseReceived({ requestId: '3', response: { status: 200, statusText: 'OK', headers: {},
    mimeType: 'text/html', protocol: 'h2', timing: { ...fullTiming(), requestTime: M0 + 2.1 } } });
  tap.loadingFinished({ requestId: '3', timestamp: M0 + 2.4, encodedDataLength: 500 });
  const refOf = (part) => tap.entries.find((e) => e.request.url.includes(part)).pageref;
  assert.equal(refOf('/embed'), 'page_1');
  assert.equal(refOf('/old'), 'page_2');
  assert.equal(refOf('/new'), 'page_2');
});

test('a request started before a navigation keeps its original pageref', () => {
  const tap = new HarTap();
  tap.mainFrameId = 'F0';
  run(tap, { id: '1', url: 'https://example.com/', frameId: 'F0' });
  tap.requestWillBeSent({ requestId: '9', timestamp: M0 + 0.5, wallTime: T0 + 0.5, frameId: 'F0',
    documentURL: 'https://example.com/',
    request: { url: 'https://example.com/api/slow', method: 'GET', headers: {} }, type: 'XHR' });
  run(tap, { id: '2', url: 'https://example.com/next', frameId: 'F0',
    wallTime: T0 + 1, ts: M0 + 1, timing: { ...fullTiming(), requestTime: M0 + 1 }, finishTs: M0 + 1.2 });
  tap.responseReceived({ requestId: '9', response: { status: 200, statusText: 'OK', headers: {},
    mimeType: 'application/json', protocol: 'h2', timing: { ...fullTiming(), requestTime: M0 + 0.5 } } });
  const e = tap.loadingFinished({ requestId: '9', timestamp: M0 + 1.5, encodedDataLength: 10 });
  assert.equal(e.pageref, 'page_1');         // attribution is by request START, not finish
});

test('byteLen / b64Size', () => {
  assert.equal(byteLen('abc'), 3);
  assert.equal(byteLen('中'), 3);
  assert.equal(byteLen(''), 0);
  assert.equal(b64Size('aGVsbG8='), 5);      // 'hello'
  assert.equal(b64Size('YWJj'), 3);          // 'abc', no padding
  assert.equal(b64Size('YQ=='), 1);          // 'a', double padding
  assert.equal(b64Size(''), 0);
});
