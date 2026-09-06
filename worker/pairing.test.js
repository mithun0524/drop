// A pairing code must be a POINTER to a room, not a room of its own. The whole
// point is that publishing one does not cost you automatic discovery, so a
// device that uses a code has to land where the publisher already is.
const U = process.env.DROP_WS || 'ws://localhost:8788/ws';

const open = (name, code) =>
  new Promise((res, rej) => {
    const ws = new WebSocket(U + (code ? '?code=' + code : ''));
    const got = [];
    const t = setTimeout(() => rej(new Error('timeout opening ' + name)), 5000);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      got.push(m);
      if (m.t === 'welcome') {
        ws.id = m.id;
        ws.send(JSON.stringify({ t: 'hello', name, color: 'blue', kind: 'phone' }));
        clearTimeout(t);
        res({ ws, got, name });
      }
    };
    ws.onerror = () => { clearTimeout(t); rej(new Error('socket error ' + name)); };
  });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sawPeer = (c, n) =>
  c.got.some((m) => m.t === 'join' && m.peer.name === n) ||
  c.got.some((m) => m.t === 'peers' && m.peers.some((p) => p.name === n));

let failures = 0;
const check = (label, ok) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + label);
  if (!ok) failures++;
};

// Everyone on one IP shares a room with no code at all.
const a = await open('Alpha');
await wait(300);
const b = await open('Bravo');
await wait(600);
check('same network groups automatically', sawPeer(a, 'Bravo') && sawPeer(b, 'Alpha'));

// Alpha publishes a code for the room it is ALREADY in.
a.ws.send(JSON.stringify({ t: 'publish', code: 'K4RM' }));
await wait(600);

// Someone arriving with that code joins Alpha's room, not a room called K4RM.
const c = await open('Charlie', 'K4RM');
await wait(700);
check('a code lands you in the publisher\'s room', sawPeer(c, 'Alpha') && sawPeer(c, 'Bravo'));
check('the publisher sees the arrival', sawPeer(a, 'Charlie'));

// Publishing did not move Alpha or Bravo anywhere.
const d = await open('Delta');
await wait(700);
check('publishing a code does not cost automatic discovery', sawPeer(d, 'Alpha') && sawPeer(a, 'Delta'));

// An unknown code must not strand you alone in a room named after it.
const e = await open('Echo', 'ZZZZ');
await wait(700);
check('an unknown code falls back to your own room', sawPeer(e, 'Alpha'));

// Peers carry the network they arrived from, so the client can tell someone
// they will never connect instead of letting them wait for a timeout.
const netOf = (c) => c.got.find((m) => m.t === 'welcome')?.net;
check('the server tells you your own network', !!netOf(a));
const seen = c.got.find((m) => m.t === 'peers')?.peers ?? [];
check('peers carry a network fingerprint', seen.length > 0 && seen.every((p) => !!p.net));
check('same-network peers report the same fingerprint', seen.every((p) => p.net === netOf(c)));

// The "choosing files for you" hint travels before any WebRTC connection
// exists, so it has to relay over the signalling socket like SDP does.
const before = b.got.length;
a.ws.send(JSON.stringify({ t: 'signal', to: b.ws.id, data: { hint: 'picking' } }));
await wait(600);
const hint = b.got.slice(before).find((m) => m.t === 'signal' && m.data?.hint === 'picking');
check('a hint relays before any connection exists', !!hint && hint.from === a.ws.id);

const beforeD = d.got.length;
await wait(300);
check('a hint reaches only its target', !d.got.slice(beforeD).some((m) => m.data?.hint));

for (const x of [a, b, c, d, e]) x.ws.close();
await wait(200);
console.log(failures ? `\npairing: ${failures} FAILED` : '\npairing: all checks passed');
process.exit(failures ? 1 : 0);
