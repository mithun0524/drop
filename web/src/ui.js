// Screens and state. One render function, one state object — the whole app is
// small enough that a framework would be more code than it saves.

import {
  COLORS,
  ON,
  KEYS,
  NAMES,
  loadMe,
  saveMe,
  loadSettings,
  saveSettings,
  isTrusted,
  trust,
  loadTrusted,
  forgetTrusted,
  resetIdentity,
  freeName,
  identityKey,
} from './identity.js';
import { Net } from './net.js';
import { isNative, nativeSink, shareNative, nativeLocation, folderFor } from './native.js';
import qrcode from 'qrcode-generator';
import {
  sendFiles,
  createReceiver,
  describe,
  memorySink,
  diskSink,
  canStreamToDisk,
  memoryCeiling,
  createSession,
  opfsSink,
  canUseOpfs,
  pruneOpfs,
  storageHeadroom,
  formatSize,
} from './transfer.js';

const app = document.getElementById('app');

const S = {
  screen: 'radar', // see render() below
  me: loadMe(),
  settings: loadSettings(),
  peers: [],
  status: 'online', // online | reconnecting
  target: null, // peer we're sending to / receiving from
  files: [], // File[] chosen to send
  manifest: null, // incoming file descriptions
  pct: 0,
  speed: 0,
  index: 0,
  fileName: '',
  results: [], // saved files after receiving
  hold: 0,
  error: null,
  code: null,
  entry: '',
  bytes: 0,
  startedAt: 0,
  failed: [], // indices skipped during the current transfer
  showQueue: false, // transfer screen: big numeral vs per-file queue
  stalled: false,
  backTo: 'radar', // where settings sub-screens return to
  qrUrl: null, // the link the enlarged QR is showing
  notice: null, // a transient line about something that just changed
  incomingFrom: null, // a peer that is choosing files for us right now
  headroom: 0, // bytes the browser will let us store, measured at boot
  saved: false, // the received files have been handed to the OS
  folder: null, // where this batch is being written, on native
  writables: null, // file handles opened at the accept tap, when streaming to disk
  tid: null, // this transfer's id, so a retry resumes rather than restarts
  resumable: false, // a dropped transfer that still has progress worth keeping
};

// Renders are coalesced into one animation frame. Transfer progress calls
// set() per chunk — without this, a 1GB send rebuilds the DOM thousands of
// times a second.
let frame = 0;
const set = (patch) => {
  Object.assign(S, patch);
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    render();
  });
};

if (S.me.fresh) S.screen = 'identity';

const net = new Net({ name: S.me.name, color: S.me.color, kind: S.me.kind });

// ---------------------------------------------------------------- helpers

const el = (tag, attrs = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'style') Object.assign(n.style, v);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else n.setAttribute(k, v);
  }
  for (const kid of [].concat(kids)) {
    if (kid == null || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

let maskSeq = 0;

/**
 * Device silhouettes. Solid shapes rather than outlines, per the design — but
 * a solid rounded rectangle only reads as a phone while it is small. The
 * details are punched out with a mask so they show whatever is behind, which
 * is a different colour in every place these appear.
 */
function silhouette(kind) {
  const box = { phone: [50, 80], tablet: [64, 86], laptop: [86, 58] }[kind] ?? [50, 80];
  const [w, h] = box;
  const id = 'dev' + ++maskSeq;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${w} ${h}`,
    class: 'dev dev-' + kind,
    'aria-hidden': 'true',
    focusable: 'false',
  });

  const mask = svgEl('mask', { id, maskUnits: 'userSpaceOnUse' });
  const shown = (a) => svgEl('rect', { ...a, fill: '#fff' });
  const cut = (a) => svgEl('rect', { ...a, fill: '#000' });

  if (kind === 'laptop') {
    mask.append(
      shown({ x: 8, y: 0, width: 70, height: 46, rx: 5 }),
      cut({ x: 12, y: 4, width: 62, height: 38, rx: 2 }), // screen
      shown({ x: 0, y: 50, width: 86, height: 8, rx: 4 }),
      cut({ x: 36, y: 52.5, width: 14, height: 3, rx: 1.5 }) // trackpad notch
    );
  } else if (kind === 'tablet') {
    mask.append(
      shown({ x: 0, y: 0, width: w, height: h, rx: 9 }),
      cut({ x: 6, y: 9, width: w - 12, height: h - 20, rx: 3 }), // screen
      cut({ x: w / 2 - 1, y: 4, width: 2, height: 2, rx: 1 }) // camera
    );
  } else {
    mask.append(
      shown({ x: 0, y: 0, width: w, height: h, rx: 11 }),
      cut({ x: w / 2 - 7, y: 6, width: 14, height: 2.5, rx: 1.25 }), // earpiece
      cut({ x: 4, y: 12, width: w - 8, height: h - 24, rx: 5 }), // screen
      cut({ x: w / 2 - 9, y: h - 6, width: 18, height: 2.5, rx: 1.25 }) // home bar
    );
  }

  svg.append(
    mask,
    svgEl('rect', { width: w, height: h, fill: 'currentColor', mask: `url(#${id})` })
  );
  return svg;
}

const kindLabel = (k) => (k === 'phone' ? 'Phone' : k === 'laptop' ? 'Laptop' : 'Tablet');

/**
 * A QR as one SVG path. The screen's whole job is getting another device onto
 * this page, and typing the URL on a phone is the thing people give up on.
 */
function qrSvg(text, label) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 2; // the quiet zone scanners need to find the code
  const size = n + quiet * 2;

  let d = '';
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('class', 'qr');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  svg.setAttribute('shape-rendering', 'crispEdges');
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('width', size);
  bg.setAttribute('height', size);
  bg.setAttribute('fill', '#fff');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#101014');
  svg.append(bg, path);
  return svg;
}

const appUrl = (code) =>
  location.origin + location.pathname + (code ? '?room=' + encodeURIComponent(code) : '');

/** "Red Kite" -> "RK". Single-word names fall back to their first two letters. */
const initials = (name = '') => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
};

const eyebrow = (t) => el('div', { class: 'eyebrow' }, t);

/** The radar's status line. The dot carries the connection state so it is
 *  always visible; the text says what is true right now. */
const liveLine = (text) =>
  el('div', { class: 'live' + (S.status === 'reconnecting' ? ' off' : S.notice ? ' note' : '') }, [
    el('i'),
    // The label clips, not the row: the dot's pulse ring is a box-shadow that
    // grows past its box, and overflow on the row would square it off.
    el('span', {}, S.status === 'reconnecting' ? 'Reconnecting' : (S.notice ?? text)),
  ]);

const head = (html, cls = '') => el('h2', { class: 'head ' + cls, html });

const blackBtn = (label, on) => el('button', { class: 'btn', onClick: on }, label);

const ghostBtn = (label, on) => el('button', { class: 'btn ghost', onClick: on }, label);

const plainBtn = (label, on) => el('button', { class: 'btn plain', onClick: on }, label);


const closeBtn = (on) =>
  el('button', { class: 'gear close', 'aria-label': 'Close', onClick: on }, [el('span'), el('span')]);

