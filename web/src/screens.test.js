// Every screen must render without throwing, in a phone-sized and a
// desktop-sized viewport. No browser here, so this is a structural smoke
// test: it catches missing state, bad references, and orphan screens —
// not visual regressions.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="app"></div>', {
  url: 'https://drop.test/',
  pretendToBeVisual: true,
});
const { window } = dom;

// Minimal stubs for the browser APIs ui.js touches at import time.
class FakeRTC {
  constructor() { this.connectionState = 'new'; }
  createDataChannel() { return { binaryType: '', addEventListener() {}, send() {}, readyState: 'open' }; }
  createOffer() { return Promise.resolve({ type: 'offer', sdp: '' }); }
  setLocalDescription() { return Promise.resolve(); }
  addEventListener() {}
  close() {}
}
window.RTCPeerConnection = FakeRTC;
window.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() {} };

// Node 20+ defines some of these as getter-only globals, so define rather than assign.
for (const k of ['window', 'document', 'navigator', 'location', 'localStorage', 'CustomEvent',
                 'EventTarget', 'Blob', 'URL', 'RTCPeerConnection', 'WebSocket']) {
  const v = k === 'window' ? window : window[k];
  if (v === undefined) continue;
  Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
}
// jsdom's Performance.now() recurses in this harness; the screens only need a clock.
Object.defineProperty(globalThis, 'performance', {
  value: { now: () => 1000 },
  configurable: true,
  writable: true,
});

// ui.js is a side-effecting module; load it as source so we can reach into it.
const src = readFileSync(new URL('./ui.js', import.meta.url), 'utf8');

// Screens the app can be in, and the state each needs to render.
const PEER = { id: 'p1', name: 'Yellow Wagtail', color: 'yellow', kind: 'tablet' };
const MANIFEST = [
  { name: 'DSC_0001.RAW', size: 68_400_000 },
  { name: 'a-rather-long-filename-that-should-be-clipped.mov', size: 240_000_000 },
];

const STATES = {
  identity: {},
  settings: {},
  radar: { peers: [] },                       // empty
  'radar-one': { screen: 'radar', peers: [PEER] },
  'radar-four': { screen: 'radar', peers: Array.from({ length: 4 }, (_, i) => ({ ...PEER, id: 'p' + i })) },
  'radar-many': { screen: 'radar', peers: Array.from({ length: 15 }, (_, i) => ({ ...PEER, id: 'p' + i })) },
  'radar-reconnecting': { screen: 'radar', peers: [PEER], status: 'reconnecting' },
  pick: { target: PEER },
  confirm: { target: PEER, files: MANIFEST },
  connecting: { target: PEER },
  waiting: { target: PEER, files: MANIFEST },
  declined: { target: PEER },
  incoming: { target: PEER, manifest: MANIFEST },
  sending: { target: PEER, files: MANIFEST, pct: 42, speed: 84, index: 0, fileName: 'x.raw' },
  'sending-queue': { screen: 'sending', target: PEER, files: MANIFEST, pct: 42, speed: 84, showQueue: true, failed: [1] },
  'sending-stalled': { screen: 'sending', target: PEER, files: MANIFEST, pct: 62, stalled: true },
  receiving: { target: PEER, manifest: MANIFEST, pct: 10, speed: 40, index: 1, fileName: 'y.mov' },
  done: { target: PEER, files: MANIFEST, pct: 100 },
  saved: { target: PEER, manifest: MANIFEST, results: [['a.raw', { size: 100 }]] },
  blocked: { target: PEER },
  ios: {},
  nowifi: {},
  vanished: { target: PEER },
  pairshow: {},
  pairenter: { entry: 'K4' },
};

