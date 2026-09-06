// File transfer protocol over an RTCDataChannel.
//
// Wire format, all on one ordered binary channel:
//   JSON string  {t:'offer',   tid, files:[{name,size,type}]}
//   JSON string  {t:'accept'} | {t:'decline'} | {t:'resume', have:[bytes]}
//   JSON string  {t:'start',   i, from}
//   ArrayBuffer  ... raw chunks, in order, up to file.size bytes total
//   JSON string  {t:'end',     i}   | {t:'skip', i, reason}
//   JSON string  {t:'done',    failed:[i]}
//
// 'skip' is how a single file fails without taking the batch with it: the
// receiver discards whatever arrived and the sender moves to the next file.
//
// 'resume' is how a dropped connection does not cost the bytes already moved.
// The offer carries a transfer id; a receiver that recognises it answers with
// how much of each file it kept instead of asking to accept again, and the
// sender seeks past that. At ten gigabytes a lost connection would otherwise
// mean starting over, which is the difference between slow and unusable.
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
  { chunkSize = DEFAULT_CHUNK, onProgress, onFailed, signal, offsets = [] } = {}
) {
  const total = totalBytes(files);
  // Bytes the receiver already has count as sent, so progress resumes where it
  // left off instead of restarting at zero.
  let sent = files.reduce((a, f, i) => a + Math.min(offsets[i] ?? 0, f.size), 0);
  const failed = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const from = Math.min(offsets[i] ?? 0, file.size);
    if (from >= file.size) {
      ch.send(JSON.stringify({ t: 'start', i, from }));
      ch.send(JSON.stringify({ t: 'end', i }));
      continue;
    }
    ch.send(JSON.stringify({ t: 'start', i, from }));

    let off = from;
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
  session,
  openSink,
  onOffer,
  onProgress,
  onFile,
  onFailed,
  onDone,
  onError,
}) {
  const st = session ?? createSession();
  let index = -1;
  let sink = null;

  const fail = (msg) => onError?.(new Error(msg));

  async function handle(data) {
    if (typeof data === 'string') {
      const m = JSON.parse(data);

      if (m.t === 'offer') {
        // A second offer carrying an id we are already part-way through is the
        // same transfer coming back, not a new request. Answer with what we
        // kept rather than asking the person to accept all over again.
        const resuming = st.tid && st.tid === m.tid && st.manifest;
        if (!resuming) {
          st.tid = m.tid ?? null;
          st.manifest = m.files;
          st.got = m.files.map(() => 0);
          st.sinks = [];
          st.results = [];
        }
        onOffer?.(st.manifest, totalBytes(st.manifest), resuming ? [...st.got] : null);
        return;
      }

      if (m.t === 'start') {
        index = m.i;
        // Trust our own count over the sender's claimed offset: we are the only
        // side that knows what actually reached disk.
        if ((m.from ?? 0) !== st.got[index]) {
          return fail(
            `${st.manifest[index].name} resumed at ${m.from} but ${st.got[index]} bytes were kept`
          );
        }
        sink = st.sinks[index] ?? (st.sinks[index] = await openSink(st.manifest[index], index));
        return;
      }

      if (m.t === 'end') {
        // Trust the declared size over the sender's framing: a short file is a
        // corrupt file, and silently saving it is worse than failing loudly.
        if (st.got[index] !== st.manifest[index].size) {
          await sink.close();
          st.sinks[index] = null;
          return fail(
            `${st.manifest[index].name} arrived incomplete (${st.got[index]} of ${st.manifest[index].size} bytes)`
          );
        }
        const result = await sink.close();
        st.sinks[index] = null;
        sink = null;
        if (result) st.results.push([st.manifest[index].name, result]);
        onFile?.(st.manifest[index], index, result);
        return;
      }

      if (m.t === 'skip') {
        // The sender gave up on this one. Throw away the partial rather than
        // hand over a file that looks whole and isn't.
        if (st.sinks[m.i]) {
          await st.sinks[m.i].close().catch(() => {});
          st.sinks[m.i] = null;
        }
        sink = null;
        st.got[m.i] = st.manifest[m.i].size; // accounted for, just not delivered
        onFailed?.(st.manifest[m.i], m.i, m.reason);
        return;
      }

      if (m.t === 'done') {
        st.tid = null; // finished, so a later offer is a genuinely new one
        onDone?.(st.manifest, totalBytes(st.manifest), m.failed ?? [], st.results);
        return;
      }
      return;
    }

    // binary chunk
    if (!sink) return fail('chunk arrived before its file header');
    const buf = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
    if (st.got[index] + buf.byteLength > st.manifest[index].size)
      return fail('sender overran the declared file size');
    sink.write(new Uint8Array(buf));
    st.got[index] += buf.byteLength;
    onProgress?.({
      index,
      fileGot: st.got[index],
      got: st.got.reduce((a, b) => a + b, 0),
      total: totalBytes(st.manifest),
    });
  }

  return {
    handle,
    session: st,
    /** Bytes safely kept per file — what a resume offer is answered with. */
    have: () => [...st.got],
    /** True while a dropped transfer could still be picked up where it stopped. */
    resumable: () => !!st.tid && st.got.some((n) => n > 0),
    // Partial files are discarded, never saved, unless the transfer is still
    // resumable — then the partial IS the progress worth keeping.
    async abort({ keep = false } = {}) {
      if (keep) return;
      for (let i = 0; i < st.sinks.length; i++) {
        if (st.sinks[i]) await st.sinks[i].close().catch(() => {});
        st.sinks[i] = null;
      }
      st.tid = null;
      sink = null;
    },
  };
}