// The settings entry is your own avatar: same colour and silhouette the other
// devices see you as, so the control reads as "you" rather than as a menu.
const gearBtn = () =>
  el(
    'button',
    {
      class: 'avatar',
      'aria-label': `You are ${S.me.name}. Open settings`,
      style: { background: COLORS[S.me.color], color: ON[S.me.color] },
      onClick: () => set({ screen: 'settings' }),
    },
    initials(S.me.name)
  );

const row = (label, sub, onClick, extra) =>
  el('button', { class: 'row', onClick }, [
    el('div', { style: { minWidth: 0 } }, [
      el('div', { class: 'row-label' }, label),
      sub && el('div', { class: 'row-sub' }, sub),
    ]),
    extra ?? el('div', { class: 'chev' }),
  ]);

const toggleRow = (label, sub, on, onChange) =>
  el('button', { class: 'row', role: 'switch', 'aria-checked': String(on), onClick: onChange }, [
    el('div', { style: { minWidth: 0 } }, [
      el('div', { class: 'row-label' }, label),
      sub && el('div', { class: 'row-sub' }, sub),
    ]),
    el('div', { class: 'switch' + (on ? ' on' : '') }, [el('i')]),
  ]);

// ---------------------------------------------------------------- networking

net.addEventListener('peers', (e) => {
  set({ peers: e.detail });
  resolveNameClash();
});

/**
 * Two devices called Red Kite makes the room unreadable — the whole product is
 * "find that name on their screen". Exactly one side renames: the higher peer
 * id yields, which both sides compute identically, so they cannot swap into a
 * new clash or both sit still waiting for the other.
 */
function resolveNameClash() {
  const mine = identityKey(S.me);
  const clash = S.peers.find((p) => identityKey(p) === mine);
  if (!clash || !net.id || net.id < clash.id) return;

  const taken = S.peers.map(identityKey);
  const name = freeName(S.me.color, taken, S.me.name);
  const me = { ...S.me, name };
  saveMe(me);
  net.setMe({ name: me.name, color: me.color, kind: me.kind });
  set({ me, notice: `Someone here was already ${S.me.name} — you are ${name}` });
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => set({ notice: null }), 7000);
}

let noticeTimer = 0;
net.addEventListener('status', (e) => set({ status: e.detail }));

net.addEventListener('blocked', () => {
  if (S.screen === 'connecting' || S.screen === 'waiting') set({ screen: 'blocked' });
});

// Screens whose whole purpose is waiting for someone to turn up. Something
// happening supersedes them; a screen you are mid-action on does not.
const IDLE_SCREENS = new Set(['radar', 'qr', 'pairshow', 'pairenter']);

let hintTimer = 0;

net.addEventListener('hint', ({ detail: { from, kind } }) => {
  clearTimeout(hintTimer);
  if (kind !== 'picking')
    return set({ incomingFrom: null, screen: S.screen === 'awaited' ? 'radar' : S.screen });
  const peer = net.peers.get(from);
  if (!peer) return;
  const idle = IDLE_SCREENS.has(S.screen);
  set({
    incomingFrom: peer,
    screen: idle ? 'awaited' : S.screen,
    target: idle ? peer : S.target,
  });
  // If they close the tab mid-pick there is no 'stopped', so it lapses.
  hintTimer = setTimeout(
    () => set({ incomingFrom: null, screen: S.screen === 'awaited' ? 'radar' : S.screen }),
    90_000
  );
});

net.addEventListener('stalled', (e) => {
  if (S.target?.id === e.detail && (S.screen === 'sending' || S.screen === 'receiving'))
    set({ stalled: true });
});

net.addEventListener('resumed', (e) => {
  if (S.target?.id === e.detail) set({ stalled: false });
});

net.addEventListener('gone', (e) => {
  if (S.target?.id !== e.detail) return;
  if (S.screen === 'sending' || S.screen === 'receiving') {
    // Keep the partial: it is the progress a resume exists to save.
    const keep = !!rx?.resumable() || S.screen === 'sending';
    rx?.abort({ keep });
    set({ screen: 'vanished', stalled: false, resumable: keep });
  } else if (S.screen === 'waiting' || S.screen === 'confirm') {
    set({ screen: 'radar', target: null });
  }
});

let rx = null; // active receiver
let abort = null; // AbortController for an active send
// Survives a dropped connection: it is what makes a resume possible rather
// than starting a ten gigabyte transfer over.
let session = createSession();

net.addEventListener('channel', ({ detail: { id, ch } }) => {
  ch.addEventListener('message', (e) => onChannelMessage(id, e.data));
});

async function onChannelMessage(from, data) {
  // An offer can arrive on a channel we didn't initiate — that's someone
  // sending to us. Everything after it is handled by the receiver.
  if (typeof data === 'string') {
    const m = JSON.parse(data);

    if (m.t === 'offer') {
      const peer = net.peers.get(from) ?? { id: from, name: 'Someone', color: 'blue' };
      let resumeFrom = null;
      rx = buildReceiver((have) => (resumeFrom = have));
      await rx.handle(data);

      // An offer we are already part-way through is the same transfer coming
      // back. It was accepted once; asking again would be asking about a
      // decision already made.
      if (resumeFrom) {
        net.channel(from)?.send(JSON.stringify({ t: 'resume', have: resumeFrom }));
        return set({
          screen: 'receiving',
          target: peer,
          manifest: m.files,
          stalled: false,
          startedAt: performance.now(),
        });
      }

      set({
        screen: 'incoming',
        target: peer,
        manifest: m.files,
        hold: 0,
        failed: [],
        incomingFrom: null,
      });
      // A device you've accepted from before skips the hold, if you asked for it.
      if (S.settings.autoAccept && isTrusted(peer)) accept();
      return;
    }
    if (m.t === 'accept') return startSending(from);
    if (m.t === 'resume') return startSending(from, m.have);
    if (m.t === 'decline') return set({ screen: 'declined' });
    if (m.t === 'cancel') {
      rx?.abort();
      return set({ screen: 'radar', target: null });
    }
  }
  if (rx) await rx.handle(data);
}

function buildReceiver(onResume) {
  return createReceiver({
    session,
    onOffer: (manifest, total, have) => have && onResume?.(have),
    // Handles are opened at the accept tap, because the save picker is only
    // allowed from a user gesture. When we have one, bytes go straight to disk
    // and size stops mattering; otherwise the file is assembled in memory and
    // the accept screen has already warned about the ceiling.
    openSink: async (meta, i) => {
      if (isNative()) {
        try {
          // Straight to the device filesystem: no quota, no tab to be killed,
          // and the file is already where the person can find it afterwards.
          return await nativeSink(safeName(meta.name), S.folder);
        } catch {
          /* fall through — a saved file in the wrong place beats none */
        }
      }
      const w = S.writables?.[i];
      if (w) return diskSink(w); // a file the person chose: no limit at all
      if (canUseOpfs()) {
        try {
          // Keyed by transfer so a resumed file reuses its own partial and a
          // prune can tell live scratch from dead.
          return await opfsSink(`${S.tid ?? 'x'}-${i}`);
        } catch {
          /* quota refused or no access — memory is still better than failing */
        }
      }
      return memorySink();
    },
    onProgress: ({ got, total, index }) => {
      const secs = (performance.now() - S.startedAt) / 1000;
      set({
        pct: (got / total) * 100,
        speed: secs > 0.3 ? got / 1e6 / secs : 0,
        index,
        bytes: got,
        fileName: S.manifest?.[index]?.name ?? '',
      });
    },

    onFailed: (meta, i) => set({ failed: [...S.failed, i] }),
    onDone: (manifest, total, failed, results) =>
      set({ screen: 'saved', results, pct: 100, showQueue: false, stalled: false, writables: null }),
    onError: (err) => set({ screen: 'vanished', error: err.message }),
  });
}