// Rather than importing (which starts networking), evaluate the module with a
// hook that exposes render() and the state object.
const patched = src
  .replace(/^boot\(\);$/m, '')
  .replace(/^window\.addEventListener\('offline'.*$/m, '')
  + '\nexport const __test = { S, set, render, SCREENS, appUrl, qrSvg };\n';

// Must live beside ui.js so its relative imports still resolve.
const probe = new URL('./__probe.gen.js', import.meta.url);
writeFileSync(probe, patched);
const mod = await import(probe.href);
unlinkSync(probe);
const { S, set, SCREENS } = mod.__test;

let checked = 0;
for (const [label, patch] of Object.entries(STATES)) {
  const screen = patch.screen ?? label;
  Object.assign(S, {
    screen, peers: [], target: null, files: [], manifest: null, results: [],
    failed: [], showQueue: false, stalled: false, status: 'online', pct: 0, speed: 0, index: 0,
  }, patch, { screen });

  assert.ok(SCREENS[screen], `no screen registered for "${screen}"`);

  for (const width of [320, 390, 768]) {
    window.innerWidth = width;
    let nodes;
    assert.doesNotThrow(() => { nodes = SCREENS[screen](); }, `${label} @${width} threw`);
    const rendered = nodes.filter(Boolean);
    assert.ok(rendered.length > 0, `${label} @${width} rendered nothing`);
    const text = rendered.map((n) => n.textContent).join(' ');
    assert.ok(text.trim().length > 0, `${label} @${width} has no text`);
    assert.ok(!text.includes('undefined'), `${label} @${width} leaked "undefined": ${text.slice(0, 120)}`);
    assert.ok(!text.includes('NaN'), `${label} @${width} leaked "NaN": ${text.slice(0, 120)}`);
  }
  checked++;
}

// Every registered screen must be exercised above — no orphans.
for (const name of Object.keys(SCREENS)) {
  const covered = Object.entries(STATES).some(([l, p]) => (p.screen ?? l) === name);
  assert.ok(covered, `screen "${name}" is registered but never tested`);
}

console.log(`screens: ${checked} states rendered clean at 320/390/768px`);

// The footer once shipped with box-sizing:content-box alongside width:100% and
// horizontal padding, which pushed it 2*pad wider than the viewport and clipped
// its right edge. jsdom does no layout, so guard the cause rather than the
// symptom: the global reset is border-box and nothing should opt out.
{
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
  assert.ok(!/box-sizing:\s*content-box/.test(css), 'no rule may opt out of border-box');
  // Full-bleed elements rely on the scrollbar taking no gutter.
  assert.ok(/scrollbar-width:\s*none/.test(css), 'scrollable panes must hide their scrollbar');

  // A silhouette shrunk with transform keeps its full layout box, so it
  // overflows any small container it is dropped into (this shipped: the phone
  // rendered below the footer's 30px circle). They scale via --dev instead.
  // Silhouettes now live only on peer tiles — self-representation is initials.
  // ":active" transforms are press feedback and are meant to be paint-only.
  const devRules = css.match(/\.tiles\.many \.art\s*>\s*\*\s*\{[^}]*\}/g) ?? [];
  assert.ok(devRules.length >= 1, 'expected the silhouette container rule');
  assert.ok(/--dev:/.test(css), 'silhouettes must still size through --dev');
  for (const rule of devRules)
    assert.ok(!/transform:\s*scale/.test(rule), `silhouette must scale via --dev, not transform: ${rule.slice(0, 60)}`);

  // place-items centres each item in its own track; it does not centre the
  // track stack. Both round containers need place-content.
  for (const sel of ['.foot .dot', '.avatar']) {
    const rule = css.match(new RegExp(sel.replace(/[.]/g, '\\.') + '\\s*\\{[^}]*\\}'))?.[0] ?? '';
    assert.ok(/place-content:\s*center/.test(rule), `${sel} must use place-content, not place-items`);
  }

  // A flex item that can shrink below its content does not clip — it spills,
  // and later siblings draw through it. This shipped: the QR block collapsed
  // and the heading printed on top of its caption.
  const qrwrap = css.match(/\.qrwrap\s*\{[^}]*\}/)?.[0] ?? '';
  assert.ok(qrwrap, 'expected the .qrwrap rule');
  assert.ok(
    /flex:\s*0\s+0\s+auto/.test(qrwrap),
    '.qrwrap must not be allowed to shrink below its content'
  );
  assert.ok(!/min-height:\s*0/.test(qrwrap), '.qrwrap must not permit collapse');

  // The typeface is set in one place so it can be changed in one place.
  assert.ok(!/\bInter\b/.test(css), 'Inter must not survive anywhere in the styles');
  assert.ok(/--font:/.test(css), 'the family belongs in a single token');
  const hardcoded = css.match(/font(-family)?:[^;]*(Helvetica|Arial|system-ui)[^;]*/g) ?? [];
  assert.ok(hardcoded.length <= 1, 'only the --font token may name a concrete family');

  console.log('css: layout invariants hold');
}

