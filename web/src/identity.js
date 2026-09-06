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
const TRUSTED_KEY = 'drop.trusted';

const DEFAULTS = {
  autoAccept: false, // skip hold-to-accept for devices you've accepted before
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

// A peer id is regenerated every connection, so trust is keyed on the thing a
// person actually recognises: the colour and name they picked.
const peerKey = (peer) => `${peer.color}|${peer.name}`;

export const loadTrusted = () => read(TRUSTED_KEY, []);
export const isTrusted = (peer) => peer && loadTrusted().includes(peerKey(peer));

export function trust(peer) {
  if (!peer) return;
  const list = loadTrusted();
  const k = peerKey(peer);
  if (!list.includes(k)) write(TRUSTED_KEY, [...list, k]);
}

export function forgetTrusted() {
  write(TRUSTED_KEY, []);
}

export function resetIdentity() {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(TRUSTED_KEY);
  } catch {
    /* nothing to clear */
  }
}