/**
 * A code points at the room you are already in — it does not move you into a
 * new one. That is what lets the front screen show one without giving up
 * automatic discovery, and why there is nothing to leave afterwards.
 */
function pairingCode() {
  if (!S.code) {
    S.code = Math.random().toString(36).slice(2, 6).toUpperCase();
    net.publish(S.code);
  }
  return S.code;
}

async function pickTarget(peer) {
  if (!sameNetwork(peer)) return set({ target: peer, screen: 'offnet' });
  // Sent over the signalling socket, before any connection exists: they learn
  // someone is picking for them, and you learn you tapped the right device
  // before spending time in the file picker.
  net.hint(peer.id, 'picking');
  set({ target: peer, screen: 'pick' });
}

const sameNetwork = (peer) => !peer?.net || !net.net || peer.net === net.net;

async function offerFiles(peer, files, tid = null) {
  // The server tells us which network each peer arrived from. Different
  // networks cannot reach each other over the LAN, and no amount of waiting
  // changes that.
  if (!sameNetwork(peer)) return set({ target: peer, files, screen: 'offnet' });
  // Re-offering with the same id is how the other side knows to answer with
  // what it kept instead of starting again.
  const id = tid ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
  set({ target: peer, files, tid: id, screen: 'connecting', error: null });
  try {
    const ch = await net.open(peer.id);
    ch.send(JSON.stringify({ t: 'offer', tid: id, files: describe(files) }));
    set({ screen: 'waiting' });
  } catch {
    set({ screen: 'blocked' });
  }
}

async function startSending(id, offsets = []) {
  const ch = net.channel(id);
  abort = new AbortController();
  set({ screen: 'sending', pct: 0, startedAt: performance.now(), bytes: 0, failed: [], stalled: false });
  try {
    await sendFiles(ch, S.files, {
      signal: abort.signal,
      offsets,
      onFailed: (i) => set({ failed: [...S.failed, i] }),
      onProgress: ({ sent, total, index }) => {
        const secs = (performance.now() - S.startedAt) / 1000;
        set({
          pct: (sent / total) * 100,
          speed: secs > 0.3 ? sent / 1e6 / secs : 0,
          index,
          bytes: sent,
          fileName: S.files[index]?.name ?? '',
        });
      },
    });
    set({ screen: 'done', pct: 100, showQueue: false, stalled: false });
  } catch (err) {
    if (err.message !== 'cancelled') set({ screen: 'vanished', error: err.message });
  }
}

async function accept() {
  trust(S.target); // accepting once is what makes auto-accept possible later
  const folder = folderFor();

  // Must happen inside the gesture that accepted, before any await that would
  // end it — browsers only open a save picker from a user action.
  let writables = null;
  if (canStreamToDisk() && totalOf(S.manifest) > memoryCeiling()) {
    try {
      if (S.manifest.length === 1) {
        const handle = await window.showSaveFilePicker({ suggestedName: S.manifest[0].name });
        writables = [await handle.createWritable()];
      } else {
        // One folder, not one dialog per file: a batch of forty photos would
        // otherwise open forty save prompts.
        const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
        writables = [];
        for (const f of S.manifest) {
          const handle = await dir.getFileHandle(safeName(f.name), { create: true });
          writables.push(await handle.createWritable());
        }
      }
    } catch {
      writables = null; // picker dismissed — fall back to memory
    }
  }

  net.channel(S.target.id)?.send(JSON.stringify({ t: 'accept' }));
  set({ screen: 'receiving', pct: 0, startedAt: performance.now(), bytes: 0, writables, folder });
}

/** The sender names these files, and the receiver has handed us a folder
 *  handle, so a name must never be able to point outside it. */
export function safeName(name) {
  const base = String(name).split(/[/\\]/).pop() || 'file';
  const clean = base
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/^\.+/, '_')
    .trim();
  return clean.slice(0, 180) || 'file';
}

const totalOf = (files) => (files ?? []).reduce((a, f) => a + f.size, 0);

/** True only when the file would actually have to live in memory. */
const overCeiling = (files) =>
  !canUseOpfs() && !canStreamToDisk() && totalOf(files) > memoryCeiling();

/** True when it exceeds what the browser will let us store on disk. */
const overQuota = (files) => S.headroom > 0 && totalOf(files) > S.headroom;

function decline() {
  net.channel(S.target.id)?.send(JSON.stringify({ t: 'decline' }));
  rx?.abort();
  set({ screen: 'radar', target: null, writables: null });
}

function cancel() {
  if (S.target) net.hint(S.target.id, 'stopped');
  abort?.abort();
  rx?.abort(); // a deliberate stop discards the partial; only a drop keeps it
  session = createSession();
  net.channel(S.target?.id)?.send(JSON.stringify({ t: 'cancel' }));
  set({ screen: 'radar', target: null, files: [], tid: null, resumable: false });
}

// ---------------------------------------------------------------- file input

const input = el('input', { type: 'file', multiple: true, style: { display: 'none' } });
document.body.append(input);
input.addEventListener('change', () => {
  if (input.files.length) set({ files: [...input.files], screen: 'confirm' });
  input.value = '';
});

// Desktop: the whole window is the drop target.
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  app.classList.add('dragging');
});
document.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) app.classList.remove('dragging');
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  app.classList.remove('dragging');
  const files = [...e.dataTransfer.files];
  if (!files.length) return;
  // Drop with one peer around goes straight to them; otherwise hold the files
  // and let the next tile tap send them.
  if (S.peers.length === 1) set({ files, target: S.peers[0], screen: 'confirm' });
  else set({ files, screen: 'radar' });
});

// ---------------------------------------------------------------- screens

