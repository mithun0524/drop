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

export const NAMES = {
  red: ['Red Squirrel', 'Red Deer', 'Red Snapper', 'Red Kite', 'Red Panda', 'Red Fox'],
  blue: ['Blue Marlin', 'Blue Crane', 'Blue Tang', 'Blue Heron', 'Blue Jay', 'Blue Whale'],
  green: ['Green Finch', 'Green Gecko', 'Green Turtle', 'Green Teal', 'Green Iora', 'Green Anole'],
  pink: ['Pink Flamingo', 'Pink Hare', 'Pink Shrimp', 'Pink Galah', 'Pink Robin', 'Pink Salmon'],
  yellow: [
    'Yellow Oriole',
    'Yellow Tang',
    'Yellow Warbler',
    'Yellow Wagtail',
    'Yellow Weaver',
    'Yellow Bunting',
  ],
};

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