// Initials back the avatar everywhere you appear, so they must survive the
// names the app actually generates plus the odd ones it doesn't.
{
  const probe = new URL('./__init.gen.js', import.meta.url);
  const uiSrc = readFileSync(new URL('./ui.js', import.meta.url), 'utf8');
  const fn = uiSrc.match(/const initials = [\s\S]*?\n};/)[0];
  writeFileSync(probe, fn + '\nexport { initials };');
  const { initials } = await import(probe.href);
  unlinkSync(probe);

  assert.equal(initials('Red Kite'), 'RK');
  assert.equal(initials('Yellow Wagtail'), 'YW');
  assert.equal(initials('Otter'), 'OT');       // single word
  assert.equal(initials('a'), 'A');            // one letter
  assert.equal(initials('  Blue   Marlin  '), 'BM'); // stray whitespace
  assert.equal(initials(''), '?');
  assert.equal(initials(), '?');

  // Every generated name must yield two readable letters.
  const names = [...uiSrc.matchAll(/'(?:Red|Blue|Green|Pink|Yellow) [A-Z][a-z]+'/g)].map((m) =>
    m[0].slice(1, -1)
  );
  for (const n of names) assert.match(initials(n), /^[A-Z]{2}$/, `bad initials for ${n}`);

  console.log('initials: all checks passed');
}

// Arriving at a screen animates; updating it must not. Replaying the entry
// animation on every state change made pages look like they loaded twice —
// once on first paint, again when the socket connected and pushed peers.
{
  const { S: st, set: setState, render } = mod.__test;
  const appEl = document.getElementById('app');

  // jsdom has no rAF scheduling we can await, so drive it manually.
  const frames = [];
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    value: (fn) => (frames.push(fn), frames.length),
    configurable: true,
    writable: true,
  });
  const flush = () => {
    const queued = frames.splice(0);
    for (const fn of queued) fn();
  };

  Object.assign(st, { screen: 'radar', peers: [], target: null, files: [] });
  render();
  const first = [...appEl.children].some((n) => n.classList.contains('enter'));
  assert.ok(first, 'arriving at a screen should animate');

  // Same screen, new data — this is the peer list landing after connect.
  setState({ peers: [{ id: 'p1', name: 'Blue Jay', color: 'blue', kind: 'phone' }] });
  flush();
  const again = [...appEl.children].some((n) => n.classList.contains('enter'));
  assert.ok(!again, 'updating the current screen must not replay the entry animation');

  // A real navigation animates again.
  setState({ screen: 'settings' });
  flush();
  assert.ok(
    [...appEl.children].some((n) => n.classList.contains('enter')),
    'changing screens should animate'
  );

  // Many updates in one frame must produce exactly one render.
  setState({ screen: 'radar' });
  flush();
  for (let i = 0; i < 50; i++) setState({ pct: i });
  assert.equal(frames.length, 1, '50 updates must coalesce into a single frame');
  flush();

  console.log('render: animates on arrival only, coalesces bursts');
}

// Rebuilding the DOM restarts every CSS animation inside it. The socket
// connecting a couple of seconds after load used to do exactly that, which
// cut the idle bars off mid-cycle and started them again.
{
  const { S: st, set: setState, render } = mod.__test;
  const appEl = document.getElementById('app');
  const frames = [];
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    value: (fn) => (frames.push(fn), frames.length),
    configurable: true, writable: true,
  });
  const flush = () => { for (const fn of frames.splice(0)) fn(); };

  Object.assign(st, { screen: 'settings', peers: [], target: null });
  render();
  Object.assign(st, { screen: 'radar' });
  render();
  const before = appEl.firstElementChild;

  // What actually happens on connect: status re-asserted, empty peer list sent.
  setState({ status: 'online' });
  flush();
  setState({ peers: [] });
  flush();
  assert.equal(appEl.firstElementChild, before, 'a no-op update must not rebuild the DOM');

  // A real change still renders.
  setState({ peers: [{ id: 'p1', name: 'Blue Jay', color: 'blue', kind: 'phone' }] });
  flush();
  assert.notEqual(appEl.firstElementChild, before, 'a real change must render');

  console.log('render: identical state does not rebuild the DOM');
}

