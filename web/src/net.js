// Signaling client + WebRTC peer connections.
//
// LAN only by design: no TURN server is configured, so if the two devices can't
// reach each other directly the connection fails — and we report that plainly
// rather than hanging. That failure IS the "this Wi-Fi blocks it" screen.

const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const CONNECT_TIMEOUT = 10_000;

// Same origin by default — the worker serves both the app and /ws. Override
// only when running the app off a separate dev server.
export const SIGNAL_URL =
  import.meta.env?.VITE_SIGNAL_URL ||
  (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';

export class Net extends EventTarget {
  constructor(me) {
    super();
    this.me = me; // { name, color, kind }
    this.id = null;
    this.peers = new Map(); // id -> info
    this.conns = new Map(); // id -> { pc, ch }
    this.ws = null;
    this.code = null;
    this.retry = 0;
    this.closed = false;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  connect(code = null) {
    this.code = code;
    this.closed = false;
    const url = SIGNAL_URL + (code ? '?code=' + encodeURIComponent(code) : '');
    const ws = (this.ws = new WebSocket(url));

    ws.onopen = () => {
      this.retry = 0;
      this.emit('status', 'online');
      ws.send(JSON.stringify({ t: 'hello', ...this.me }));
    };

    ws.onmessage = (ev) => this.onSignal(JSON.parse(ev.data));

    ws.onclose = () => {
      if (this.closed) return;
      // An in-flight transfer rides its own data channel and is unaffected by
      // this — that's the whole point of getting off the socket after setup.
      this.emit('status', 'reconnecting');
      this.retry = Math.min(this.retry + 1, 6);
      setTimeout(() => this.connect(this.code), 400 * 2 ** this.retry);
    };
  }

  disconnect() {
    this.closed = true;
    this.ws?.close();
  }

  setMe(me) {
    this.me = me;
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'hello', ...this.me }));
  }

  async onSignal(m) {
    if (m.t === 'welcome') {
      this.id = m.id;
      return;
    }
    if (m.t === 'peers') {
      this.peers = new Map(m.peers.map((p) => [p.id, p]));
      return this.emit('peers', [...this.peers.values()]);
    }
    if (m.t === 'join') {
      this.peers.set(m.peer.id, m.peer);
      return this.emit('peers', [...this.peers.values()]);
    }
    if (m.t === 'leave') {
      this.peers.delete(m.id);
      const c = this.conns.get(m.id);
      if (c) {
        this.emit('gone', m.id);
        c.pc.close();
        this.conns.delete(m.id);
      }
      return this.emit('peers', [...this.peers.values()]);
    }
    if (m.t === 'signal') await this.onPeerSignal(m.from, m.data);
  }

  send(to, data) {
    this.ws?.send(JSON.stringify({ t: 'signal', to, data }));
  }

  newPc(id) {
    const pc = new RTCPeerConnection(ICE);
    pc.onicecandidate = (e) => e.candidate && this.send(id, { candidate: e.candidate });
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') this.emit('blocked', id);
      if (pc.connectionState === 'disconnected') this.emit('gone', id);
    };
    return pc;
  }

  /** Caller side: open a data channel and wait for it to actually be usable. */
  async open(id) {
    const existing = this.conns.get(id);
    if (existing?.ch?.readyState === 'open') return existing.ch;

    const pc = this.newPc(id);
    const ch = pc.createDataChannel('drop', { ordered: true });
    ch.binaryType = 'arraybuffer';
    this.conns.set(id, { pc, ch });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.send(id, { sdp: pc.localDescription });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('blocked')),
        CONNECT_TIMEOUT
      );
      ch.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') {
          clearTimeout(timer);
          reject(new Error('blocked'));
        }
      };
    });

    this.wire(id, ch);
    return ch;
  }

  async onPeerSignal(from, data) {
    let entry = this.conns.get(from);

    if (data.sdp) {
      if (data.sdp.type === 'offer') {
        // Answerer side: the channel arrives to us.
        const pc = entry?.pc ?? this.newPc(from);
        pc.ondatachannel = (e) => {
          const ch = e.channel;
          ch.binaryType = 'arraybuffer';
          this.conns.set(from, { pc, ch });
          this.wire(from, ch);
        };
        this.conns.set(from, { pc, ch: null });
        await pc.setRemoteDescription(data.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.send(from, { sdp: pc.localDescription });
      } else if (entry) {
        await entry.pc.setRemoteDescription(data.sdp);
      }
      return;
    }

    if (data.candidate && entry?.pc) {
      await entry.pc.addIceCandidate(data.candidate).catch(() => {});
    }
  }

  wire(id, ch) {
    ch.onmessage = (e) => this.emit('message', { from: id, data: e.data });
    ch.onclose = () => this.emit('gone', id);
    this.emit('channel', { id, ch });
  }

  channel(id) {
    return this.conns.get(id)?.ch ?? null;
  }

  /** True once at least one host (LAN) candidate was gathered. On iOS a total
   *  absence of host candidates means Local Network permission was denied. */
  static async probeLocalNetwork() {
    const pc = new RTCPeerConnection(ICE);
    pc.createDataChannel('probe');
    await pc.setLocalDescription(await pc.createOffer());
    const ok = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 2500);
      pc.onicecandidate = (e) => {
        if (e.candidate?.candidate.includes('typ host')) {
          clearTimeout(timer);
          resolve(true);
        }
      };
    });
    pc.close();
    return ok;
  }
}
