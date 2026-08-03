> [!IMPORTANT]
> **Unofficial community multiplatform preview.** This repository combines the
> original Apple source, a pinned official Android source, and an experimental
> Windows Desktop feature. It is under active development, is not endorsed as
> an official upstream release, and must not be presented as fully audited or
> feature-complete. See [official sources and attribution](UPSTREAM.md).
> The supplied Apple workspace also differs from its official history anchor;
> review the [upstream difference audit](docs/UPSTREAM-DIFF-AUDIT.md).

<img width="256" height="256" alt="icon_128x128@2x" src="https://github.com/user-attachments/assets/90133f83-b4f6-41c6-aab9-25d0859d2a47" />

## bitchat

A decentralized peer-to-peer messaging app with dual transport architecture: local Bluetooth mesh networks for offline communication and internet-based Nostr protocol for global reach. No accounts, no phone numbers, no central servers. It's the side-groupchat.

[bitchat.free](http://bitchat.free)

### Official upstream downloads

📲 [Official App Store release](https://apps.apple.com/us/app/bitchat-mesh/id6748219622)

📲 [Official Play Store release](https://play.google.com/store/apps/details?id=com.bitchat.droid)

Community-built Android and Windows binaries are published only through this
repository's **GitHub Releases** page. A release is a preview until its signed
artifacts pass the physical test gate in
[`docs/RELEASING-PLATFORMS.md`](docs/RELEASING-PLATFORMS.md).

### Getting a copy you can trust

Install from the App Store, or build from source you have verified. A compiled build from anywhere else cannot be verified — see [Verifying bitchat](docs/VERIFYING-A-BUILD.md) for how to check source against the per-release hash manifest, and for what to do if that is the only build you can get.

This matters more than it usually would: this repository has been the target of takedown demands, and when a repository or releases page disappears, mirrors appear that nobody can check.

## License

This project is released into the public domain. See the [LICENSE](LICENSE) file for details.

## Features

- **Dual Transport Architecture**: Bluetooth mesh for offline + Nostr protocol for internet-based messaging
- **Location-Based Channels**: Geographic chat rooms using geohash coordinates over global Nostr relays
- **Intelligent Message Routing**: Automatically chooses best transport (Bluetooth → Nostr fallback)
- **Decentralized Mesh Network**: Automatic peer discovery and multi-hop message relay over Bluetooth LE
- **Privacy First**: No accounts, no phone numbers, no servers. Note that the mesh does use a persistent per-device identifier derived from your identity key — see [the whitepaper](WHITEPAPER.md) on identity and metadata for what a nearby radio can observe
- **Private Message End-to-End Encryption**: [Noise Protocol](https://noiseprotocol.org) for mesh, BitChat private envelopes for Nostr fallback
- **IRC-Style Commands**: Familiar `/slap`, `/msg`, `/who` style interface
- **Universal App**: Native support for iOS and macOS
- **Emergency Wipe**: Triple-tap to instantly clear all data
- **Performance Optimizations**: LZ4 message compression, adaptive battery modes, and optimized networking

Additive Windows desktop and Android integration are documented in
[`docs/PLATFORM-FEATURES.md`](docs/PLATFORM-FEATURES.md). These features are
kept outside the original Apple source tree and share a wire-level conformance
contract instead of duplicating transport logic.

## [Technical Architecture](https://deepwiki.com/permissionlesstech/bitchat)

BitChat uses a **hybrid messaging architecture** with two complementary transport layers:

### Bluetooth Mesh Network (Offline)

- **Local Communication**: Direct peer-to-peer within Bluetooth range
- **Multi-hop Relay**: Messages route through nearby devices (max 7 hops)
- **No Internet Required**: Works completely offline in disaster scenarios
- **Noise Protocol Encryption**: End-to-end encryption, with forward secrecy for live sessions (store-and-forward mail is sealed without it — see the whitepaper)
- **Binary Protocol**: Compact packet format optimized for Bluetooth LE constraints
- **Automatic Discovery**: Peer discovery and connection management
- **Adaptive Power**: Battery-optimized duty cycling

### Nostr Protocol (Internet)

- **Global Reach**: Connect with users worldwide via internet relays
- **Location Channels**: Geographic chat rooms using geohash coordinates
- **290+ Relay Network**: Distributed across the globe for reliability
- **BitChat Private Envelopes**: App-specific encrypted private messages over Nostr relays
- **Ephemeral Keys**: Fresh cryptographic identity per geohash area

BitChat's private-envelope format is proprietary and is **not** NIP-17,
NIP-44, or NIP-59 compatible. It uses Nostr as a relay transport but only
interoperates with BitChat clients: private payloads travel inside kind-1059
events whose `v2:`-prefixed content is a BitChat-specific XChaCha20-Poly1305
construction, not NIP-44 encryption.

### Channel Types

#### `mesh #bluetooth`

- **Transport**: Bluetooth Low Energy mesh network
- **Scope**: Local devices within multi-hop range
- **Internet**: Not required
- **Use Case**: Offline communication, protests, disasters, remote areas

#### Location Channels (`block #dr5rsj7`, `neighborhood #dr5rs`, `country #dr`)

- **Transport**: Nostr protocol over internet
- **Scope**: Geographic areas defined by geohash precision
  - `block` (7 chars): City block level
  - `neighborhood` (6 chars): District/neighborhood
  - `city` (5 chars): City level
  - `province` (4 chars): State/province
  - `region` (2 chars): Country/large region
- **Internet**: Required (connects to Nostr relays)
- **Use Case**: Location-based community chat, local events, regional discussions

### Direct Message Routing

Private messages use **intelligent transport selection**:

1. **Bluetooth First** (preferred when available)

   - Direct connection with established Noise session
   - Fastest and most private option

2. **Nostr Fallback** (when Bluetooth unavailable)

   - Uses recipient's Nostr public key
   - BitChat's app-specific private-envelope encryption
   - Routes through global relay network

3. **Smart Queuing** (when neither available)
   - Messages queued until transport becomes available
   - Automatic delivery when connection established

For detailed protocol documentation, see the [Technical Whitepaper](WHITEPAPER.md).

## Setup

### Option 1: Using Xcode

```bash
open bitchat.xcodeproj
```

For a signed device build, create your ignored local configuration and replace
the example team ID with your Apple Developer Team ID:

```bash
cp Configs/Local.xcconfig.example Configs/Local.xcconfig
```

`Local.xcconfig.example` derives unique app and App Group identifiers from that
team ID. The entitlement files already reference `$(APP_GROUP_ID)`, so tracked
project or entitlement files do not need to be edited.

Useful command-line checks from the repository root:

```bash
# macOS Debug build without signing
xcodebuild -project bitchat.xcodeproj -scheme "bitchat (macOS)" \
  -configuration Debug CODE_SIGNING_ALLOWED=NO build

# Full SwiftPM test suite
swift test

# iOS simulator tests
xcodebuild -project bitchat.xcodeproj -scheme "bitchat (iOS)" \
  -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17' test
```

If `iPhone 17` is unavailable, choose an installed simulator from:

```bash
xcodebuild -showdestinations -project bitchat.xcodeproj -scheme "bitchat (iOS)"
```

### Option 2: Using `just`

```bash
brew install just
just check
just run
```

`just build` and `just run` use the current `bitchat (macOS)` scheme and keep
Xcode output in the ignored `.DerivedData/` directory. They never patch source,
project, configuration, or entitlement files.

`just clean` removes only `.DerivedData/` and `.build/`. It does not invoke Git
or restore tracked files, so uncommitted work is preserved. `just test` runs the
SwiftPM suite and `just test-ios` runs the iPhone 17 simulator suite.

### Windows interface preview

The native SwiftUI application still requires macOS and Xcode. A responsive,
browser-only interface preview is available for visual testing on Windows:

```powershell
cd web-preview
npm install
npm start
```

You can also double-click `web-preview\start-preview.cmd`.

Open `http://127.0.0.1:4173` in a browser. The local Node.js server provides
real-time presence, public and private messages, multi-window test identities,
image transfer and persistent local history. Use **Settings → Open** to launch
another participant. Optional adapters in **Settings** can also connect Edge
or Chrome to a native BitChat peer through Web Bluetooth, establish compatible
Noise XX sessions, and use Nostr for public geohash traffic or BitChat private
envelopes. Browser BLE is central-only, so a native device remains the mesh
entry point.

The Web feature keeps the native code untouched and uses a reusable portable
core for input limits, `BitchatMessage` semantics, delivery status,
deduplication and rate limiting. Its boundaries and native parity mapping are
documented in `web-preview/ARCHITECTURE.md`.

For a native Windows BLE node instead of the central-only browser preview, use
the additive Electron host in `apps/desktop`. It advertises the BitChat GATT
service through a native Windows sidecar and reuses the same portable packet,
Noise, relay and Nostr logic. The pinned official Android build is prepared by
`apps/android`; see `docs/PLATFORM-FEATURES.md` for scope and validation status.
Contribution and prerelease instructions live in `CONTRIBUTING.md` and
`docs/RELEASING-PLATFORMS.md`. Generated installers and APKs belong in GitHub
Release assets, not in the source tree.

The community project is actively seeking contributors. See the
[roadmap](ROADMAP.md), [team roles](TEAM.md), [contribution guide](CONTRIBUTING.md)
and [preview announcement rules](docs/COMMUNITY-PREVIEW.md).

## Localization

- App localizations live in `bitchat/Localizable.xcstrings`.
- Share extension strings are separate in `bitchatShareExtension/Localization/Localizable.xcstrings`.
- Prefer keys that describe intent (`app_info.features.offline.title`) and reuse existing ones where possible.
- Run `xcodebuild -project bitchat.xcodeproj -scheme "bitchat (macOS)" -configuration Debug CODE_SIGNING_ALLOWED=NO build` to compile-check any localization updates.
