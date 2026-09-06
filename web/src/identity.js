// Who you are on the network: a colour and an animal name. No account, no
// server record — it lives in localStorage and is broadcast to the room.

export const COLORS = {
  red: '#e03131',
  blue: '#1d4ed8',
  green: '#0f8a4d',
  pink: '#e0518c',
  yellow: '#f2b705',
};

// Ink that stays readable on each colour. Yellow is the odd one out.
export const ON = {
  red: '#fff',
  blue: '#fff',
  green: '#fff',
  pink: '#fff',
  yellow: '#101014',
};

export const KEYS = Object.keys(COLORS);

// Real animals, two syllables where possible, and pronounceable out loud —
// the product's core move is saying a name across a room. Sixteen per colour
// so a room can be made collision-free by renaming rather than by luck.
export const NAMES = {
  red: [
    'Red Kite', 'Red Fox', 'Red Deer', 'Red Panda', 'Red Squirrel', 'Red Snapper',
    'Red Crab', 'Red Robin', 'Red Setter', 'Red Grouse', 'Red Macaw', 'Red Lynx',
    'Red Salamander', 'Red Admiral', 'Red Drake', 'Red Ibis',
  ],
  blue: [
    'Blue Jay', 'Blue Heron', 'Blue Whale', 'Blue Marlin', 'Blue Crane', 'Blue Tang',
    'Blue Crab', 'Blue Shark', 'Blue Morpho', 'Blue Magpie', 'Blue Roller', 'Blue Tit',
    'Blue Wren', 'Blue Bass', 'Blue Damsel', 'Blue Swallow',
  ],
  green: [
    'Green Finch', 'Green Gecko', 'Green Turtle', 'Green Teal', 'Green Iora', 'Green Anole',
    'Green Heron', 'Green Mamba', 'Green Iguana', 'Green Bee', 'Green Magpie', 'Green Frog',
    'Green Lizard', 'Green Parrot', 'Green Crab', 'Green Moth',
  ],
  pink: [
    'Pink Flamingo', 'Pink Galah', 'Pink Robin', 'Pink Salmon', 'Pink Hare', 'Pink Shrimp',
    'Pink Cockatoo', 'Pink Dolphin', 'Pink Starfish', 'Pink Iguana', 'Pink Snapper',
    'Pink Fairy', 'Pink Katydid', 'Pink Sea Star', 'Pink Grasshopper', 'Pink Orchid Mantis',
  ],
  yellow: [
    'Yellow Oriole', 'Yellow Warbler', 'Yellow Wagtail', 'Yellow Tang', 'Yellow Weaver',
    'Yellow Bunting', 'Yellow Finch', 'Yellow Canary', 'Yellow Mongoose', 'Yellow Baboon',
    'Yellow Seahorse', 'Yellow Robin', 'Yellow Hornbill', 'Yellow Boxfish', 'Yellow Crab',
    'Yellow Sponge',
  ],
};

/**
 * A free name for this colour, given the ones already in use.
 *
 * Two devices called Red Kite makes the room unreadable, and a bigger pool only
 * makes that less likely, never impossible — fifteen devices across thirty
 * combinations collide about ninety-seven times in a hundred. So the room is
 * made unique rather than hoped to be.
 */
export function freeName(color, taken, current) {
  const used = new Set(taken);
  const pool = NAMES[color] ?? [];
  const free = pool.filter((n) => n !== current && !used.has(color + '|' + n));
  if (free.length) return free[Math.floor(Math.random() * free.length)];
  // More devices of one colour than names: fall back to a numbered suffix
  // rather than handing out a duplicate.
  for (let i = 2; ; i++) {
    const n = `${pool[0] ?? 'Device'} ${i}`;
    if (!used.has(color + '|' + n)) return n;
  }
}

export const identityKey = (p) => `${p.color}|${p.name}`;

const KEY = 'drop.me';

export function deviceKind() {
  const ua = navigator.userAgent;
  if (/iPad|Tablet/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1))
    return 'tablet';
  if (/Mobi|Android|iPhone/.test(ua)) return 'phone';
  return 'laptop';
}

const pick = (a) => a[Math.floor(Math.random() * a.length)];

export function loadMe() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved?.color && saved?.name) return { ...saved, kind: deviceKind(), fresh: false };
  } catch {
    /* first run, private window, or cleared storage — fall through to a new identity */
  }
  const color = pick(KEYS);
  return { color, name: pick(NAMES[color]), kind: deviceKind(), fresh: true };
}

export function saveMe(me) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ color: me.color, name: me.name }));
  } catch {
    /* storage blocked — identity just won't persist across reloads */
  }
}

// ---- settings -------------------------------------------------------------
// Everything here is per-device and lives only in this browser. Nothing is
// sent anywhere, which is the point of the product.

const SETTINGS_KEY = 'drop.settings';

const DEFAULTS = {
  autoAccept: false, // skip hold-to-accept for devices already accepted this session
};

const read = (key, fallback) => {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
};

const write = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage blocked — the setting just won't survive a reload */
  }
};

export const loadSettings = () => ({ ...DEFAULTS, ...read(SETTINGS_KEY, {}) });
export const saveSettings = (s) => write(SETTINGS_KEY, s);

// Trust is per-session and keyed on the server-assigned peer id, never on the
// colour and name — those are chosen by the person you are trusting. Keying on
// them meant a stranger could pick your laptop's colour and name and have
// their files accepted without a prompt. A peer id is issued by the server for
// one connection, so it cannot be claimed, and trust dies with the tab.
const trusted = new Set();

export const loadTrusted = () => [...trusted];
export const isTrusted = (peer) => !!peer && trusted.has(peer.id);
export const trust = (peer) => peer && trusted.add(peer.id);
export const forgetTrusted = () => trusted.clear();

export function resetIdentity() {
  forgetTrusted();
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}
