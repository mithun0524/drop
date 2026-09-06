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
