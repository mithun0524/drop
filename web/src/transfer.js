// File transfer protocol over an RTCDataChannel.
//
// Wire format, all on one ordered binary channel:
//   JSON string  {t:'offer',   files:[{name,size,type}]}
//   JSON string  {t:'accept'} | {t:'decline'}
//   JSON string  {t:'start',   i}
//   ArrayBuffer  ... raw chunks, in order, exactly file.size bytes total
//   JSON string  {t:'end',     i}   | {t:'skip', i, reason}
//   JSON string  {t:'done',    failed:[i]}
//
// 'skip' is how a single file fails without taking the batch with it: the
// receiver discards whatever arrived and the sender moves to the next file.
//
// Nothing here touches the DOM or WebRTC directly — the channel is passed in,
// so this file is testable with a fake channel. See transfer.test.js.

export const DEFAULT_CHUNK = 64 * 1024; // safe across Chrome/Firefox/Safari SCTP
const HIGH_WATER = 8 * 1024 * 1024;
const LOW_WATER = 1 * 1024 * 1024;

export const describe = (files) =>
  files.map((f) => ({ name: f.name, size: f.size, type: f.type || 'application/octet-stream' }));

export const totalBytes = (files) => files.reduce((a, f) => a + f.size, 0);

export function formatSize(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
  if (b >= 1e3) return Math.round(b / 1e3) + ' KB';
  return b + ' B';
}

/** Resolves once the channel has drained below LOW_WATER. This is what keeps
 *  a 4GB send from filling memory faster than the wire empties it. */
function drain(ch) {
  if (ch.bufferedAmount <= HIGH_WATER) return null;
  return new Promise((resolve) => {
    ch.bufferedAmountLowThreshold = LOW_WATER;
    const done = () => {
      ch.removeEventListener('bufferedamountlow', done);
      resolve();
    };
    ch.addEventListener('bufferedamountlow', done);
  });
}

/**
 * Streams files down the channel, one after another.
 * onProgress({ index, fileSent, sent, total }) fires per chunk.
 * onFailed(index, reason) fires when one file is skipped.
 *
 * A file that can't be read (moved, permissions revoked, disk error) is
 * skipped and the rest continue — cancelling is the only thing that stops
 * the batch. Returns the indices that failed.
 */
export async function sendFiles(
  ch,
  files,
  { chunkSize = DEFAULT_CHUNK, onProgress, onFailed, signal } = {}
) {
  let sent = 0;
  const total = totalBytes(files);
  const failed = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    ch.send(JSON.stringify({ t: 'start', i }));

    let off = 0;
    try {
      while (off < file.size) {
        if (signal?.aborted) throw new Error('cancelled');
        const end = Math.min(off + chunkSize, file.size);
        const buf = await file.slice(off, end).arrayBuffer();
        const wait = drain(ch);
        if (wait) await wait;
        ch.send(buf);
        off = end;
        sent += buf.byteLength;
        onProgress?.({ index: i, fileSent: off, sent, total });
      }
      ch.send(JSON.stringify({ t: 'end', i }));
    } catch (err) {
      if (err.message === 'cancelled') throw err; // the user stopping is not a file failure
      failed.push(i);
      // Keep the byte accounting honest: the rest of this file never ships.
      sent += file.size - off;
      ch.send(JSON.stringify({ t: 'skip', i, reason: String(err.message || err) }));
      onFailed?.(i, String(err.message || err));
      onProgress?.({ index: i, fileSent: file.size, sent, total });
    }
  }

  ch.send(JSON.stringify({ t: 'done', failed }));
  return failed;
}

/**
 * Reassembles an incoming transfer. Feed it every channel message via handle().
 *
 * Sinks: a sink is { write(chunk), close() -> Promise<result> }. The browser
 * passes a File System Access writable when available, otherwise an in-memory
 * one. Node tests pass their own. Keeping the sink injectable is what lets a
 * 20GB file stream to disk on desktop without a second code path.
 */
export function createReceiver({
  openSink,
  onOffer,
  onProgress,
  onFile,
  onFailed,
  onDone,
  onError,
}) {
  let manifest = null;
  let index = -1;
  let sink = null;
  let fileGot = 0;
  let got = 0;
  let total = 0;

  const fail = (msg) => {
    onError?.(new Error(msg));
  };

  async function handle(data) {
    if (typeof data === 'string') {
      const m = JSON.parse(data);

      if (m.t === 'offer') {
        manifest = m.files;
        total = totalBytes(manifest);
        onOffer?.(manifest, total);
        return;
      }

      if (m.t === 'start') {
        index = m.i;
        fileGot = 0;
        sink = await openSink(manifest[index], index);
        return;
      }

      if (m.t === 'end') {
        // Trust the declared size over the sender's framing: a short file is a
        // corrupt file, and silently saving it is worse than failing loudly.
        if (fileGot !== manifest[index].size) {
          await sink.close();
          return fail(
            `${manifest[index].name} arrived incomplete (${fileGot} of ${manifest[index].size} bytes)`
          );
        }
        const result = await sink.close();
        sink = null;
        onFile?.(manifest[index], index, result);
        return;
      }

      if (m.t === 'skip') {
        // The sender gave up on this one. Throw away the partial rather than
        // hand over a file that looks whole and isn't.
        if (sink) {
          await sink.close().catch(() => {});
          sink = null;
        }
        got += Math.max(0, manifest[m.i].size - fileGot);
        fileGot = 0;
        onFailed?.(manifest[m.i], m.i, m.reason);
        return;
      }

      if (m.t === 'done') {
        onDone?.(manifest, total, m.failed ?? []);
        return;
      }
      return;
    }

    // binary chunk
    if (!sink) return fail('chunk arrived before its file header');
    const buf = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
    fileGot += buf.byteLength;
    got += buf.byteLength;
    if (fileGot > manifest[index].size) return fail('sender overran the declared file size');
    sink.write(new Uint8Array(buf));
    onProgress?.({ index, fileGot, got, total });
  }

  return {
    handle,
    // Partial files are discarded, never saved. Losing a transfer is fine;
    // leaving a half-file on disk that looks complete is not.
    async abort() {
      if (sink) {
        await sink.close().catch(() => {});
        sink = null;
      }
    },
  };
}

/** In-memory sink — the fallback when File System Access is unavailable (Safari, iOS). */
export function memorySink() {
  const parts = [];
  return {
    write: (c) => parts.push(c),
    close: async () => new Blob(parts),
  };
}

/**
 * Streams straight to a file the user chose, so nothing is held in memory and
 * size stops mattering. Only Chromium exposes this, and only from a user
 * gesture — which is why the handle has to be obtained at the accept tap
 * rather than when the first byte arrives.
 */
export function diskSink(writable) {
  return {
    write: (c) => writable.write(c),
    close: async () => {
      await writable.close();
      return null; // already on disk; there is nothing to hand back
    },
  };
}

export const canStreamToDisk = () =>
  typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';

/**
 * What this browser can hold in memory before the tab is killed. Deliberately
 * conservative: the peak is the file being assembled plus everything already
 * received in the batch, and being wrong here means the tab dies mid-transfer
 * with nothing on screen to explain it.
 */
export function memoryCeiling(ua = typeof navigator === 'undefined' ? '' : navigator.userAgent) {
  if (/iPhone|iPad|iPod/.test(ua)) return 0.7e9;
  if (/Android/.test(ua)) return 1.2e9;
  return 1.8e9;
}