/** State that outlives a dropped connection, so a resume has something to resume. */
export function createSession() {
  return { tid: null, manifest: null, got: [], sinks: [], results: [] };
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
 *
 * Only relevant when nothing better is available — see opfsSink.
 */
export function memoryCeiling(ua = typeof navigator === 'undefined' ? '' : navigator.userAgent) {
  if (/iPhone|iPad|iPod/.test(ua)) return 0.7e9;
  if (/Android/.test(ua)) return 1.2e9;
  return 1.8e9;
}

// ---- private filesystem ---------------------------------------------------
// Phones cannot open a save picker, so the alternative to holding a file in
// memory is holding it on the browser's own disk. Bytes land in the Origin
// Private File System as they arrive and the finished file is handed over from
// there — the limit stops being the tab's memory and becomes the storage quota,
// which is a share of free disk rather than a gigabyte.

const OPFS_DIR = 'incoming';

export const canUseOpfs = () =>
  typeof navigator !== 'undefined' &&
  !!navigator.storage?.getDirectory &&
  typeof FileSystemFileHandle !== 'undefined' &&
  // Safari only grew createWritable in 17; without it there is no append path.
  !!FileSystemFileHandle.prototype.createWritable;

const opfsDir = async () =>
  (await navigator.storage.getDirectory()).getDirectoryHandle(OPFS_DIR, { create: true });

/** A sink that streams to the browser's own disk and hands back a File. */
export async function opfsSink(key) {
  const dir = await opfsDir();
  const handle = await dir.getFileHandle(key, { create: true });
  const w = await handle.createWritable();
  return {
    write: (c) => w.write(c),
    close: async () => {
      await w.close();
      // Disk-backed, so object URLs and the share sheet stream from it rather
      // than pulling the whole thing into memory.
      return handle.getFile();
    },
  };
}

/** Bounded retention: these are scratch files, and quota is finite. */
export async function pruneOpfs(keepKeys = []) {
  if (!canUseOpfs()) return 0;
  const keep = new Set(keepKeys);
  let removed = 0;
  try {
    const dir = await opfsDir();
    for await (const name of dir.keys()) {
      if (keep.has(name)) continue;
      await dir.removeEntry(name).catch(() => {});
      removed++;
    }
  } catch {
    /* no OPFS access — nothing to prune */
  }
  return removed;
}

/** Free space we can actually claim, for warning against a real number. */
export async function storageHeadroom() {
  try {
    const { quota = 0, usage = 0 } = (await navigator.storage?.estimate?.()) ?? {};
    return Math.max(0, quota - usage);
  } catch {
    return 0;
  }
}
