// test/viewer-lib.test.js — tests for viewer/lib.js, the viewer's pure helpers. lib.js is a
// CLASSIC browser script (no exports — the viewer loads it before viewer.js, and ES modules
// are blocked on file://), so the test evaluates the source and plucks the declarations out.
// Run: npm test (node --test, no dependencies).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../viewer/lib.js', import.meta.url), 'utf8');
const { fmtBytes, fmtMs, extOf, urlParts, prettyJson, decodeContent, toCsv } =
  new Function(`${src}; return { fmtBytes, fmtMs, extOf, urlParts, prettyJson, decodeContent, toCsv };`)();

const b64 = (s) => Buffer.from(s).toString('base64');

test('fmtBytes / fmtMs edges', () => {
  assert.equal(fmtBytes(null), '–');
  assert.equal(fmtBytes(-1), '–');
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(1000), '1000 B');
  assert.equal(fmtBytes(1001), '1.0 kB');
  assert.equal(fmtBytes(1500000), '1.5 MB');
  assert.equal(fmtMs(null), '–');
  assert.equal(fmtMs(-1), '–');
  assert.equal(fmtMs(5.25), '5.3 ms');
  assert.equal(fmtMs(123.4), '123 ms');
  assert.equal(fmtMs(1234), '1.23 s');
});

test('extOf: the URL extension is the type', () => {
  assert.equal(extOf('https://x/app.css?v=1'), 'css');       // query ignored
  assert.equal(extOf('https://x/logo.PNG'), 'png');          // case-folded
  assert.equal(extOf('https://x/f/roboto.woff2'), 'woff2');
  assert.equal(extOf('https://x/a.min.js'), 'js');           // last dot wins
  assert.equal(extOf('https://x/api/user'), '');             // no extension
  assert.equal(extOf('https://x/'), '');
  assert.equal(extOf('https://x/.hidden'), '');              // dotfile, not an extension
  assert.equal(extOf('not a url'), '');
});

test('urlParts: name/path/host across URL shapes', () => {
  assert.deepEqual(urlParts('https://ex.com/a/b.js?x=1'),
    { name: 'b.js?x=1', path: '/a/b.js?x=1', host: 'ex.com' });
  assert.equal(urlParts('https://ex.com/dir/').name, 'dir');            // trailing slash stripped
  assert.deepEqual(urlParts('https://ex.com/'), { name: 'ex.com', path: '/', host: 'ex.com' });
  assert.ok(urlParts('https://ex.com/f?a-very-long-query-string=1234567890').name.endsWith('?…'));
  assert.equal(urlParts('https://ex.com/%E4%B8%AD.js').name, '中.js');   // percent-decoded
  assert.deepEqual(urlParts('not a url'), { name: 'not a url', path: 'not a url', host: '' });
});

test('prettyJson: formats real JSON, rejects the rest', () => {
  assert.equal(prettyJson('{"a":1}', 'application/json'), '{\n  "a": 1\n}');
  assert.equal(prettyJson('[1,2]', ''), '[\n  1,\n  2\n]');              // leading [ sniffed
  assert.equal(prettyJson('not json', 'application/json'), null);
  assert.equal(prettyJson('hello', 'text/plain'), null);
  assert.equal(prettyJson('x'.repeat(2e6), 'application/json'), null);   // too big to pretty
});

test('decodeContent: classify none / text / image / media / binary / b64error', () => {
  assert.equal(decodeContent({ size: 5, mimeType: 'font/woff2' }).kind, 'none');
  assert.deepEqual(decodeContent({ text: 'plain', mimeType: 'text/html' }), { kind: 'text', text: 'plain' });
  const img = decodeContent({ text: 'AAAA', encoding: 'base64', mimeType: 'image/png' });
  assert.equal(img.kind, 'image');
  assert.equal(img.dataUrl, 'data:image/png;base64,AAAA');
  const audio = decodeContent({ text: b64('hello'), encoding: 'base64', mimeType: 'audio/wav' });
  assert.equal(audio.kind, 'media');
  assert.equal(audio.tag, 'audio');
  assert.deepEqual(Array.from(audio.bytes), [104, 101, 108, 108, 111]);
  assert.equal(decodeContent({ text: b64('x'), encoding: 'base64', mimeType: 'video/mp4' }).tag, 'video');
  const utf8 = decodeContent({ text: b64('{"k":"中"}'), encoding: 'base64', mimeType: 'application/json' });
  assert.equal(utf8.kind, 'text');
  assert.equal(utf8.text, '{"k":"中"}');                                 // multibyte survives decode
  const bin = decodeContent({ text: Buffer.from(Array.from({ length: 100 }, (_, i) => i % 32)).toString('base64'),
    encoding: 'base64', mimeType: 'application/octet-stream' });
  assert.equal(bin.kind, 'binary');
  assert.equal(bin.bytes.length, 100);
  assert.equal(decodeContent({ text: '!!!', encoding: 'base64', mimeType: 'text/plain' }).kind, 'b64error');
});

test('toCsv: BOM, CRLF, quoting of commas/quotes/newlines', () => {
  const csv = toCsv([['a', 'b'], ['1', 'x,y'], ['q"t', 'line\nbreak']]);
  assert.ok(csv.startsWith('\uFEFF'));
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[0], 'a,b');
  assert.equal(lines[1], '1,"x,y"');
  assert.equal(lines[2], '"q""t","line\nbreak"');
  assert.equal(toCsv([[null, undefined, 0]]).slice(1), ',,0');
  // formula-injection guard: leading = + - @ get a quote prefix
  assert.equal(toCsv([['=HYPERLINK("http://evil/")']]).slice(1), '"\'=HYPERLINK(""http://evil/"")"');
  assert.equal(toCsv([['+1', '-1', '@cmd', 'safe']]).slice(1), "'+1,'-1,'@cmd,safe");
});

test('sample.har fixture: extOf buckets every entry', () => {
  const har = JSON.parse(readFileSync(new URL('./fixtures/sample.har', import.meta.url), 'utf8'));
  const counts = {};
  for (const e of har.log.entries) {
    const t = extOf(e.request.url);
    counts[t] = (counts[t] || 0) + 1;
  }
  assert.deepEqual(counts, { '': 7, css: 1, js: 1, png: 1, woff2: 1, gif: 1, wav: 1 });
});