function radar() {
  const many = S.peers.length > 6;
  const count = S.peers.length;

  if (count === 0) {
    return [
      // Not "searching" — nothing is being scanned. The socket is open and the
      // server pushes the instant another device joins, so the honest signal is
      // that we are connected and listening.
      el('div', { class: 'topbar' }, [liveLine('Listening on this network'), gearBtn()]),
      el('div', { class: 'screen to-edge' }, [
        el('div', { class: 'qrwrap' }, [
          el(
            'button',
            {
              class: 'qrbox',
              'aria-label': 'Enlarge the QR code',
              onClick: () => set({ screen: 'qr', qrUrl: appUrl(pairingCode()), backTo: 'radar' }),
            },
            // The code costs nothing now that it points at this room rather
            // than replacing it, so the front QR carries one: scanning works
            // whether or not the two devices group together automatically.
            [qrSvg(appUrl(pairingCode()), 'Scan to open this page on another device')]
          ),
          el('div', { class: 'qrcap' }, 'Point the other camera here'),
          navigator.share
            ? el(
                'button',
                {
                  class: 'linkline',
                  style: { alignSelf: 'center', paddingTop: '10px' },
                  onClick: () =>
                    navigator
                      .share({ title: 'Drop', url: appUrl() })
                      .catch(() => {}),
                },
                'or send the link'
              )
            : el('div', { class: 'qrurl' }, location.host),
        ]),
        head('Nobody else<br>is here yet.'),
        el('p', { class: 'body', style: { color: 'var(--dim)' } }, [
          'Open this page on the other device. It takes over one of these blocks the moment it appears.',
        ]),
        el(
          'button',
          { class: 'linkline', onClick: () => set({ screen: 'pairshow', backTo: 'radar' }) },
          'Not showing up? Show a code'
        ),
        el(
          'div',
          { class: 'swatches waiting' },
          KEYS.map((k, i) =>
            el('div', { style: { background: COLORS[k], animationDelay: i * 0.18 + 's' } })
          )
        ),
      ]),
      footer(),
    ];
  }

  return [
    S.status === 'reconnecting' && el('div', { class: 'banner' }, 'Lost the network — reconnecting'),
    el('div', { class: 'topbar' }, [
      liveLine(
        S.incomingFrom
          ? `${S.incomingFrom.name} is choosing files for you`
          : S.files.length
            ? `${S.files.length} file${S.files.length > 1 ? 's' : ''} ready — pick a device`
            : `${count} device${count > 1 ? 's' : ''} on this Wi-Fi`
      ),
      gearBtn(),
    ]),
    el(
      'div',
      {
        class:
          'tiles' +
          (count === 1 ? ' one' : '') +
          (many ? ' many' : '') +
          (S.status === 'reconnecting' ? ' dim' : ''),
      },
      S.peers.map((p) =>
        el(
          'button',
          {
            class: 'tile' + (S.incomingFrom?.id === p.id ? ' waiting-on' : ''),
            style: { background: COLORS[p.color] ?? COLORS.blue, color: ON[p.color] ?? '#fff' },
            onClick: () =>
              S.incomingFrom?.id === p.id
                ? set({ screen: 'awaited', target: p })
                : S.files.length
                  ? offerFiles(p, S.files)
                  : pickTarget(p),
          },
          [
            el('div', { class: 'art' }, [silhouette(p.kind)]),
            el('div', {}, [
              el('div', { class: 'nm' }, p.name),
              el(
                'div',
                { class: 'kind' },
                S.incomingFrom?.id === p.id
                  ? 'Choosing files for you'
                  : sameNetwork(p)
                    ? kindLabel(p.kind) + ' · tap to send'
                    : 'Different network'
              ),
            ]),
          ]
        )
      )
    ),
    footer(),
  ];
}

function footer() {
  return el(
    'button',
    { class: 'foot', onClick: () => set({ screen: 'settings' }) },
    [
      el(
        'div',
        {
          class: 'dot',
          style: { background: COLORS[S.me.color], color: ON[S.me.color] },
        },
        // Your initials, not a device shape: this is who you are, and the
        // label beside it already says which device. Peer tiles keep the
        // silhouettes, where the device kind is the useful part.
        initials(S.me.name)
      ),
      el('div', { class: 'nm' }, S.me.name),
      el('div', { class: 'side' }, 'This ' + kindLabel(S.me.kind).toLowerCase()),
    ]
  );
}

function identity() {
  return [
    el('div', { class: 'screen' }, [
      eyebrow(S.me.fresh ? 'First time here' : 'You'),
      head('Pick a colour<br>and a name.', 'sm'),
      el('p', { class: 'body', style: { color: 'var(--dim)' } }, [
        "That's the whole setup. It's how the other person finds you — they look for your colour and say your name out loud.",
      ]),
      el(
        'div',
        { class: 'colorpicks' },
        KEYS.map((k) =>
          el(
            'button',
            {
              class: S.me.color === k ? 'on' : '',
              style: {
                background: COLORS[k],
                outline: S.me.color === k ? '3px solid var(--ink)' : 'none',
              },
              onClick: () => set({ me: { ...S.me, color: k, name: NAMES[k][0] } }),
            },
            [
              el('div', { class: 'mark', style: { background: ON[k] } }, [
                el('div', { class: 'tick', style: { borderColor: COLORS[k] } }),
              ]),
            ]
          )
        )
      ),
      el(
        'div',
        { class: 'namepicks' },
        NAMES[S.me.color].slice(0, 4).map((n) =>
          el(
            'button',
            { class: S.me.name === n ? 'on' : '', onClick: () => set({ me: { ...S.me, name: n } }) },
            n
          )
        )
      ),
      el('div', { class: 'spring' }),
      el(
        'div',
        {
          class: 'mepreview',
          style: { background: COLORS[S.me.color], color: ON[S.me.color] },
        },
        [
          el('div', {
            style: {
              width: '34px',
              height: '52px',
              borderRadius: '8px',
              background: 'currentColor',
              flex: 'none',
            },
          }),
          el('div', {}, [
            el('div', { class: 'me-name' }, S.me.name),
            el('div', { class: 'kind', style: { marginTop: '8px' } }, 'How others see you'),
          ]),
        ]
      ),
      el('div', { style: { height: '14px' } }),
      blackBtn('This is me', () => {
        const me = { ...S.me, fresh: false };
        saveMe(me);
        net.setMe({ name: me.name, color: me.color, kind: me.kind });
        set({ me, screen: S.backTo === 'settings' ? 'settings' : 'radar', backTo: 'radar' });
      }),
    ]),
  ];
}

function pick() {
  return [
    el('div', { class: 'screen' }, [
      eyebrow('Send to'),
      el('div', { class: 'target-name' }, S.target.name),
      // The card you just tapped, larger: same colour, same silhouette, so the
      // screen reads as a continuation of the tap rather than a new place.
      el('div', { class: 'hero' }, [
        el('div', { class: 'hero-dev' }, [silhouette(S.target.kind)]),
        el('div', { class: 'kind' }, kindLabel(S.target.kind)),
      ]),
      blackBtn('Choose files', () => input.click()),
      plainBtn('Cancel', () => {
        net.hint(S.target.id, 'stopped');
        set({ screen: 'radar', target: null });
      }),
    ]),
  ];
}

function connecting() {
  return [
    el('div', { class: 'screen' }, [
      eyebrow('Connecting'),
      el('div', { class: 'center' }, [
        el('div', { class: 'pulse' }),
        head(`Reaching<br>${S.target.name}…`),
      ]),
      ghostBtn('Cancel', cancel),
    ]),
  ];
}

function waiting() {
  const total = S.files.reduce((a, f) => a + f.size, 0);
  return [
    el('div', { class: 'screen' }, [
      eyebrow('Waiting'),
      el('div', { class: 'center' }, [
        el('div', { class: 'pulse' }),
        head(`${S.target.name}<br>has to say yes.`),
        el(
          'div',
          { class: 'meta' },
          `${S.files.length} file${S.files.length > 1 ? 's' : ''} · ${formatSize(total)}`
        ),
      ]),
      ghostBtn('Cancel', cancel),
    ]),
  ];
}

