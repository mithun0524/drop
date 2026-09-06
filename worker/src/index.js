// Signaling only. Files never pass through here — this brokers the handshake
// and then goes idle for the rest of the transfer.
//
// Room membership is derived from the caller's public IP: everyone behind the
// same NAT lands in the same Durable Object and sees each other, with no code
// to type. A manual ?code= joins a named room instead, for the cases where IP
// grouping fails (dual-WAN, CGNAT, guest VLANs).

const ROOM_SALT = 'drop-v1';

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname !== '/ws') {
      return new Response('drop signaling', { status: 200 });
    }
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    const code = url.searchParams.get('code');
    const name = code
      ? 'code:' + code.toUpperCase()
      : 'ip:' + (await roomFromIp(request.headers.get('CF-Connecting-IP') || 'unknown'));

    return env.ROOMS.get(env.ROOMS.idFromName(name)).fetch(request);
  },
};

export class Room {
  constructor(state) {
    this.state = state;
    this.peers = new Map(); // id -> { ws, info }
  }

  async fetch() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.accept(server);
    return new Response(null, { status: 101, webSocket: client });
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
