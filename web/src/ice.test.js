// The offerer trickles candidates the instant setLocalDescription resolves, so
// they routinely arrive before the answerer has processed the offer — and
// addIceCandidate throws until a remote description exists. Dropping them loses
// the host candidates first, which on a LAN are the only ones that connect.
//
// This drives Net's signalling handler with a fake RTCPeerConnection, ordering
// the messages the way the race actually delivers them.
import assert from 'node:assert/strict';

const added = [];
let remoteSet = false;

class FakePc {
  constructor() {
    this.connectionState = 'new';
    this.remoteDescription = null;
    this.localDescription = { type: 'answer', sdp: 'a' };
  }
  addEventListener() {}
  createDataChannel() {
    return { binaryType: '', addEventListener() {}, send() {} };
  }
  async createOffer() {
    return { type: 'offer', sdp: 'o' };
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'a' };
  }
  async setLocalDescription() {}
  async setRemoteDescription(d) {
    this.remoteDescription = d;
    remoteSet = true;
  }
  async addIceCandidate(c) {
    // The real thing rejects before a remote description is set. Reproduce
    // that, or the test would pass against the bug it exists to catch.
    if (!this.remoteDescription) throw new Error('InvalidStateError');
    added.push(c);
  }
  close() {}
}

globalThis.RTCPeerConnection = FakePc;
globalThis.WebSocket = class {
  constructor() {
    this.readyState = 1;
  }
  send() {}
  close() {}
};
globalThis.location = { protocol: 'https:', host: 'drop.test' };

const { Net } = await import('./net.js');

// Candidates first, offer second — the order the race produces.
{
  added.length = 0;
  remoteSet = false;
  const net = new Net({ name: 'Me', color: 'red', kind: 'phone' });
  net.ws = { readyState: 1, send() {} };

  await net.onPeerSignal('peer1', { candidate: { candidate: 'a typ host' } });
  await net.onPeerSignal('peer1', { candidate: { candidate: 'b typ host' } });
  assert.equal(added.length, 0, 'nothing can be added before the offer');
  assert.equal(net.ice.get('peer1')?.length, 2, 'early candidates are held, not dropped');

  await net.onPeerSignal('peer1', { sdp: { type: 'offer', sdp: 'o' } });
  assert.ok(remoteSet, 'the offer was applied');
  assert.equal(added.length, 2, 'held candidates are replayed once usable');
  assert.deepEqual(
    added.map((c) => c.candidate),
    ['a typ host', 'b typ host'],
    'and replayed in arrival order'
  );
  assert.equal(net.ice.has('peer1'), false, 'the queue is emptied');
}

// Candidates arriving after the offer go straight through.
{
  added.length = 0;
  const net = new Net({ name: 'Me', color: 'red', kind: 'phone' });
  net.ws = { readyState: 1, send() {} };
  await net.onPeerSignal('peer2', { sdp: { type: 'offer', sdp: 'o' } });
  await net.onPeerSignal('peer2', { candidate: { candidate: 'late typ host' } });
  assert.equal(added.length, 1, 'a late candidate needs no queue');
  assert.equal(net.ice.has('peer2'), false);
}

// A peer that leaves must not leave its candidates behind.
{
  const net = new Net({ name: 'Me', color: 'red', kind: 'phone' });
  net.ws = { readyState: 1, send() {} };
  await net.onPeerSignal('peer3', { candidate: { candidate: 'x typ host' } });
  assert.equal(net.ice.get('peer3').length, 1);
  await net.onSignal({ t: 'leave', id: 'peer3' });
  assert.equal(net.ice.has('peer3'), false, 'the queue goes with the peer');
}

console.log('ice: early candidates are queued, replayed and cleaned up');