function declined() {
  return [
    el('div', { class: 'screen' }, [
      el('div', { class: 'center' }, [
        head(`${S.target.name}<br>said no.`),
        el('p', { class: 'body' }, ['Nothing was sent. Try again, or pick a different device.']),
      ]),
      blackBtn('Back to devices', () => set({ screen: 'radar', target: null, files: [] })),
    ]),
  ];
}

/** Nothing is being asked yet — this only exists so the tile is not a button
 *  that would start a send in the opposite direction. */
function awaited() {
  return [
    el('div', { class: 'screen' }, [
      eyebrow('Incoming'),
      el('div', { class: 'center' }, [
        // Not decoration: these are the rows the incoming list will be made of,
        // so the wait previews the shape of what is coming.
        el(
          'div',
          { class: 'picking' },
          [72, 54, 86, 63].map((w) =>
            el('div', { class: 'prow' }, [
              el('i'),
              el('span', { style: { width: w + '%' } }),
            ])
          )
        ),
        head(`${S.target.name} is<br>choosing files<br>for you.`, 'sm'),
        el('p', { class: 'body' }, [
          'Nothing to do yet. You will get to accept or decline once they have picked.',
        ]),
      ]),
      ghostBtn('Back to devices', () => set({ screen: 'radar' })),
    ]),
  ];
}

function incoming() {
  const total = totalOf(S.manifest);
  const n = S.manifest.length;
  const heavy = overCeiling(S.manifest);
  const cramped = overQuota(S.manifest);
  const big = total > memoryCeiling();

  let timer = null;
  const startHold = () => {
    clearInterval(timer);
    timer = setInterval(() => {
      if (S.hold >= 100) {
        clearInterval(timer);
        return accept();
      }
      set({ hold: S.hold + 9 });
    }, 45);
  };
  const endHold = () => {
    clearInterval(timer);
    if (S.hold < 100) set({ hold: 0 });
  };

  return [
    el('div', { class: 'screen' }, [
      eyebrow('Incoming'),
      el('div', { class: 'center' }, [
        head(
          `${S.target.name}<br>wants to send<br>you ${n} file${n > 1 ? 's' : ''}.`,
          n > 1 ? '' : 'sm'
        ),
        el('div', { class: 'meta' }, formatSize(total)),
        // Too big to hold, and this browser cannot stream to disk: say so now
        // rather than let the tab die halfway through with nothing on screen.
        cramped
          ? el('div', { class: 'warn' }, [
              el('b', {}, 'Bigger than this device can store.'),
              el(
                'span',
                {},
                `About ${formatSize(S.headroom)} is free for Drop to use. Ask them to send fewer ` +
                  'files at a time, or free up space first.'
              ),
            ])
          : heavy
            ? el('div', { class: 'warn' }, [
                el('b', {}, 'Bigger than this browser can hold.'),
                el(
                  'span',
                  {},
                  'It may run out of memory before it finishes. Ask them to send fewer files at a ' +
                    'time, or open Drop in Chrome on a computer.'
                ),
              ])
            : big && canStreamToDisk()
              ? el('div', { class: 'warn ok' }, [
                  el('b', {}, 'Large transfer — you will be asked where to save.'),
                  el('span', {}, 'Each file is written straight to disk as it arrives.'),
                ])
              : null,
      ]),
      el(
        'button',
        {
          class: 'hold',
          onPointerdown: startHold,
          onPointerup: endHold,
          onPointerleave: endHold,
        },
        [
          el('div', {
            class: 'fill',
            style: { width: S.hold + '%', background: COLORS[S.target.color] ?? COLORS.blue },
          }),
          el(
            'span',
            {},
            S.hold >= 100
              ? 'Accepting…'
              : S.hold > 0
                ? 'Keep holding…'
                : big && canStreamToDisk()
                  ? 'Hold to accept and choose where to save'
                  : 'Hold to accept'
          ),
        ]
      ),
      plainBtn('Decline', decline),
    ]),
  ];
}

function transfer() {
  const receiving = S.screen === 'receiving';
  const c = COLORS[S.target?.color] ?? COLORS.blue;
  const on = ON[S.target?.color] ?? '#fff';
  const pct = Math.round(S.pct);
  const total = receiving
    ? S.manifest.reduce((a, f) => a + f.size, 0)
    : S.files.reduce((a, f) => a + f.size, 0);
  const count = receiving ? S.manifest.length : S.files.length;
  const eta = S.speed > 0 ? Math.max(1, Math.round((total - S.bytes) / 1e6 / S.speed)) : null;

  const content = (ink) =>
    el('div', { class: 'layer' + (ink === on ? ' knock' : ''), style: { color: ink } }, [
      el(
        'div',
        { class: 'eyebrow', style: { opacity: 0.62 } },
        S.stalled
          ? `Lost ${S.target.name} — holding on`
          : (receiving ? 'Receiving from ' : 'Sending to ') + S.target.name
      ),
      el('div', { class: 'pct' + (S.stalled ? ' stalled' : '') }, [
        el('b', {}, pct),
        el('i', {}, '%'),
      ]),
      el(
        'div',
        { class: 'subline' },
        S.stalled
          ? 'Waiting for them to come back…'
          : S.speed
            ? `${S.speed.toFixed(0)} MB/s · ${eta} s left`
            : 'Starting…'
      ),
      el('div', { class: 'curfile' }, S.fileName),
      el(
        'div',
        { class: 'eyebrow', style: { marginTop: '10px' } },
        S.stalled
          ? 'Paused · nothing lost yet'
          : `File ${S.index + 1} of ${count} · ${formatSize(total)}` +
            (S.failed.length ? ` · ${S.failed.length} failed` : '')
      ),
      count > 1 &&
        ink !== on &&
        el(
          'button',
          { class: 'btn plain queue-toggle', onClick: () => set({ showQueue: !S.showQueue }) },
          S.showQueue ? 'Hide file list' : `Show all ${count} files`
        ),
      ink === on
        ? el(
            'div',
            {
              style: {
                margin: '24px 0 0',
                border: '1.5px solid currentColor',
                borderRadius: '14px',
                padding: '19px',
                font: '600 clamp(14px, 4.1vw, 16px)/1 var(--font)',
                textAlign: 'center',
                opacity: 0.85,
              },
            },
            'Stop'
          )
        : el(
            'button',
            {
              class: 'btn ghost',
              style: { marginTop: '24px', borderColor: 'currentColor', opacity: 0.72 },
              onClick: cancel,
            },
            'Stop'
          ),
    ]);

  if (S.showQueue && count > 1) {
    const files = receiving ? S.manifest : S.files;
    return [
      el('div', { class: 'screen' }, [
        el('div', { class: 'topbar flush' }, [
          eyebrow((receiving ? 'Receiving from ' : 'Sending to ') + S.target.name),
          closeBtn(() => set({ showQueue: false })),
        ]),
        el('div', { class: 'queue-head' }, [
          el('div', { class: 'queue-pct' }, [pct, el('span', {}, '%')]),
          el('div', { style: { textAlign: 'right' } }, [
            el('div', { class: 'meta', style: { margin: 0 } }, `${S.speed.toFixed(0)} MB/s`),
            el('div', { class: 'eyebrow', style: { marginTop: '8px' } }, `File ${S.index + 1} of ${count}`),
          ]),
        ]),
        el('div', { class: 'bar' }, [el('i', { style: { width: pct + '%', background: c } })]),
        queueView(files, count),
        el('p', { class: 'body sm', style: { color: 'var(--dim)', margin: '10px 0 0' } }, [
          'One file failing does not stop the others.',
        ]),
        ghostBtn('Stop everything', cancel),
      ]),
    ];
  }

  return [
    el('div', { class: 'xfer' + (S.stalled ? ' stalled' : '') }, [
      el('div', { class: 'fill', style: { height: pct + '%', background: c } }),
      content('#101014'),
      // The same content again, in the ink that reads on the colour, clipped to
      // the filled region — so the numeral inverts as the fill climbs past it.
      Object.assign(content(on), {
        style: `position:absolute;inset:0;display:flex;flex-direction:column;justify-content:flex-end;padding:0 26px 26px;color:${on};pointer-events:none;clip-path:inset(0 0 ${100 - pct}% 0);transition:clip-path .45s cubic-bezier(.3,.8,.3,1)`,
      }),
    ]),
  ];
}


