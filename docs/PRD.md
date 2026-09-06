# Product Requirements — LAN File Drop

**Working name:** Drop *(placeholder — rename before launch)*
**Version:** 1.0
**Date:** 2026-09-06

---

## 1. The one-sentence pitch

Send a file from any device to any other device on the same Wi-Fi, instantly, without accounts, cables, cloud uploads, or wondering which app the other person has.

---

## 2. The problem

Two people are sitting in the same room. One has a photo, a video, a PDF. Getting it to the other person's device is absurdly hard today:

- **AirDrop** only works Apple-to-Apple.
- **Nearby Share** only works Android-to-Android.
- **WhatsApp / Telegram** crushes image and video quality, and caps file size.
- **Email** caps at 25 MB and is slow.
- **Google Drive / Dropbox** means uploading to the internet and back down again — slow, uses data, and requires both people to have the account.
- **A USB cable** requires having the right cable.

The file only needs to travel three feet. Today it travels to a data centre and back.

---

## 3. The solution

Both devices open the same web page. They see each other. One taps the other, picks a file, and it transfers directly over the local Wi-Fi at full local speed.

Three properties that define the product:

1. **No install required.** It works in a browser. An app exists for people who want it, but nobody is forced to download anything to receive a file.
2. **No account required.** No sign-up, no email, no login. Ever.
3. **The file never leaves the room.** It goes device to device over the local network. Nothing is uploaded to a server, nothing is stored, nothing is logged.

---

## 4. Who it's for

**Primary — "Two people in a room."**
A photographer handing 40 RAW files to a client. A friend sending a video that's too big for WhatsApp. A student sharing a presentation before a class. They may be on completely different platforms and that must not matter.

**Secondary — "My own devices."**
One person moving a file from their laptop to their own phone, or the reverse. No cable, no emailing yourself.

**Explicitly not for:** sending files to someone in a different city. That's a different product.

---

## 5. Core principles

- **Speed is the feature.** Every design decision that adds a step, a screen, or a wait is a bug. Target: under 10 seconds from opening the app to the transfer starting.
- **Zero configuration.** The user should never see a setting, a code, or an IP address in the normal case.
- **Honest failure.** When something can't work, say so immediately and in plain language. Never show a spinner that never ends.
- **Privacy by architecture, not by promise.** There is no server that could leak your files, because your files never touch one.

---

## 6. Platforms

| Platform | How it's delivered | Priority |
|---|---|---|
| Desktop browser (Mac, Windows, Linux) | Website | v1 |
| Mobile browser (iOS Safari, Android Chrome) | Website | v1 |
| iPhone / iPad | App Store | v1 |
| Android | Play Store | v1 |

Every combination must work: laptop → phone, iPhone → Android, Android → laptop, browser → app, app → app.

---

## 7. Screens and states

### 7.1 The Radar (home screen — this is 90% of the product)

The single screen users spend their time on. It shows the current device and every other device on the same network.

**Content:**
- **You** — the current device, shown distinctly. Given an automatic friendly name (e.g. "Purple Otter") and a device-type icon (laptop / phone / tablet). No naming step, no prompt.
- **Nearby devices** — every other device currently on the same network, each with its own name and device icon. Appearing and disappearing live as people open and close the app.
- **A single primary action** — send a file. Whether this is triggered by tapping a device, or by picking a file first and then a device, is a design decision worth exploring both ways.

**States to design:**
- **Empty** — you're the only device here. Needs to be encouraging and instructive, not a dead end: tell the user to open the same page on their other device. This is the state a first-time user sees, and it decides whether they keep going.
- **One or more peers found** — the normal, happy state.
- **Peers appearing / disappearing** — devices join and leave live. Should feel alive, not jumpy.
- **Many peers** — a busy office or classroom with 15 devices. Must not become a wall of noise.
- **Drag-and-drop active (desktop)** — a file is being dragged over the window. The whole surface should invite the drop.

**Design notes:**
- Device identity is the emotional core of this screen. A person needs to look at their friend's phone screen, see "Purple Otter", find "Purple Otter" on their own screen, and tap it. Names must be short, memorable, and pronounceable out loud.
- This screen has no navigation, no menu bar, no tabs. It is one surface.

### 7.2 Sending

**Flow:** pick a device → pick files → confirm → transfer.

