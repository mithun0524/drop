// The one check that matters: bytes in == bytes out, through the real protocol.
// Run with `npm test`. No framework.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sendFiles, createReceiver, createSession, describe, formatSize } from './transfer.js';

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

// 7. One unreadable file is skipped; the rest of the batch still arrives.
{
  const good1 = Buffer.from('first file');
  const good2 = Buffer.from(Array.from({ length: 20_000 }, (_, i) => i % 251));
  const broken = new File([Buffer.alloc(4000, 1)], 'broken.bin');
  // Simulate a file that vanishes mid-read.
  broken.slice = () => ({ arrayBuffer: async () => { throw new Error('NotReadableError'); } });

  const ch = fakeChannel();
  const files = [fileFrom('a.txt', good1), broken, fileFrom('c.bin', good2)];
  ch.send(JSON.stringify({ t: 'offer', files: describe(files) }));
  const failed = await sendFiles(ch, files, { chunkSize: 8192 });
  assert.deepEqual(failed, [1], 'exactly the broken file failed');

  const saved = [];
  const skipped = [];
  let doneFailed = null;
  const errors = [];
  const rx = createReceiver({
    openSink: async () => {
      const parts = [];
      return { write: (c) => parts.push(c), close: async () => Buffer.concat(parts) };
    },
    onFile: (m, i, r) => saved.push([m.name, r]),
    onFailed: (m, i) => skipped.push(m.name),
    onDone: (m, t, f) => (doneFailed = f),
    onError: (e) => errors.push(e),
  });
  for (const msg of ch.out) await rx.handle(msg);

  assert.equal(errors.length, 0, 'a skipped file is not a transfer error');
  assert.deepEqual(skipped, ['broken.bin']);
  assert.deepEqual(saved.map((s) => s[0]), ['a.txt', 'c.bin'], 'the other two survived');
  assert.equal(sha(saved[1][1]), sha(good2), 'the file after the failure is intact');
  assert.deepEqual(doneFailed, [1]);
}

// 8. Cancelling still stops everything — it is not a per-file failure.
{
  const ctl = new AbortController();
  const ch = fakeChannel();
  const big = fileFrom('big.bin', Buffer.alloc(100_000, 3));
  ctl.abort();
  await assert.rejects(() => sendFiles(ch, [big], { signal: ctl.signal }), /cancelled/);
}

console.log('transfer: failure-tolerance checks passed');

// 9. A disk sink hands bytes straight to the file and keeps nothing.
{
  const written = [];
  let closed = false;
  const { diskSink } = await import('./transfer.js');
  const sink = diskSink({
    write: (c) => written.push(c),
    close: async () => (closed = true),
  });
  sink.write(new Uint8Array([1, 2, 3]));
  sink.write(new Uint8Array([4, 5]));
  const out = await sink.close();
  assert.equal(out, null, 'nothing is handed back — it is already on disk');
  assert.ok(closed, 'the file is closed');
  assert.equal(Buffer.concat(written.map(Buffer.from)).toString('hex'), '0102030405');
}

