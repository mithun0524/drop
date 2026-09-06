// Chunks cross the native bridge as base64. A bug here corrupts every byte of
// every file, silently — the transfer would report success and the file would
// be garbage.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

const probe = new URL('./__nat.gen.js', import.meta.url);
const src = readFileSync(new URL('./native.js', import.meta.url), 'utf8');
writeFileSync(
  probe,
  'const btoa = (s) => Buffer.from(s, "binary").toString("base64");\n' +
    src.match(/export function toBase64[\s\S]*?\n}/)[0] +
    '\n' +
    src.match(/export const folderFor[\s\S]*?;\n/)[0]
);
const { toBase64, folderFor } = await import(probe.href);
unlinkSync(probe);

const roundTrip = (bytes) => Buffer.from(toBase64(Uint8Array.from(bytes)), 'base64');

// Every byte value must survive, including the high half that naive
// string handling mangles.
{
  const all = Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual([...roundTrip(all)], all, 'all 256 byte values survive');
}

// Padding cases: lengths either side of a multiple of three.
for (const n of [0, 1, 2, 3, 4, 5, 6, 7]) {
  const bytes = Array.from({ length: n }, (_, i) => (i * 91) % 256);
  assert.deepEqual([...roundTrip(bytes)], bytes, `length ${n} survives`);
}

// Larger than the 8192-byte slice the encoder feeds fromCharCode in, so a
// boundary bug shows up rather than hiding in a small input.
{
  const big = Array.from({ length: 8192 * 3 + 137 }, (_, i) => (i * 31) % 256);
  const out = roundTrip(big);
  assert.equal(out.length, big.length, 'length preserved across slices');
  assert.deepEqual([...out], big, 'content preserved across slice boundaries');
}

// Exactly on the slice boundary, where an off-by-one would land.
for (const n of [8191, 8192, 8193, 16384]) {
  const bytes = Array.from({ length: n }, (_, i) => i % 256);
  assert.deepEqual([...roundTrip(bytes)], bytes, `length ${n} survives the boundary`);
}

// Files are grouped by day so a session's transfers stay together.
assert.equal(folderFor(new Date('2026-09-06T10:00:00Z')), 'Drop/2026-09-06');
assert.match(folderFor(), /^Drop\/\d{4}-\d{2}-\d{2}$/);

console.log('native: base64 bridge is byte-exact');
