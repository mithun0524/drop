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
} from './identity.js';
import { Net } from './net.js';
import { sendFiles, createReceiver, describe, memorySink, formatSize } from './transfer.js';

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
};

const set = (patch) => {
  Object.assign(S, patch);
  render();
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

const silhouette = (kind) =>
  kind === 'laptop'
    ? el('div', { class: 'dev-laptop' }, [el('i'), el('b')])
    : el('div', { class: kind === 'tablet' ? 'dev-tablet' : 'dev-phone' });

const kindLabel = (k) => (k === 'phone' ? 'Phone' : k === 'laptop' ? 'Laptop' : 'Tablet');

const eyebrow = (t) => el('div', { class: 'eyebrow' }, t);

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
    [silhouette(S.me.kind)]
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

net.addEventListener('peers', (e) => set({ peers: e.detail }));
net.addEventListener('status', (e) => set({ status: e.detail }));

net.addEventListener('blocked', () => {
  if (S.screen === 'connecting' || S.screen === 'waiting') set({ screen: 'blocked' });
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
    rx?.abort();
    set({ screen: 'vanished', stalled: false });
  } else if (S.screen === 'waiting' || S.screen === 'confirm') {
    set({ screen: 'radar', target: null });
  }
});

let rx = null; // active receiver
let abort = null; // AbortController for an active send

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
      rx = buildReceiver(net.channel(from));
      await rx.handle(data);
      set({ screen: 'incoming', target: peer, manifest: m.files, hold: 0, failed: [] });
      // A device you've accepted from before skips the hold, if you asked for it.
      if (S.settings.autoAccept && isTrusted(peer)) accept();
      return;
    }
    if (m.t === 'accept') return startSending(from);
    if (m.t === 'decline') return set({ screen: 'declined' });
    if (m.t === 'cancel') {
      rx?.abort();
      return set({ screen: 'radar', target: null });
    }
  }
  if (rx) await rx.handle(data);
}

function buildReceiver(ch) {
  const results = [];
  return createReceiver({
    // ponytail: buffers each file in memory, so a single file is capped around
    // 1-2GB. Streaming to disk needs showSaveFilePicker(), which browsers only
    // allow from a user gesture — so it has to be requested on the "hold to
    // accept" tap, before the first byte arrives. Do that when someone hits
    // the ceiling; until then this is one sink instead of two code paths.
    openSink: async () => memorySink(),
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
    onFile: (meta, i, blob) => {
      if (blob) results.push([meta.name, blob]);
    },
    onFailed: (meta, i) => set({ failed: [...S.failed, i] }),
    onDone: () => set({ screen: 'saved', results, pct: 100, showQueue: false, stalled: false }),
    onError: (err) => set({ screen: 'vanished', error: err.message }),
  });
}

async function pickTarget(peer) {
  set({ target: peer, screen: 'pick' });
}

async function offerFiles(peer, files) {
  set({ target: peer, files, screen: 'connecting', error: null });
  try {
    const ch = await net.open(peer.id);
    ch.send(JSON.stringify({ t: 'offer', files: describe(files) }));
    set({ screen: 'waiting' });
  } catch {
    set({ screen: 'blocked' });
  }
}