function confirm_() {
  const total = S.files.reduce((a, f) => a + f.size, 0);
  const n = S.files.length;
  return [
    el('div', { class: 'screen' }, [
      eyebrow('Confirm'),
      head(`${n} file${n > 1 ? 's' : ''} to<br>${S.target.name}.`, 'sm'),
      el('div', { class: 'meta' }, formatSize(total) + ' total'),
      total > 4e9
        ? el('div', { class: 'warn' }, [
            el('b', {}, 'This is a lot to send at once.'),
            el('span', {}, 'The other device needs the free space for it. Fewer files at a time is safer.'),
          ])
        : null,
      // Centres when the list is short, fills and scrolls when it is long, so
      // one file does not leave a screen of empty colour beneath it.
      el(
        'div',
        { class: 'scroll filelist' },
        S.files.map((f) =>
          el('div', { class: 'filerow' }, [
            el('span', {}, f.name),
            el('span', {}, formatSize(f.size)),
          ])
        )
      ),
      blackBtn('Send', () => offerFiles(S.target, S.files)),
      plainBtn('Cancel', () => {
        net.hint(S.target.id, 'stopped');
        set({ screen: 'radar', files: [], target: null });
      }),
    ]),
  ];
}

function settings() {
  const trusted = loadTrusted();
  const back = () => set({ screen: S.backTo === 'settings' ? 'radar' : S.backTo });
  return [
    el('div', { class: 'screen scrolls' }, [
      el('div', { class: 'topbar flush' }, [eyebrow('Settings'), closeBtn(back)]),

      el(
        'button',
        {
          class: 'mepreview tappable',
          style: { background: COLORS[S.me.color], color: ON[S.me.color], marginTop: '10px' },
          onClick: () => set({ screen: 'identity', backTo: 'settings' }),
        },
        [
          el('div', { class: 'art' }, initials(S.me.name)),
          el('div', { style: { minWidth: 0, textAlign: 'left' } }, [
            el('div', { class: 'me-name' }, S.me.name),
            el('div', { class: 'me-sub' }, 'Tap to change colour or name'),
          ]),
        ]
      ),

      el('div', { class: 'section' }, 'Receiving'),
      toggleRow(
        'Accept without asking',
        trusted.length
          ? `From ${trusted.length} device${trusted.length > 1 ? 's' : ''} accepted since this page opened`
          : 'Only for devices you have already accepted, and only until you reload',
        S.settings.autoAccept,
        () => {
          const next = { ...S.settings, autoAccept: !S.settings.autoAccept };
          saveSettings(next);
          set({ settings: next });
        }
      ),
      trusted.length > 0 &&
        row('Forget those devices', 'Ask again for everything', () => {
          forgetTrusted();
          set({});
        }),

      el('div', { class: 'section' }, 'Pairing'),
      row('Show my code', 'For when devices do not find each other', () =>
        set({ screen: 'pairshow', backTo: 'settings' })
      ),
      row('Enter their code', 'Join a device that showed you a code', () =>
        set({ screen: 'pairenter', entry: '', backTo: 'settings' })
      ),

      el('div', { class: 'section' }, 'This device'),
      row('Reset identity', 'Get a new colour and name', () => {
        resetIdentity();
        const me = loadMe();
        net.setMe({ name: me.name, color: me.color, kind: me.kind });
        set({ me, screen: 'identity', backTo: 'settings' });
      }),

      el('div', { class: 'section' }, 'About'),
      el('p', { class: 'body sm', style: { color: 'var(--dim)', margin: '4px 0 0' } }, [
        'Files move straight from one device to the other over your local network. ' +
          'They are never uploaded, stored, or seen by any server — the only thing ' +
          'the server does is introduce the two devices to each other.',
      ]),
      el('p', { class: 'body sm', style: { color: 'var(--dim)', margin: '12px 0 0' } }, [
        'There is no account, and nothing you do here is recorded anywhere but this browser.',
      ]),
      el('div', { class: 'version' }, 'Drop · LAN only · v1'),
      el('div', { class: 'spring' }),
      ghostBtn('Done', back),
    ]),
  ];
}

/** Per-file queue — the other half of the transfer screen. */
function queueView(files, count) {
  return el(
    'div',
    { class: 'scroll', style: { marginTop: '12px' } },
    files.map((f, i) => {
      const failed = S.failed.includes(i);
      const done = !failed && i < S.index;
      const active = i === S.index && !failed;
      return el('div', { class: 'qrow' }, [
        el('div', {
          class: 'dot',
          style: {
            background: failed
              ? COLORS.red
              : done
                ? '#c9ccd2'
                : active
                  ? COLORS[S.target?.color] ?? COLORS.blue
                  : 'var(--line)',
          },
        }),
        el('div', { class: 'nm' }, f.name),
        el(
          'div',
          { class: 'stat', style: failed ? { color: COLORS.red } : active ? { color: 'var(--ink)' } : {} },
          failed ? 'FAILED' : done ? 'DONE' : active ? Math.round(S.pct) + '%' : 'WAITING'
        ),
      ]);
    })
  );
}

function done() {
  const total = S.files.reduce((a, f) => a + f.size, 0);
  const secs = Math.max(0.1, (performance.now() - S.startedAt) / 1000);
  return [
    el('div', { class: 'screen' }, [
      el('div', { class: 'center' }, [
        el('div', { class: 'bigcount' }, S.files.length),
        head(`file${S.files.length > 1 ? 's' : ''} sent to<br>${S.target.name}.`, 'sm'),
        el('div', { class: 'stats' }, [
          el('span', {}, formatSize(total)),
          el('span', {}, secs.toFixed(1) + ' s'),
          el('span', {}, (total / 1e6 / secs).toFixed(0) + ' MB/s'),
        ]),
        el(
          'div',
          { class: 'eyebrow', style: { marginTop: '20px', lineHeight: 1.6 } },
          'Nothing uploaded · nothing kept'
        ),
      ]),
      blackBtn('Send something else', () => set({ screen: 'radar', files: [], target: null })),
    ]),
  ];
}

