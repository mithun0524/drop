# Drop

Send a file to any device on the same Wi-Fi. No accounts, no cloud, no cables.

The file goes device to device over WebRTC. The only server is a websocket that
brokers the handshake — it never sees a byte of your data.

## Layout

```
web/            the app — works as a website, wraps to iOS/Android via Capacitor
  src/transfer.js   chunking, framing, backpressure, reassembly  (tested)
  src/net.js        signaling client + WebRTC peer connections
  src/identity.js   your colour + animal name
  src/ui.js         screens and state
worker/         Cloudflare Worker + Durable Object — signaling only  (tested)
```

## Run it

```sh
npm install
npm run worker:dev          # signaling on :8787
echo 'VITE_SIGNAL_URL=ws://localhost:8787/ws' > web/.env.local
npm run dev                 # app on :5199, also on your LAN IP
```

Open the LAN URL on a second device to see the two find each other.

## Test

```sh
npm test          # transfer protocol: byte-exact round trip, truncation, overrun
npm run test:signal   # signaling + pairing semantics  (worker must be running on :8788)
```

## Deploy

```sh
npm run worker:deploy
npm run build     # web/dist -> any static host
```

Then set `VITE_SIGNAL_URL` to the deployed worker before building.

### iOS / Android

```sh
npx cap add ios && npx cap add android
npm run build && npx cap sync
```

iOS needs `NSLocalNetworkUsageDescription` in `Info.plist` — without it the OS
silently withholds LAN candidates and every connection fails. The app detects
that case and shows the permission screen.

## How pairing works

The worker hashes the caller's public IP and uses it as the room name, so every
device behind the same NAT lands in the same room and appears in each other's
list with nothing to type.

A pairing code is a **pointer to a room, never a room of its own**. A device
publishes a code for the room it is already in; scanning or typing that code
resolves through a directory and drops you into that same room. This is why
showing a code costs nothing — it does not move you — and why the QR on the
front screen can carry one, so scanning works whether or not IP grouping does.
Codes expire after ten minutes and an unknown one falls back to your own room
rather than stranding you somewhere empty.

## Resume

A dropped connection does not cost the bytes already moved. The offer carries a
transfer id; a receiver that recognises it answers with how much of each file it
kept instead of asking to accept again, and the sender seeks past that. At ten
gigabytes the difference is between slow and unusable.

The receiver trusts its own byte count over the sender's claimed offset — it is
the only side that knows what actually reached disk — and refuses a resume whose
offset disagrees, rather than writing at the wrong place. Cancelling deliberately
discards the partial; only a drop keeps it. Resume survives a lost connection,
not a page reload.

## Size limits

Sending has no limit: files are read in 64KB slices with backpressure, so the
sender never holds more than a few megabytes.

Receiving depends on the browser. Chromium can stream straight to disk via the
File System Access API, and the handles are opened at the accept tap because a
save picker is only allowed from a user gesture — there the size is unbounded.
Everywhere else the file is assembled in memory, which caps a transfer at
roughly 1.8GB on a desktop, 1.2GB on Android and 0.7GB on iOS. Both the sender
and the receiver are warned before a transfer that would exceed it, rather than
finding out when the tab is killed.

## Scope

LAN only. There is no TURN relay, so if two devices can't reach each other
directly the connection fails and says so. Adding cross-network would mean
relaying every byte through a server: a bandwidth bill, and slow.

Not built: transfer history, resume, folders, send-text, custom device names.