async function startSending(id) {
  const ch = net.channel(id);
  abort = new AbortController();
  set({ screen: 'sending', pct: 0, startedAt: performance.now(), bytes: 0, failed: [] });
  try {
    await sendFiles(ch, S.files, {
      signal: abort.signal,
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

function accept() {
  trust(S.target); // accepting once is what makes auto-accept possible later
  net.channel(S.target.id)?.send(JSON.stringify({ t: 'accept' }));
  set({ screen: 'receiving', pct: 0, startedAt: performance.now(), bytes: 0 });
}

function decline() {
  net.channel(S.target.id)?.send(JSON.stringify({ t: 'decline' }));
  rx?.abort();
  set({ screen: 'radar', target: null });
}

function cancel() {
  abort?.abort();
  rx?.abort();
  net.channel(S.target?.id)?.send(JSON.stringify({ t: 'cancel' }));
  set({ screen: 'radar', target: null, files: [] });
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
      // No label up here: with nothing on screen, a lone "NEARBY" just orphans
      // itself above 500px of white. The gear is the only chrome that earns it.
      el('div', { class: 'topbar solo' }, [gearBtn()]),
      el('div', { class: 'screen to-edge', style: { justifyContent: 'flex-end' } }, [
        head('Nobody else<br>is here yet.'),
        el('p', { class: 'body', style: { color: 'var(--dim)' } }, [
          'Open this page on the other device. It takes over one of these blocks the moment it appears.',
        ]),
        el(
          'button',
          { class: 'linkline', onClick: () => set({ screen: 'pairshow', backTo: 'radar' }) },
          'Not showing up? Pair by hand'
        ),
        el(
          'div',
          { class: 'swatches' },
          KEYS.map((k) => el('div', { style: { background: COLORS[k] } }))
        ),
      ]),
      footer(),
    ];
  }

  return [
    S.status === 'reconnecting' && el('div', { class: 'banner' }, 'Lost the network — reconnecting'),
    el('div', { class: 'topbar' }, [
      eyebrow(
        S.files.length
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
            class: 'tile',
            style: { background: COLORS[p.color] ?? COLORS.blue, color: ON[p.color] ?? '#fff' },
            onClick: () => (S.files.length ? offerFiles(p, S.files) : pickTarget(p)),
          },
          [
            el('div', { class: 'art' }, [silhouette(p.kind)]),
            el('div', {}, [
              el('div', { class: 'nm' }, p.name),
              el('div', { class: 'kind' }, kindLabel(p.kind) + ' · tap to send'),
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
        // The same silhouette the tiles use, so your own device is drawn the
        // way the other person sees it — a laptop reads as a laptop.
        [silhouette(S.me.kind)]
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
      el('div', { class: 'center' }, [
        el('p', { class: 'body' }, [
          "Your device's own picker opens next — Drop never browses your storage itself.",
        ]),
      ]),
      blackBtn('Choose files', () => input.click()),
      plainBtn('Cancel', () => set({ screen: 'radar', target: null })),
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

function incoming() {
  const total = S.manifest.reduce((a, f) => a + f.size, 0);
  const n = S.manifest.length;

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
          el('span', {}, S.hold >= 100 ? 'Accepting…' : S.hold > 0 ? 'Keep holding…' : 'Hold to accept'),
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
                font: '600 clamp(14px, 4.1vw, 16px)/1 Inter, sans-serif',
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
      el(
        'div',
        { class: 'scroll', style: { marginTop: '20px' } },
        S.files.map((f) =>
          el('div', { class: 'filerow' }, [
            el('span', {}, f.name),
            el('span', {}, formatSize(f.size)),
          ])
        )
      ),
      blackBtn('Send', () => offerFiles(S.target, S.files)),
      plainBtn('Cancel', () => set({ screen: 'radar', files: [], target: null })),
    ]),
  ];
}

function settings() {
  const trusted = loadTrusted();
  const back = () => set({ screen: S.backTo === 'settings' ? 'radar' : S.backTo });
  return [
    el('div', { class: 'screen' }, [
      el('div', { class: 'topbar flush' }, [eyebrow('Settings'), closeBtn(back)]),

      el(
        'button',
        {
          class: 'mepreview tappable',
          style: { background: COLORS[S.me.color], color: ON[S.me.color], marginTop: '10px' },
          onClick: () => set({ screen: 'identity', backTo: 'settings' }),
        },
        [
          el('div', { class: 'art' }, [silhouette(S.me.kind)]),
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
          ? `From ${trusted.length} device${trusted.length > 1 ? 's' : ''} you've accepted before`
          : "Applies once you've accepted from a device at least once",
        S.settings.autoAccept,
        () => {
          const next = { ...S.settings, autoAccept: !S.settings.autoAccept };
          saveSettings(next);
          set({ settings: next });
        }
      ),
      trusted.length > 0 &&
        row('Forget those devices', trusted.join(' · ').replace(/[a-z]+\|/g, ''), () => {
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
  const total = S.manifest.reduce((a, f) => a + f.size, 0);
  const secs = Math.max(0.1, (performance.now() - S.startedAt) / 1000);
  return [
    el('div', { class: 'screen' }, [
      eyebrow('From ' + S.target.name),
      el('div', { class: 'center' }, [
        el('div', { class: 'bigcount' }, S.manifest.length),
        head(`file${S.manifest.length > 1 ? 's' : ''} ready<br>to save.`, 'sm'),
        el(
          'div',
          { class: 'meta', style: { opacity: 0.8 } },
          `${formatSize(total)} · ${(total / 1e6 / secs).toFixed(0)} MB/s average`
        ),
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
      blackBtn(S.results.length > 1 ? 'Save all' : 'Save', saveAll),
      plainBtn('Done', () => set({ screen: 'radar', target: null, results: [] })),
    ]),
  ];
}

function saveAll() {
  // A click handler is the only place a browser will let us start downloads,
  // so they all go out from this one gesture.
  for (const [name, blob] of S.results) {
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
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
  return [
    el('div', { class: 'screen' }, [
      el('div', { class: 'center' }, [
        head(`${S.target?.name ?? 'They'}<br>left the network.`, 'sm'),
        el('p', { class: 'body' }, [
          S.error ?? 'The transfer stopped. Incomplete files were discarded — nothing half-saved.',
        ]),
      ]),
      blackBtn('Back to devices', () => set({ screen: 'radar', target: null, files: [] })),
    ]),
  ];
}

function pairShow() {
  const c = COLORS[S.me.color];
  const code = (S.code ??= Math.random().toString(36).slice(2, 6).toUpperCase());
  return [
    el('div', { class: 'screen' }, [
      eyebrow('Pair by hand'),
      head('Type this code<br>on the other device.', 'sm'),
      el(
        'div',
        { class: 'code' },
        code
          .split('')
          .map((v) => el('div', { style: { background: c, color: ON[S.me.color] } }, v))
      ),
      el('p', { class: 'body sm', style: { color: 'var(--dim)' } }, [
        'Use this when the two devices are on the same Wi-Fi but can’t see each other automatically.',
      ]),
      el('div', { class: 'spring' }),
      blackBtn('Join this room', () => {
        net.disconnect();
        net.connect(code);
        set({ screen: 'radar', backTo: 'radar' });
      }),
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
  sending: transfer,
  receiving: transfer,
  done,
  saved,
  blocked,
  ios: iosPermission,
  nowifi: noWifi,
  vanished,
  pairshow: pairShow,
  pairenter: pairEnter,
};

// Screens that take the peer's colour across the whole surface.
const COLORED = new Set(['pick', 'connecting', 'waiting', 'declined', 'incoming', 'done', 'saved']);

function render() {
  const fn = SCREENS[S.screen] ?? radar;
  const colored = COLORED.has(S.screen) && S.target;
  const key = colored ? S.target.color : null;

  app.style.background = colored ? COLORS[key] : '#ffffff';
  app.style.color = colored ? ON[key] : '#101014';
  app.classList.toggle('on-color', !!colored);

  app.replaceChildren(...fn().filter(Boolean));
}

// ---------------------------------------------------------------- boot

async function boot() {
  render();
  if (!navigator.onLine) return set({ screen: 'nowifi' });

  // No LAN candidates at all on iOS means Local Network access was refused.
  const local = await Net.probeLocalNetwork();
  if (!local && /iPhone|iPad/.test(navigator.userAgent)) return set({ screen: 'ios' });

  net.connect();
}

window.addEventListener('offline', () => set({ screen: 'nowifi' }));
boot();
