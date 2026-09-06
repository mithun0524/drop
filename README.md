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
npm run test:signal   # signaling: discovery, targeted relay, leave  (worker must be running)
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
list with nothing to type. When that fails — dual-WAN, CGNAT, guest VLANs — a
4-character room code joins a named room instead.

## Scope

LAN only. There is no TURN relay, so if two devices can't reach each other
directly the connection fails and says so. Adding cross-network would mean
relaying every byte through a server: a bandwidth bill, and slow.

Not built: transfer history, resume, folders, send-text, custom device names.
