# Web Core architecture

The Web feature is additive. It does not modify or replace the native Swift
application under `bitchat/` or the shared Swift packages under
`localPackages/`.

## Boundaries

```text
                         Browser UI (app.js)
                    /             |              \
       RealtimeChatClient   WebBluetoothMesh   NostrGeohash
               |                  |              |
          HTTP + SSE       BitChat codec +      BitChat private
               |             Noise XX           envelope
          server.mjs              |              |
          /        \         Web Bluetooth    WebSocket relay
     Web Core    JSON repository
```

`src/core/` contains pure, platform-independent domain rules. It never imports
the DOM, HTTP, Node.js filesystem APIs or UI code. Both the browser and server
reuse these modules.

`src/adapters/` contains replaceable technology details:

- `realtime-chat-client.js` maps browser use cases to HTTP/SSE;
- `json-message-repository.js` persists messages without leaking filesystem
  details into the domain.

`server.mjs` is the composition root. It wires the domain to the adapters and
owns only local-server concerns such as routes, presence and SSE clients.

`src/features/native-connectivity/` is an optional feature boundary:

- `bit-chat-codec.js` owns the native binary packet, TLV, signature,
  compression, file and fragmentation contracts;
- `wire-contract.js` exposes the single versioned JSON wire contract;
- `mesh-relay-policy.js` bounds packet families that the UI does not consume;
- `noise-xx.js` owns the exact Noise XX handshake and transport nonces;
- `web-bluetooth-mesh-adapter.js` maps browser GATT to those contracts;
- `bit-chat-nostr-envelope.js` owns BitChat's proprietary private envelope and
  reuses the binary codec for embedded direct messages;
- `nostr-geohash-adapter.js` maps public geohash and private events to a relay;
- `browser-mesh-identity.js` selects an isolated browser identity or the
  protected Desktop identity port.

The UI depends on adapter callbacks and small public methods. Transport,
cryptography, storage and presentation are kept in separate modules, and the
binary private-message codec is shared by Bluetooth and Nostr rather than
duplicated.

## Native parity

The portable rules intentionally mirror these native sources:

| Web Core | Native source |
| --- | --- |
| `input-validator.js` | `bitchat/Utils/InputValidator.swift` |
| `message.js` | `BitFoundation/BitchatMessage.swift`, `DeliveryStatus.swift` |
| `traffic-policy.js` | `MessageDeduplicator.swift`, `MessageRateLimiter.swift`, `MessageDeduplicationService.swift` |
| `config.js` | `InputValidator.Limits`, `TransportConfig.swift` |
| `bit-chat-codec.js` | `BitchatProtocol.swift`, `BinaryProtocol.swift`, `NostrEmbeddedBitChat.swift` |
| `noise-xx.js` | `NoiseProtocol.swift`, `NoiseSession.swift`, bundled Noise vectors |
| `bit-chat-nostr-envelope.js` | `NostrProtocol.swift`, frozen iOS/Android fixtures |

`npm test` checks the shared invariants: UTF-8 limits, timestamps, nickname
rules, message shape, mentions, content normalization, deduplication, rate
limits, idempotence, persistence, native files and exact Apple/Android enum
alignment.

## Browser boundary

The browser adapter is not a replacement for CoreBluetooth. Web Bluetooth only
provides the GATT-central role used here, requires an explicit device chooser
and cannot advertise BitChat's peripheral service. A native peer is therefore
required as the BLE entry point. Hardware interoperability still requires a
manual Edge/Chrome test with a real BitChat device.

The Nostr browser identity is session-scoped rather than stored in Apple
Keychain. The packaged Desktop mesh identity is provided by its DPAPI-backed
native port. Text/public-presence flows, delivery/read receipts and Bluetooth
file/image transfer and bounded voice-note capture are active when BLE is
available. The engine can relay additional bounded wire families, but live
push-to-talk, groups and courier storage are not browser application workflows.

Cryptographic primitives come from pinned Noble packages; protocol composition
is local and checked against the repository's native vectors and fixtures.
