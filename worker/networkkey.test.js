// Two devices on one LAN must produce the same key; two strangers must not.
import assert from 'node:assert/strict';
import { networkKey } from './src/index.js';

// IPv6: same /64, different interface IDs -> same network.
const laptop = '2401:4900:88c9:f7f:c4d6:a4e:fa50:657f';
const phone  = '2401:4900:88c9:f7f:1a2b:3c4d:5e6f:7890';
assert.equal(networkKey(laptop), networkKey(phone), 'same /64 must share a room');
assert.equal(networkKey(laptop), '2401:4900:88c9:f7f::/64');

// A different /64 is a different network.
assert.notEqual(networkKey(laptop), networkKey('2401:4900:88c9:aaa:c4d6:a4e:fa50:657f'));

// "::" compression, in every position.
assert.equal(networkKey('2401:4900::1'), '2401:4900:0:0::/64');
assert.equal(networkKey('2401:4900:88c9:f7f::'), '2401:4900:88c9:f7f::/64');
assert.equal(networkKey('::1'), '0:0:0:0::/64');
// Compressed and expanded forms of one address must agree.
assert.equal(networkKey('2401:4900:0:0:0:0:0:5'), networkKey('2401:4900::5'));

// Leading zeros are normalised, so textual variants don't split a room.
assert.equal(networkKey('2401:04900:088c9:0f7f:1:2:3:4'), networkKey(laptop));

// IPv4 is NATed, so the whole address is the network.
assert.equal(networkKey('223.181.109.204'), '223.181.109.204');
assert.notEqual(networkKey('223.181.109.204'), networkKey('223.181.109.205'));

// IPv4-mapped IPv6 is still IPv4.
assert.equal(networkKey('::ffff:223.181.109.204'), '223.181.109.204');

// Zone ids are noise.
assert.equal(networkKey('2401:4900:88c9:f7f::1%en0'), networkKey(laptop));

assert.equal(networkKey(''), 'unknown');
assert.equal(networkKey(null), 'unknown');

console.log('networkKey: all checks passed');
