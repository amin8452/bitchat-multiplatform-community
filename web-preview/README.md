# bitchat Web Preview

This folder contains a dynamic browser adaptation of the native SwiftUI
interface. It is intended for visual, interaction and multi-user testing on
Windows.

The feature uses a portable Web Core for native-compatible validation,
`BitchatMessage` semantics, delivery status, deduplication and rate limiting.
Bluetooth, Noise and Nostr are optional browser adapters: they do not replace
or modify the native Swift implementation.
See [ARCHITECTURE.md](ARCHITECTURE.md).

## Start on Windows

Double-click `start-preview.cmd`. It starts the local server and opens the
preview in the default browser. Keep the terminal window open while testing;
press `Ctrl+C` there to stop the server.

Alternatively, open PowerShell in this folder and run:

```powershell
npm install
npm start
```

Then open <http://127.0.0.1:4173>.

Node.js 20 or newer is required. `start-preview.cmd` installs the pinned npm
dependencies automatically when needed.

## Included in the preview

- responsive desktop and mobile layouts;
- public mesh and location channels;
- live presence and direct conversations between browser windows;
- real-time text and image delivery through the local Node.js server;
- microphone voice-note capture when a Bluetooth route is available;
- notices, settings, Matrix and Liquid Glass themes;
- light and dark appearance;
- persistent local message history;
- separate identities for each test window;
- optional Web Bluetooth connection to a native BitChat peer;
- native-compatible Noise XX private sessions over that BLE link;
- native-format public and private file/image/audio transfer over Bluetooth;
- Nostr geohash messages and presence (kinds 20000/20001);
- BitChat private Nostr envelopes (kinds 14/13/1059).

Use **Settings → Open** under **Multi-user test** to create another participant.
The new window connects to the same local server immediately.

The runtime message history is stored in `web-preview/.runtime/state.json` and
is excluded from version control.

## Test Bluetooth, Noise and Nostr

Open **Settings → Optional BitChat transports**:

1. For Bluetooth, select production or testnet, click **Connect**, then choose
   a nearby device running the native BitChat app. Public `#mesh` messages use
   the native binary packet format; private messages establish an exact
   `Noise_XX_25519_ChaChaPoly_SHA256` session.
2. For Nostr, choose a `wss://` relay and a geohash, then click **Connect**.
   Public messages use the geohash kinds and direct messages use BitChat's
   proprietary XChaCha20-Poly1305 envelope.

Bluetooth must be initiated by a click and works in a secure context in a
compatible Chromium browser such as Edge or Chrome. A browser can be a BLE
central/GATT client, but cannot advertise BitChat's peripheral service.
Consequently, the selected native device acts as the browser's entry point
into the mesh.

The optional browser identities live in `sessionStorage`; they are deliberately
separate from the native Keychain and isolated by test participant. In the
packaged Windows host, the same identity port is instead backed by current-user
Windows DPAPI. The Nostr identity rotates per geohash, and Nostr exposes the
browser's IP address to the selected relay. Private text includes compatible
delivery/read receipts on Noise and Nostr. Bluetooth files, optimized images
and recorded voice notes use the native TLV, signature, Noise and size-limit
rules. Live push-to-talk, groups and courier storage remain outside the
browser UI.

## Tests

```powershell
npm test
```

The test suite covers domain parity, the local server lifecycle, native binary
packets and files, fragmentation/compression/signatures, every bundled Noise
vector, nonce replay protection, frozen iOS/Android private-Nostr fixtures and
direct comparisons with the untouched Apple/Android wire enums.