// The pairing QR is only useful if scanning it actually joins the room, so the
// link it encodes and the parsing on the other end have to agree.
{
  const { appUrl, qrSvg } = mod.__test;

  assert.equal(appUrl(), 'https://drop.test/', 'plain link is just the page');
  assert.equal(appUrl('K4RM'), 'https://drop.test/?room=K4RM');

  // What boot() does with a scanned link.
  const roomFrom = (url) => new URLSearchParams(new URL(url).search).get('room')?.toUpperCase();
  assert.equal(roomFrom(appUrl('K4RM')), 'K4RM', 'the code survives the round trip');
  assert.equal(roomFrom(appUrl()), undefined, 'a plain link joins no room');
  assert.equal(roomFrom('https://drop.test/?room=k4rm'), 'K4RM', 'codes are case-insensitive');

  // The QR renders real modules, not an empty path.
  const svg = qrSvg(appUrl('K4RM'), 'test');
  const d = svg.querySelector('path').getAttribute('d');
  assert.ok(d.length > 200, 'QR path should contain many modules');
  const box = svg.getAttribute('viewBox').split(' ').map(Number);
  assert.ok(box[2] > 8 && box[2] === box[3], 'QR must be square with a quiet zone');
  // A longer payload needs a bigger symbol — proves the encoder is really running.
  const big = qrSvg('x'.repeat(300), 'test');
  assert.ok(
    Number(big.getAttribute('viewBox').split(' ')[2]) > box[2],
    'more data must produce a larger symbol'
  );

  console.log('qr: encodes the join link and parses back');
}

// A solid rounded rectangle reads as a phone only while it is tiny. The
// details are punched with a mask so they show whatever is behind — these
// silhouettes sit on a coloured card, a black footer and a coloured avatar.
{
  const probe = new URL('./__sil.gen.js', import.meta.url);
  const uiSrc = readFileSync(new URL('./ui.js', import.meta.url), 'utf8');
  const block = uiSrc.match(/const SVG_NS = [\s\S]*?\n}\n/)[0];
  writeFileSync(probe, block + '\nexport { silhouette };');
  const { silhouette } = await import(probe.href);
  unlinkSync(probe);

  for (const kind of ['phone', 'tablet', 'laptop']) {
    const svg = silhouette(kind);
    assert.equal(svg.tagName.toLowerCase(), 'svg', `${kind} should be an svg`);
    assert.ok(svg.classList.contains('dev-' + kind), `${kind} keeps its sizing class`);

    // Detail cut-outs are what stop it being a featureless blob.
    const cuts = [...svg.querySelectorAll('mask rect')].filter(
      (r) => r.getAttribute('fill') === '#000'
    );
    assert.ok(cuts.length >= 1, `${kind} needs punched detail, got ${cuts.length}`);

    // The body must inherit colour, or it cannot sit on both a red card and a
    // black footer.
    const body = svg.querySelector('svg > rect');
    assert.equal(body.getAttribute('fill'), 'currentColor', `${kind} body must inherit colour`);

    // Every cut must fall inside the body, or it punches nothing.
    const [, , vw, vh] = svg.getAttribute('viewBox').split(' ').map(Number);
    for (const c of cuts) {
      const x = +c.getAttribute('x'), y = +c.getAttribute('y');
      const w = +c.getAttribute('width'), h = +c.getAttribute('height');
      assert.ok(x >= 0 && y >= 0 && x + w <= vw && y + h <= vh, `${kind} cut escapes the viewBox`);
    }
  }

  // Masks are referenced by id, so two silhouettes on one page must not collide.
  const a = silhouette('phone').querySelector('mask').getAttribute('id');
  const b = silhouette('phone').querySelector('mask').getAttribute('id');
  assert.notEqual(a, b, 'mask ids must be unique per instance');

  // An unknown kind must still draw something rather than throw.
  assert.ok(silhouette('watch').querySelector('rect'), 'unknown kinds fall back');

  console.log('silhouettes: real device shapes, unique masks');
}