**States to design:**
- **Waiting for the other person to accept.** They have to say yes. Show who you're sending to and what you're sending. Must be cancellable.
- **Declined.** They said no. Say it plainly and return to the radar.
- **Transferring.** Progress: percentage, current file name, position in the queue ("file 3 of 12"), and transfer speed. Speed is worth showing prominently — it's fast, and showing "82 MB/s" is the moment the user understands why this product exists.
- **Complete.** Clear, satisfying, and instantly ready for the next transfer.

### 7.3 Receiving

**States to design:**
- **Incoming request.** Someone wants to send you something. Show who, how many files, and the total size. Two choices: accept or decline. This must be impossible to accept by accident.
- **Receiving.** Same progress treatment as sending.
- **Complete.** Where did the file go? On desktop it lands in Downloads; on mobile it's saved to the device. Make the answer visible — "file not found afterwards" is the most likely support complaint.

### 7.4 Multi-file transfers

Sending 40 photos must feel as calm as sending one. Design for:
- Overall progress across the whole batch, plus the current file.
- A visible queue.
- One file failing should not kill the other 39.

### 7.5 Error and edge states

Each of these needs its own designed screen or message. They are the difference between a product people trust and one they abandon.

| Situation | What the user must understand |
|---|---|
| **This network blocks device-to-device** (common on café, hotel, and corporate guest Wi-Fi) | It's the network's fault, not the app's. Suggest a phone hotspot as a workaround. This is the single most important error state in the product. |
| **iPhone hasn't granted local network permission** | Explain what to tap in Settings, specifically. |
| **The other device disappeared mid-transfer** | The transfer stopped, the file is incomplete, try again. |
| **Not connected to Wi-Fi at all** | You need to be on a network. |
| **Connection lost, reconnecting** | A brief, non-alarming indicator. It usually recovers on its own. |

### 7.6 Manual pairing (the fallback)

Rarely needed, but must exist. When automatic discovery doesn't find the other device, either side can create or join a **room** using a short code and a QR code.

**States to design:**
- Showing your code + QR for someone else to scan.
- Entering someone else's code.
- Scanning a QR with the camera.

This should be tucked away — visible enough to find when needed, quiet enough that it never confuses the 90% who don't need it.

### 7.7 First run

There is no onboarding flow, no tour, no sign-up. The user lands directly on the Radar. Any teaching happens inside the empty state.

---

## 8. Tone and voice

Plain, calm, and short. The product is a utility, not a personality.

- Say "This Wi-Fi blocks devices from talking to each other" — not "Connection error (ICE_FAILED)".
- No exclamation marks in error states.
- Never blame the user.
- No jargon, ever: the words *WebRTC*, *peer*, *signaling*, *ICE*, and *SDP* must never appear in the interface.

---

## 9. What is deliberately not in version 1

Naming these keeps the first release small and shippable:

- Sending to someone on a **different** network (this is LAN-only by design).
- Accounts, profiles, sign-in.
- Transfer history or a record of past sends.
- Resuming an interrupted transfer.
- Sending plain text, links, or clipboard contents.
- Custom device names chosen by the user.
- Folders (individual files only).
- Any kind of file preview.

---

## 10. What success looks like

- A first-time user who has never seen the product sends their first file in **under 30 seconds**, with no instructions.
- Transferring a 1 GB video takes **under a minute** on decent Wi-Fi.
- A person can hand their phone to a stranger, say "open this page", and it works.
- Nobody ever asks "where do I sign up?"

---

## 11. Design deliverables needed

1. Radar — empty state
2. Radar — one peer
3. Radar — many peers
4. Radar — drag-and-drop active (desktop)
5. File picker / selection confirm
6. Waiting for the other person to accept
7. Incoming transfer request (accept / decline)
8. Transfer in progress — single file
9. Transfer in progress — batch queue
10. Transfer complete — sender
11. Transfer complete — receiver, showing where the file went
12. Error — network blocks device-to-device
13. Error — iOS local network permission
14. Error — peer disappeared mid-transfer
15. Manual pairing — show code + QR
16. Manual pairing — enter code / scan QR

Each needs a **mobile portrait** and a **desktop** treatment. The desktop version has room to breathe; the mobile version is thumb-reachable and one-handed.
