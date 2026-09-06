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
  + '\nexport const __test = { S, set, render, SCREENS };\n';

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