// 10. The memory ceiling is per-platform and conservative.
{
  const { memoryCeiling } = await import('./transfer.js');
  const ios = memoryCeiling('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)');
  const android = memoryCeiling('Mozilla/5.0 (Linux; Android 14)');
  const desktop = memoryCeiling('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
  assert.ok(ios < android && android < desktop, 'phones hold less than laptops');
  assert.ok(ios > 0 && desktop < 4e9, 'ceilings stay in a believable range');
}

console.log('transfer: disk sink and ceiling checks passed');

// 11. A transfer cut off partway resumes byte-exact instead of starting over.
{
  const bytes = Buffer.from(Array.from({ length: 250_000 }, (_, i) => (i * 37) % 256));
  const file = fileFrom('big.bin', bytes);
  const tid = 'abc123';

  // A sink that survives the drop, the way an open file or a partial buffer does.
  const parts = [];
  const session = createSession();
  const mkReceiver = () =>
    createReceiver({
      session,
      openSink: async () => ({ write: (c) => parts.push(c), close: async () => Buffer.concat(parts) }),
      onError: (e) => { throw e; },
    });

  // First attempt: the wire dies after 100KB.
  const ch1 = fakeChannel();
  ch1.send(JSON.stringify({ t: 'offer', tid, files: describe([file]) }));
  const ctl = new AbortController();
  let moved = 0;
  await assert.rejects(
    () =>
      sendFiles(ch1, [file], {
        chunkSize: 10_000,
        signal: ctl.signal,
        onProgress: ({ sent }) => {
          moved = sent;
          if (sent >= 100_000) ctl.abort();
        },
      }),
    /cancelled/
  );

  const rx1 = mkReceiver();
  for (const msg of ch1.out) await rx1.handle(msg);
  const kept = rx1.have()[0];
  assert.ok(kept > 0 && kept < bytes.length, `partial progress kept, got ${kept}`);
  assert.ok(rx1.resumable(), 'a partial transfer is resumable');
  await rx1.abort({ keep: true }); // the connection dropped; the bytes stay

  // Second attempt: the same transfer id comes back.
  const ch2 = fakeChannel();
  ch2.send(JSON.stringify({ t: 'offer', tid, files: describe([file]) }));
  const rx2 = mkReceiver();
  let resumedFrom = null;
  const saved = [];
  const rx = createReceiver({
    session,
    openSink: async () => ({ write: (c) => parts.push(c), close: async () => Buffer.concat(parts) }),
    onOffer: (m, t, have) => (resumedFrom = have),
    onFile: (m, i, r) => saved.push(r),
    onError: (e) => { throw e; },
  });
  await rx.handle(ch2.out[0]);
  assert.deepEqual(resumedFrom, [kept], 'the receiver answers with what it kept');

  await sendFiles(ch2, [file], { chunkSize: 10_000, offsets: resumedFrom });
  for (const msg of ch2.out.slice(1)) await rx.handle(msg);

  assert.equal(saved.length, 1, 'the file completed on the second attempt');
  assert.equal(sha(saved[0]), sha(bytes), 'resumed file is byte-identical');

  // The resume must not re-send what was already there.
  const resent = ch2.out.filter((m) => m instanceof ArrayBuffer).reduce((a, b) => a + b.byteLength, 0);
  assert.ok(resent < bytes.length - kept + 20_000, `only the remainder was re-sent (${resent})`);
}

// 12. A resume whose offset disagrees with what was kept is refused, not
//     silently written at the wrong place.
{
  const session = createSession();
  const errors = [];
  const rx = createReceiver({
    session,
    openSink: async () => ({ write() {}, close: async () => null }),
    onError: (e) => errors.push(e),
  });
  await rx.handle(JSON.stringify({ t: 'offer', tid: 'x', files: [{ name: 'a', size: 100 }] }));
  await rx.handle(JSON.stringify({ t: 'start', i: 0, from: 40 })); // we kept 0
  assert.match(errors[0].message, /resumed at 40 but 0 bytes were kept/);
}

// 13. A different transfer id is a new transfer, not a resume.
{
  const session = createSession();
  let sawHave = 'unset';
  const rx = createReceiver({
    session,
    openSink: async () => ({ write() {}, close: async () => null }),
    onOffer: (m, t, have) => (sawHave = have),
  });
  await rx.handle(JSON.stringify({ t: 'offer', tid: 'one', files: [{ name: 'a', size: 10 }] }));
  assert.equal(sawHave, null, 'a first offer is not a resume');
  await rx.handle(JSON.stringify({ t: 'offer', tid: 'two', files: [{ name: 'b', size: 10 }] }));
  assert.equal(sawHave, null, 'an unrelated id starts fresh');
}

console.log('transfer: resume checks passed');

// 14. Speed has to read as a speed. Sub-megabyte transfers rounded to
//     "0 MB/s", which looks like a stalled connection rather than a slow one.
{
  const { formatSpeed } = await import('./transfer.js');
  assert.equal(formatSpeed(0), '—');
  assert.equal(formatSpeed(0.35), '350 KB/s');
  assert.equal(formatSpeed(0.001), '1 KB/s');
  assert.equal(formatSpeed(1.5), '1.5 MB/s');
  assert.equal(formatSpeed(84), '84 MB/s');
  assert.equal(formatSpeed(9.4), '9.4 MB/s');
  assert.ok(!/^0 MB\/s$/.test(formatSpeed(0.4)), 'a slow transfer is never "0 MB/s"');
}

// 15. The declared type travels with the file, or a saved video becomes a .txt.
{
  const bytes = Buffer.from('video-ish');
  const ch = fakeChannel();
  const files = [Object.assign(new File([bytes], 'clip.mp4', { type: 'video/mp4' }), {})];
  ch.send(JSON.stringify({ t: 'offer', files: describe(files) }));
  await sendFiles(ch, files);

  const results = [];
  const rx = createReceiver({
    session: createSession(),
    openSink: async () => {
      const parts = [];
      return { write: (c) => parts.push(c), close: async () => Buffer.concat(parts) };
    },
    onDone: (m, t, f, r) => results.push(...r),
  });
  for (const msg of ch.out) await rx.handle(msg);

  assert.equal(results.length, 1);
  const [name, , type] = results[0];
  assert.equal(name, 'clip.mp4', 'the declared name survives');
  assert.equal(type, 'video/mp4', 'the declared type survives');
}

console.log('transfer: speed and type checks passed');

// 16. A real channel does not wait for one message to finish before delivering
//     the next. With slow sinks (OPFS, native) a batch must still land intact.
{
  const a = Buffer.from(Array.from({ length: 150_000 }, (_, i) => i % 251));
  const b = Buffer.from(Array.from({ length: 90_000 }, (_, i) => i % 13));
  const files = [fileFrom('a.bin', a), fileFrom('b.bin', b)];
  const ch = fakeChannel();
  ch.send(JSON.stringify({ t: 'offer', files: describe(files) }));
  await sendFiles(ch, files, { chunkSize: 16 * 1024 });

  const tick = () => new Promise((r) => setTimeout(r, 5));
  const saved = [];
  const errors = [];
  let done = false;
  const rx = createReceiver({
    session: createSession(),
    openSink: async () => {
      await tick();
      const parts = [];
      return {
        write: (c) => parts.push(c),
        close: async () => (await tick(), Buffer.concat(parts)),
      };
    },
    onFile: (meta, i, r) => saved.push([meta.name, r]),
    onDone: () => (done = true),
    onError: (e) => errors.push(e),
  });
  // Fire-and-forget, the way an event listener does.
  await Promise.all(ch.out.map((msg) => rx.handle(msg)));

  assert.deepEqual(errors.map((e) => e.message), [], 'no errors under concurrent delivery');
  assert.ok(done, 'done fired');
  assert.equal(sha(saved[0][1]), sha(a));
  assert.equal(sha(saved[1][1]), sha(b));
}

console.log('transfer: concurrent delivery check passed');