function saved() {
  const total = totalOf(S.manifest);
  const secs = Math.max(0.1, (performance.now() - S.startedAt) / 1000);
  return [
    el('div', { class: 'screen' }, [
      eyebrow('From ' + S.target.name),
      el('div', { class: 'center' }, [
        el('div', { class: 'bigcount' }, S.manifest.length),
        head(
          isNative()
            ? `file${S.manifest.length > 1 ? 's' : ''} saved<br>to this device.`
            : `file${S.manifest.length > 1 ? 's' : ''} ready<br>to save.`,
          'sm'
        ),
        el(
          'div',
          { class: 'meta', style: { opacity: 0.8 } },
          `${formatSize(total)} · ${(total / 1e6 / secs).toFixed(0)} MB/s average`
        ),
        isNative()
          ? el(
              'div',
              { class: 'body sm', style: { marginTop: '14px', opacity: 0.85 } },
              nativeLocation(S.folder)
            )
          : null,
        el(
          'div',
          { class: 'scroll', style: { marginTop: '18px', maxHeight: '160px' } },
          S.results.map(([name, blob]) =>
            el('div', { class: 'filerow' }, [
              el('span', {}, name),
              el('span', {}, formatSize(blob.size)),
            ])
          )
        ),
      ]),
      blackBtn(
        isNative()
          ? 'Share'
          : S.saved
            ? 'Saved'
            : S.results.length > 1
              ? 'Save all'
              : 'Save',
        !isNative() && S.saved
          ? () => set({ screen: 'radar', target: null, results: [], saved: false })
          : saveAll
      ),
      plainBtn('Done', () => {
        pruneOpfs();
        session = createSession();
        set({ screen: 'radar', target: null, results: [], saved: false });
      }),
    ]),
  ];
}

