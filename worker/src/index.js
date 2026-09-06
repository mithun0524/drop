// Signaling only. Files never pass through here — this brokers the handshake
// and then goes idle for the rest of the transfer.
//
// Room membership is derived from the caller's public IP: everyone behind the
// same NAT lands in the same Durable Object and sees each other, with no code
// to type.
//
// A pairing code is a POINTER to a room, never a room of its own. Someone who
// cannot be found automatically publishes a code for the room they are already
// in; scanning or typing it drops you into that room. Codes that named their
// own room forced both devices to abandon automatic discovery to use one,
// which is why the code could only ever be a fallback — as a pointer it is
// simply a second way to arrive at the same place.

const ROOM_SALT = 'drop-v1';
const CODE_TTL = 10 * 60 * 1000; // a pairing code is for right now, not forever

/**
 * Reduce a client address to the thing its neighbours share.
 *
 * IPv4 is behind NAT, so everyone on the LAN presents the same address and it
 * can be used whole. IPv6 has no NAT: every device gets its own global address
 * and only the /64 prefix — the subnet the network is delegated — is common to
 * the LAN. Hashing a full IPv6 address puts every device in a room of one.
 */
export function networkKey(ip) {
  if (!ip) return 'unknown';
  const addr = ip.trim().toLowerCase().split('%')[0]; // drop any zone id

  if (!addr.includes(':')) return addr; // IPv4

  // IPv4-mapped IPv6 (::ffff:1.2.3.4) is really IPv4 and is still NATed.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped) return mapped[1];

  // Expand "::" so the first four hextets can be taken positionally.
  const [head, tail] = addr.split('::');
  const h = head ? head.split(':').filter(Boolean) : [];
  const t = tail !== undefined ? tail.split(':').filter(Boolean) : [];
  const full =
    tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];

  return (
    full
      .slice(0, 4)
      .map((x) => (parseInt(x, 16) || 0).toString(16))
      .join(':') + '::/64'
  );
}

async function roomFromIp(ip) {
  const bytes = new TextEncoder().encode(ROOM_SALT + '|' + networkKey(ip));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest).slice(0, 12)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const directory = (env) => env.ROOMS.get(env.ROOMS.idFromName('directory'));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname !== '/ws') {
      return new Response('drop signaling', { status: 200 });
    }
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    const myRoom = 'ip:' + (await roomFromIp(request.headers.get('CF-Connecting-IP') || 'unknown'));

    // A code resolves to the room its owner is in. If it has expired or never
    // existed, fall back to this caller's own room rather than stranding them
    // alone in a room named after a dead code.
    const code = url.searchParams.get('code');
    let name = myRoom;
    if (code) {
      const res = await directory(env).fetch(
        new Request('https://d/resolve?code=' + encodeURIComponent(code.toUpperCase()))
      );
      const { room } = await res.json();
      name = room || myRoom;
    }

    // A Durable Object cannot read the name it was addressed by, and it needs
    // it to publish codes that point back here.
    const forwarded = new Request(new URL('/ws?room=' + encodeURIComponent(name), url), request);
    return env.ROOMS.get(env.ROOMS.idFromName(name)).fetch(forwarded);
  },
};

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.peers = new Map(); // id -> { ws, info }
    this.room = null; // the name this object was addressed by, passed in by the worker
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Directory duty: the same class, addressed by a fixed name, holds the
    // code -> room map. One object rather than a second binding to configure.
    if (url.pathname === '/publish') {
      const code = url.searchParams.get('code');
      await this.state.storage.put('c:' + code, {
        room: url.searchParams.get('room'),
        at: Date.now(),
      });
      await this.prune();
      return Response.json({ ok: true });
    }
    if (url.pathname === '/resolve') {
      const hit = await this.state.storage.get('c:' + url.searchParams.get('code'));
      const live = hit && Date.now() - hit.at < CODE_TTL;
      return Response.json({ room: live ? hit.room : null });
    }

    this.room = url.searchParams.get('room') ?? this.room;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.accept(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Codes are the only thing here that grows, so expired ones go on write. */
  async prune() {
    const cutoff = Date.now() - CODE_TTL;
    const all = await this.state.storage.list({ prefix: 'c:' });
    const dead = [...all].filter(([, v]) => v.at < cutoff).map(([k]) => k);
    if (dead.length) await this.state.storage.delete(dead);
  }

  accept(ws) {
    ws.accept();
    const id = crypto.randomUUID().slice(0, 8);
    this.peers.set(id, { ws, info: null });

    ws.send(JSON.stringify({ t: 'welcome', id }));

    ws.addEventListener('message', (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (m.t === 'hello') {
        const info = { id, name: String(m.name || '').slice(0, 40), color: m.color, kind: m.kind };
        this.peers.get(id).info = info;
        // Send the newcomer everyone already here, then announce them to the rest.
        ws.send(
          JSON.stringify({
            t: 'peers',
            peers: [...this.peers.values()]
              .filter((p) => p.info && p.info.id !== id)
              .map((p) => p.info),
          })
        );
        this.broadcast({ t: 'join', peer: info }, id);
        return;
      }

      // Publishing a code points it at THIS room, so whoever uses it arrives
      // where the publisher already is.
      if (m.t === 'publish' && m.code && this.room) {
        this.env.ROOMS.get(this.env.ROOMS.idFromName('directory')).fetch(
          new Request(
            'https://d/publish?code=' +
              encodeURIComponent(String(m.code).toUpperCase()) +
              '&room=' +
              encodeURIComponent(this.room)
          )
        );
        return;
      }

      // Relay an SDP offer/answer or an ICE candidate to exactly one peer.
      if (m.t === 'signal' && m.to) {
        const dest = this.peers.get(m.to);
        if (dest) dest.ws.send(JSON.stringify({ t: 'signal', from: id, data: m.data }));
      }
    });

    const drop = () => {
      this.peers.delete(id);
      this.broadcast({ t: 'leave', id });
    };
    ws.addEventListener('close', drop);
    ws.addEventListener('error', drop);
  }

  broadcast(msg, except) {
    const s = JSON.stringify(msg);
    for (const [pid, p] of this.peers) {
      if (pid === except) continue;
      try {
        p.ws.send(s);
      } catch {
        this.peers.delete(pid);
      }
    }
  }
}
