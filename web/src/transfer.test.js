// The one check that matters: bytes in == bytes out, through the real protocol.
// Run with `npm test`. No framework.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sendFiles, createReceiver, describe, formatSize } from './transfer.js';

const sha = (buf) => createHash('sha256').update(Buffer.from(buf)).digest('hex');

/** A fake RTCDataChannel that just records what was sent. */
function fakeChannel() {
  const out = [];
  return {
    bufferedAmount: 0,
    addEventListener() {},
    removeEventListener() {},
    send: (d) => out.push(d),
    out,
  };
}

const fileFrom = (name, bytes) => new File([bytes], name, { type: 'application/octet-stream' });

async function roundTrip(files, chunkSize) {
  const ch = fakeChannel();
  ch.send(JSON.stringify({ t: 'offer', files: describe(files) }));
  await sendFiles(ch, files, { chunkSize });

  const saved = [];
  let doneCalled = false;
  const errors = [];
  const rx = createReceiver({
    openSink: async () => {
      const parts = [];
      return { write: (c) => parts.push(c), close: async () => Buffer.concat(parts) };
    },
    onFile: (meta, i, result) => saved.push([meta.name, result]),
    onDone: () => (doneCalled = true),
    onError: (e) => errors.push(e),
  });

  for (const msg of ch.out) await rx.handle(msg);
  return { saved, doneCalled, errors };
}

// 1. A single file survives the round trip byte for byte.
{
  const bytes = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 31) % 256));
  const { saved, doneCalled, errors } = await roundTrip([fileFrom('big.bin', bytes)], 64 * 1024);
  assert.equal(errors.length, 0, 'no errors');
  assert.ok(doneCalled, 'done fired');
  assert.equal(saved.length, 1);
  assert.equal(sha(saved[0][1]), sha(bytes), 'sha256 matches');
}

// 2. A batch keeps files separate and in order, including an empty one.
{
  const a = Buffer.from('hello world');
  const b = Buffer.alloc(0);
  const c = Buffer.from(Array.from({ length: 70_000 }, (_, i) => i % 7));
  const { saved, errors } = await roundTrip(
    [fileFrom('a.txt', a), fileFrom('empty.bin', b), fileFrom('c.bin', c)],
    64 * 1024
  );
  assert.equal(errors.length, 0);
  assert.deepEqual(saved.map((s) => s[0]), ['a.txt', 'empty.bin', 'c.bin']);
  assert.equal(sha(saved[0][1]), sha(a));
  assert.equal(saved[1][1].length, 0);
  assert.equal(sha(saved[2][1]), sha(c));
}

// 3. A chunk size that doesn't divide the file evenly still lands exactly.
{
  const bytes = Buffer.from(Array.from({ length: 10_001 }, (_, i) => i % 256));
  const { saved, errors } = await roundTrip([fileFrom('odd.bin', bytes)], 1000);
  assert.equal(errors.length, 0);
  assert.equal(sha(saved[0][1]), sha(bytes));
}

// 4. A truncated transfer FAILS instead of silently saving a short file.
{
  const bytes = Buffer.alloc(5000, 9);
  const errors = [];
  const saved = [];
  const rx = createReceiver({
    openSink: async () => {
      const parts = [];
      return { write: (c) => parts.push(c), close: async () => Buffer.concat(parts) };
    },
    onFile: (m, i, r) => saved.push(r),
    onError: (e) => errors.push(e),
  });
  await rx.handle(JSON.stringify({ t: 'offer', files: [{ name: 'x', size: 5000 }] }));
  await rx.handle(JSON.stringify({ t: 'start', i: 0 }));
  await rx.handle(new Uint8Array(bytes.subarray(0, 3000)).buffer);
  await rx.handle(JSON.stringify({ t: 'end', i: 0 }));
  assert.equal(saved.length, 0, 'incomplete file must not be handed over');
  assert.match(errors[0].message, /incomplete/);
}

// 5. A sender that overruns the declared size is rejected, not trusted.
{
  const errors = [];
  const rx = createReceiver({
    openSink: async () => ({ write() {}, close: async () => null }),
    onError: (e) => errors.push(e),
  });
  await rx.handle(JSON.stringify({ t: 'offer', files: [{ name: 'x', size: 10 }] }));
  await rx.handle(JSON.stringify({ t: 'start', i: 0 }));
  await rx.handle(new Uint8Array(50).buffer);
  assert.match(errors[0].message, /overran/);
}

// 6. Size formatting, since it's on screen during every transfer.
assert.equal(formatSize(500), '500 B');
assert.equal(formatSize(2048), '2 KB');
assert.equal(formatSize(1_500_000), '1.5 MB');
assert.equal(formatSize(1_240_000_000), '1.24 GB');

console.log('transfer: all checks passed');
