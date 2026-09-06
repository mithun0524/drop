// Name clashes must resolve, and resolve to a stable state. The rule is that
// the higher peer id yields, which every device computes identically — so
// exactly one of a clashing pair renames, and they cannot swap into a new
// clash or both wait for the other.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

const probe = new URL('./__id.gen.js', import.meta.url);
const src = readFileSync(new URL('./identity.js', import.meta.url), 'utf8');
const start = src.indexOf('export const NAMES');
const end = src.indexOf("const KEY = 'drop.me';");
writeFileSync(probe, src.slice(start, end));
const { NAMES, freeName, identityKey } = await import(probe.href);
unlinkSync(probe);

const COLORS = Object.keys(NAMES);
const rnd = (a) => a[Math.floor(Math.random() * a.length)];

/** One room, every device applying the rule against what it can see. */
function settle(devices, maxRounds = 40) {
  for (let round = 0; round < maxRounds; round++) {
    let changed = false;
    for (const me of devices) {
      const clash = devices.find((p) => p.id !== me.id && identityKey(p) === identityKey(me));
      if (!clash || me.id < clash.id) continue; // the lower id keeps the name
      me.name = freeName(
        me.color,
        devices.filter((d) => d.id !== me.id).map(identityKey),
        me.name
      );
      changed = true;
    }
    if (!changed) return round;
  }
  return -1; // never settled
}

const unique = (ds) => new Set(ds.map(identityKey)).size === ds.length;

// Worst case: a whole room that picked the same colour and name.
{
  const ds = Array.from({ length: 12 }, (_, i) => ({
    id: String(i).padStart(2, '0'),
    color: 'red',
    name: 'Red Kite',
  }));
  const rounds = settle(ds);
  assert.notEqual(rounds, -1, 'an all-identical room must settle');
  assert.ok(unique(ds), 'every device ends up distinct');
  assert.equal(ds.find((d) => d.id === '00').name, 'Red Kite', 'the lowest id keeps its name');
}

// Random rooms, repeatedly — this is the case that actually happens.
for (const n of [2, 5, 15, 30]) {
  for (let trial = 0; trial < 200; trial++) {
    const ds = Array.from({ length: n }, (_, i) => {
      const color = rnd(COLORS);
      return { id: (i * 7919).toString(16).padStart(4, '0'), color, name: rnd(NAMES[color]) };
    });
    assert.notEqual(settle(ds), -1, `${n} devices failed to settle on trial ${trial}`);
    assert.ok(unique(ds), `${n} devices ended with a duplicate on trial ${trial}`);
  }
}

// More devices of one colour than there are names for it.
{
  const pool = NAMES.red.length;
  const ds = Array.from({ length: pool + 6 }, (_, i) => ({
    id: String(i).padStart(3, '0'),
    color: 'red',
    name: 'Red Kite',
  }));
  assert.notEqual(settle(ds, 200), -1, 'an exhausted pool must still settle');
  assert.ok(unique(ds), 'an exhausted pool must not hand out duplicates');
}

// A device never renames when nothing clashes.
{
  const ds = [
    { id: 'aa', color: 'red', name: 'Red Kite' },
    { id: 'bb', color: 'blue', name: 'Blue Jay' },
  ];
  assert.equal(settle(ds), 0, 'no clash means no churn');
  assert.equal(ds[1].name, 'Blue Jay');
}

console.log('clash: rooms always settle, and settle unique');