async function saveAll() {
  if (isNative()) {
    try {
      await shareNative(S.manifest.map((f) => safeName(f.name)), S.folder);
    } catch {
      /* the sheet was dismissed, or sharing is unavailable — the files are
         already on disk either way */
    }
    return set({ saved: true });
  }

  const files = S.results.map(([name, blob]) =>
    blob instanceof File ? blob : new File([blob], name, { type: 'application/octet-stream' })
  );

  // Phones have no download folder worth speaking of, but they do have a share
  // sheet — and it takes the disk-backed File straight from storage, so a large
  // file is handed to the OS rather than pulled back into memory.
  if (navigator.canShare?.({ files })) {
    try {
      await navigator.share({ files });
      return afterSave();
    } catch (err) {
      if (err?.name === 'AbortError') return; // they dismissed the sheet
      /* sharing unavailable for this payload — fall through to downloads */
    }
  }

  // A click handler is the only place a browser will let us start downloads,
  // so they all go out from this one gesture.
  for (const file of files) {
    const url = URL.createObjectURL(file);
    const a = el('a', { href: url, download: file.name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  afterSave();
}

/** The scratch copies have served their purpose; quota is finite. */
function afterSave() {
  pruneOpfs();
  session = createSession();
  set({ saved: true });
}

function offNet() {
  return [
    el('div', { class: 'screen', style: { background: COLORS.yellow, color: '#101014' } }, [
      eyebrow('Different network'),
      el('div', { class: 'center' }, [
        head(`${S.target.name} is not<br>on your Wi-Fi.`, 'sm'),
        el('p', { class: 'body' }, [
          'You found each other through a code, but files move directly between ' +
            'devices over one local network — there is no route between two.',
        ]),
        el('p', { class: 'body', style: { fontWeight: 600 } }, [
          'Join the same Wi-Fi, or put both devices on one phone hotspot.',
        ]),
      ]),
      blackBtn('Back to devices', () => set({ screen: 'radar', target: null, files: [] })),
    ]),
  ];
}

function blocked() {
  return [
    el('div', { class: 'screen', style: { background: COLORS.yellow, color: '#101014' } }, [
      eyebrow('This network'),
      el('div', { class: 'center' }, [
        head("This Wi-Fi<br>won't let devices<br>talk to each<br>other."),
        el('p', { class: 'body' }, [
          'Café and office guest networks often block it on purpose. Both devices are online, but they can’t reach each other.',
        ]),
        el('p', { class: 'body', style: { fontWeight: 600 } }, [
          'Turn on a phone hotspot, put both devices on it, and everything works again.',
        ]),
      ]),
      blackBtn('Try this network again', () => set({ screen: 'radar', target: null })),
    ]),
  ];
}

function iosPermission() {
  return [
    el('div', { class: 'screen', style: { background: COLORS.yellow, color: '#101014' } }, [
      eyebrow('Permission needed'),
      el('div', { class: 'center' }, [
        head("iOS hasn't let<br>Drop see this<br>Wi-Fi yet."),
        el('div', { class: 'steps' }, [
          ['1', 'Open Settings'],
          ['2', 'Scroll down and tap Drop'],
          ['3', 'Turn on Local Network'],
        ].map(([n, t]) => el('div', {}, [el('i', {}, n), el('div', {}, t)]))),
        el('p', { class: 'body sm', style: { opacity: 0.75 } }, [
          'Asked once. Drop can only see device names, nothing else.',
        ]),
      ]),
      blackBtn('I turned it on', () => location.reload()),
    ]),
  ];
}

function noWifi() {
  return [
    el('div', { class: 'screen' }, [
      el('div', { class: 'center' }, [
        el(
          'div',
          { style: { display: 'flex', gap: '5px', alignItems: 'flex-end', marginBottom: '28px' } },
          [16, 30, 44].map((h) =>
            el('div', { style: { width: '14px', height: h + 'px', background: '#dcdfe4' } })
          )
        ),
        head("You're not<br>on Wi-Fi."),
        el('p', { class: 'body', style: { color: 'var(--dim)' } }, [
          'Drop moves files across a local network, so both devices have to be on the same one. Mobile data can’t do it.',
        ]),
      ]),
      blackBtn('Try again', () => location.reload()),
    ]),
  ];
}

function vanished() {
  // They rejoin with a new peer id, so match on the identity a person sees.
  const back = S.peers.find((p) => p.name === S.target?.name && p.color === S.target?.color);
  const done = Math.round(S.pct);
  const leave = () => {
    session = createSession();
    set({ screen: 'radar', target: null, files: [], tid: null, resumable: false });
  };
  const canResume = S.resumable && back && S.files.length;

  return [
    el('div', { class: 'screen' }, [
      el('div', { class: 'center' }, [
        head(`${S.target?.name ?? 'They'}<br>left the network.`, 'sm'),
        el('p', { class: 'body' }, [
          S.error ??
            (S.resumable
              ? `Stopped at ${done}%. Nothing is lost — carrying on picks up from there.`
              : 'The transfer stopped. Incomplete files were discarded — nothing half-saved.'),
        ]),
        S.resumable && !back
          ? el('p', { class: 'body sm', style: { color: 'var(--dim)' } }, [
              'Waiting for them to come back. Keep this page open.',
            ])
          : null,
      ]),
      canResume ? blackBtn(`Carry on from ${done}%`, () => offerFiles(back, S.files, S.tid)) : null,
      canResume ? plainBtn('Give up', leave) : blackBtn('Back to devices', leave),
    ]),
  ];
}

function qrBig() {
  const close = () => set({ screen: S.backTo, qrUrl: null });
  return [
    el('div', { class: 'screen qrfull', onClick: close }, [
      el('div', { class: 'qrbox big' }, [qrSvg(S.qrUrl, 'Scan to open this page')]),
      el('div', { class: 'qrcap' }, 'Point the other camera here'),
      el('div', { class: 'qrurl' }, S.qrUrl.replace(/^https?:\/\//, '')),
      // Otherwise there is no way to tell a scan worked without dismissing the
      // code and looking.
      S.peers.length
        ? el('div', { class: 'live arrived' }, [
            el('i'),
            el(
              'span',
              {},
              S.peers.length === 1
                ? `${S.peers[0].name} is here`
                : `${S.peers.length} devices are here`
            ),
          ])
        : null,
      ghostBtn(S.peers.length ? 'Done' : 'Cancel', close),
    ]),
  ];
}

function pairShow() {
  const c = COLORS[S.me.color];
  const code = pairingCode();
  return [
    el('div', { class: 'screen' }, [
      eyebrow('Pair by hand'),
      head('Type this code<br>on the other device.', 'sm tight'),
      el(
        'div',
        { class: 'code' },
        code.split('').map((v) => el('div', { style: { background: c, color: ON[S.me.color] } }, v))
      ),
      el('p', { class: 'body sm', style: { color: 'var(--dim)' } }, [
        'Anyone who scans or types this lands where you already are. It works for ten minutes.',
      ]),
      // The QR does a different job to the one on the front screen — it carries
      // the room, not just the page — but the headline is the code, so the QR
      // stays one tap away rather than taking a third of the screen.
      el(
        'button',
        {
          class: 'linkline',
          onClick: () => set({ screen: 'qr', qrUrl: appUrl(code), backTo: 'pairshow' }),
        },
        'or show a QR to scan'
      ),
      el('div', { class: 'spring' }),
      blackBtn('Done', () => set({ screen: S.backTo === 'settings' ? 'settings' : 'radar' })),
      plainBtn('I have their code instead', () =>
        set({ screen: 'pairenter', entry: '', backTo: S.backTo })
      ),
    ]),
  ];
}

function pairEnter() {
  const cells = [0, 1, 2, 3].map((i) =>
    el(
      'div',
      {
        style: {
          background: '#f4f6f8',
          color: '#101014',
          border: '2px solid ' + (i === S.entry.length ? '#101014' : 'transparent'),
        },
      },
      S.entry[i] ?? ''
    )
  );
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'ABC', '0', '⌫'];
  return [
    el('div', { class: 'screen' }, [
      eyebrow('Enter their code'),
      el('div', { class: 'code' }, cells),
      el('div', { class: 'spring' }),
      el(
        'div',
        { class: 'keys' },
        keys.map((v) =>
          el(
            'button',
            {
              onClick: () => {
                if (v === '⌫') return set({ entry: S.entry.slice(0, -1) });
                if (v === 'ABC') return;
                const entry = (S.entry + v).slice(0, 4);
                if (entry.length === 4) {
                  net.disconnect();
                  net.connect(entry);
                  return set({ entry, screen: 'radar' });
                }
                set({ entry });
              },
            },
            v
          )
        )
      ),
      plainBtn('Back', () => set({ screen: S.backTo, backTo: 'radar' })),
    ]),
  ];
}

// ---------------------------------------------------------------- render

const SCREENS = {
  identity,
  settings,
  radar,
  pick,
  confirm: confirm_,
  connecting,
  waiting,
  declined,
  incoming,
  awaited,
  sending: transfer,
  receiving: transfer,
  done,
  saved,
  blocked,
  offnet: offNet,
  ios: iosPermission,
  nowifi: noWifi,
  vanished,
  qr: qrBig,
  pairshow: pairShow,
  pairenter: pairEnter,
};

// Screens that take the peer's colour across the whole surface.
const COLORED = new Set([
  'pick',
  'confirm',
  'connecting',
  'waiting',
  'declined',
  'incoming',
  'awaited',
  'done',
  'saved',
]);

/* Everything the screens actually read. Rebuilding the DOM restarts every CSS
   animation in it, so a render that would change nothing must not happen — the
   idle bars and the heartbeat have to survive the socket connecting. */
const renderKey = () =>
  JSON.stringify([
    S.screen,
    S.status,
    S.me.name,
    S.me.color,
    S.me.kind,
    S.peers.map((p) => `${p.id}${p.name}${p.color}${p.kind}`),
    S.target?.id,
    S.target?.name,
    S.files.length,
    S.manifest?.length,
    S.results.length,
    Math.round(S.pct),
    Math.round(S.speed),
    S.index,
    S.fileName,
    S.hold,
    S.failed.length,
    S.showQueue,
    S.stalled,
    S.entry,
    S.notice,
    S.incomingFrom?.id,
    S.resumable,
    S.saved,
    S.error,
    S.code,
    S.backTo,
    S.settings.autoAccept,
  ]);

let lastScreen = null;
let lastKey = null;

function render() {
  const sig = renderKey();
  if (sig === lastKey) return;
  lastKey = sig;

  // The entry animation belongs to arriving at a screen, not to every state
  // update on it. Replaying it on each render is what made a page look like it
  // loaded twice: once on first paint, again the moment the socket connected
  // and pushed the peer list.
  const arrived = S.screen !== lastScreen;
  lastScreen = S.screen;

  const fn = SCREENS[S.screen] ?? radar;
  const colored = COLORED.has(S.screen) && S.target;
  const key = colored ? S.target.color : null;

  app.style.background = colored ? COLORS[key] : '#ffffff';
  app.style.color = colored ? ON[key] : '#101014';
  app.classList.toggle('on-color', !!colored);

  const nodes = fn().filter(Boolean);
  if (arrived) for (const n of nodes) n.classList?.add('enter');
  app.replaceChildren(...nodes);
}

// ---------------------------------------------------------------- boot

async function boot() {
  render();
  // Anything still in the private filesystem belongs to a transfer that never
  // finished; nothing here is meant to outlive the session that made it.
  pruneOpfs().catch(() => {});
  storageHeadroom().then((headroom) => headroom && set({ headroom }));
  // Persisted storage is far less likely to be evicted mid-transfer.
  navigator.storage?.persist?.().catch(() => {});
  if (!navigator.onLine) return set({ screen: 'nowifi' });

  // A QR carries ?room=CODE, so scanning one joins that room rather than
  // landing on a page that still needs the code typed in.
  const room = new URLSearchParams(location.search).get('room');
  if (room) S.code = room.toUpperCase();

  // Connect straight away. The permission probe can take its full 2.5s timeout
  // and the two are independent, so making discovery wait on it just delays
  // the peer list by seconds for everyone who granted permission already.
  net.connect(room ? room.toUpperCase() : null);

  // No LAN candidates at all on iOS means Local Network access was refused.
  const local = await Net.probeLocalNetwork();
  if (!local && /iPhone|iPad/.test(navigator.userAgent)) set({ screen: 'ios' });
}

window.addEventListener('offline', () => set({ screen: 'nowifi' }));
boot();
