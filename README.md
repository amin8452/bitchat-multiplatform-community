# BitChat Multiplatform Community Preview

An independent, community-maintained workspace that extends the BitChat
ecosystem with an experimental Windows client, a reusable Web core, a browser
preview, and reproducible Android integration while preserving the original
Apple source and its upstream attribution.

> [!IMPORTANT]
> This is an **unofficial community preview**. It is not maintained, endorsed,
> or distributed by the official BitChat maintainers. The complete
> multiplatform distribution has not received an independent security audit,
> does not yet provide full feature parity, and must not be presented as
> production-ready.

[Community releases](https://github.com/amin8452/bitchat-multiplatform-community/releases)
| [Platform matrix](docs/PLATFORM-FEATURES.md)
| [Roadmap](ROADMAP.md)
| [Official sources](UPSTREAM.md)
| [Contributing](CONTRIBUTING.md)

## What this project adds

The community work is additive: platform-specific hosts live beside the Apple
application instead of replacing it. Reusable protocol behavior is shared at
the wire-contract and portable-core boundaries.

| Community component | Location | Purpose |
| --- | --- | --- |
| Portable Web core | `web-preview/src/` | Shared message validation, packet handling, Noise sessions, Nostr adapters, relay policy and media limits |
| Windows Desktop host | `apps/desktop/` | Electron interface with a native .NET Bluetooth LE and DPAPI sidecar |
| Browser preview | `web-preview/` | Responsive local multi-user testing and optional browser Bluetooth/Nostr adapters |
| Android build integration | `apps/android/` | Reproducible Windows scripts around an exact official Android source revision |
| Android source pin | `android-app/` | Unmodified official Kotlin client included as a Git submodule |
| Shared protocol contract | `protocol-conformance/` | Reviewed packet, message and compatibility values used by cross-platform tests |
| Platform delivery tooling | `.github/workflows/` | Validation, security scanning, provenance and signed prerelease workflows |

The main additions follow small platform ports rather than a new universal app
framework. Bluetooth access and secure key storage remain native to each host,
while packet encoding, limits and interoperability rules are reused.

## Platform status

| Platform | Implementation | Current status |
| --- | --- | --- |
| iOS / macOS | Swift and SwiftUI source based on the official Apple project | Native reference implementation; requires macOS and Xcode |
| Android | Official Kotlin client pinned at `49753ccb888531bfc413431e7002b0776a8268f0` | Native application; community scripts build the verified source without rewriting it |
| Windows 10/11 x64 | Community Electron host plus native .NET BLE/DPAPI sidecar | Experimental preview; real interoperability depends on the Bluetooth adapter and driver |
| Web | Portable JavaScript core and browser interface | Development and testing preview; not a production native client |

### Important capability limits

- Windows supports public and private text, Noise XX sessions, receipts,
  Nostr, QR identity verification, files, optimized photos and recorded voice
  notes through the shared transport pipeline.
- Windows can safely relay several newer packet families, but its interface
  does not yet implement live push-to-talk, group management, boards, prekeys
  or courier-storage workflows.
- The pinned Android client has native messaging, Noise, Nostr, files and voice
  features, but it does not contain every newer message type found in the
  current Apple source.
- A browser can connect as a Bluetooth LE central in a compatible Chromium
  browser, but it cannot advertise the BitChat peripheral service. A native
  peer is therefore required as its mesh entry point.
- Windows-to-Android Bluetooth interoperability must be verified on physical
  devices. An emulator or local loopback smoke test cannot prove radio
  compatibility.

See the [complete parity and security matrix](docs/PLATFORM-FEATURES.md) before
describing or distributing a build.

## Architecture

```text
                         official Apple source
                         bitchat/ + Xcode project
                                   |
                    protocol-conformance/bitchat-wire-v1.json
                                   |
                         portable Web core
                           web-preview/src
                         /                 \
             browser preview          Windows Desktop
             BLE central only         Electron renderer
                                             |
                                  native .NET sidecar
                                  BLE peripheral + DPAPI

             official Android source (pinned Git submodule)
                              android-app/
                                  |
                    community build/release scripts
                            apps/android/
```

This structure avoids copying protocol constants into every host and keeps
native responsibilities behind narrow interfaces. More detail is available in
the [Web architecture](web-preview/ARCHITECTURE.md) and
[platform feature documentation](docs/PLATFORM-FEATURES.md).

## Downloads

### Official applications

Use the official stores when you want an upstream-supported mobile build:

- [Official Apple App Store release](https://apps.apple.com/us/app/bitchat-mesh/id6748219622)
- [Official Google Play release](https://play.google.com/store/apps/details?id=com.bitchat.droid)

### Community preview builds

Community Android APKs and Windows installers, when available, are published
only on this repository's
[GitHub Releases page](https://github.com/amin8452/bitchat-multiplatform-community/releases).
If no suitable release is present, build from source.

Treat every `platform-v*` release as a prerelease until its physical test matrix
is published. A distributable release must include signed binaries, SHA-256
checksums, source provenance and the corresponding Android GPL source package.
Debug APKs and unsigned Windows packages are development outputs, not public
releases. See [release requirements](docs/RELEASING-PLATFORMS.md) and
[build verification](docs/VERIFYING-A-BUILD.md).

## Clone the complete source

The Android client is a Git submodule. Clone recursively so the pinned official
source is available:

```powershell
git clone --recurse-submodules https://github.com/amin8452/bitchat-multiplatform-community.git
cd bitchat-multiplatform-community
```

For an existing clone:

```powershell
git submodule update --init --recursive
```

## Run the Web preview on Windows

Requirements: Node.js 20 or newer and a current Edge or Chrome browser for the
optional Web Bluetooth adapter.

```powershell
cd web-preview
npm ci
npm start
```

Open <http://127.0.0.1:4173>. You can also double-click
`web-preview\start-preview.cmd`.

The local server provides live test participants, public/private conversations,
images and persistent local history. Browser identities are test identities
stored in session storage; they are not equivalent to native Keychain or DPAPI
protection. See the [Web preview guide](web-preview/README.md).

## Run the Windows Desktop preview

Requirements:

- Windows 10 or Windows 11 x64;
- Node.js 22.12 or newer;
- .NET SDK 8;
- a Bluetooth LE adapter and driver supporting the required GATT peripheral
  role.

```powershell
cd apps\desktop
npm ci
npm start
```

Keep the application open while testing Bluetooth because the radio is not a
background Windows service.

Create an unsigned portable development build with:

```powershell
npm run package:windows
```

The executable is generated under
`apps\desktop\dist\bitchat-desktop-win32-x64\`. Building an installer additionally
requires Inno Setup 6 and `npm run installer:windows`. Public distribution
requires Authenticode signing; local output is unsigned by default. See the
[Desktop guide](apps/desktop/README.md).

## Build the Android application on Windows

Requirements: PowerShell, JDK 21 and Android SDK API 37. The scripts verify and
build the exact source revision declared in `apps/android/upstream.json`.

From the repository root:

```powershell
.\apps\android\setup.ps1
.\apps\android\build-debug.ps1
```

The universal debug APK is copied to:

```text
apps/android/dist/bitchat-debug.apk
```

To install it on an authorized USB-connected phone:

```powershell
adb devices
adb install -r .\apps\android\dist\bitchat-debug.apk
```

A store-installed copy may use a different signing certificate and reject the
debug APK. Uninstalling the existing application can erase its local data. See
the [Android build guide](apps/android/README.md) before proceeding.

## Build the Apple application

The iOS/macOS source requires macOS and Xcode:

```bash
open bitchat.xcodeproj
```

For a signed device build, copy `Configs/Local.xcconfig.example` to the ignored
`Configs/Local.xcconfig` file and configure your Apple Developer Team ID there.
Do not commit signing identities or provisioning material.

Useful checks include:

```bash
swift test

xcodebuild -project bitchat.xcodeproj -scheme "bitchat (macOS)" \
  -configuration Debug CODE_SIGNING_ALLOWED=NO build
```

The package declares iOS 16 and macOS 13 as its minimum platform versions.

## Test the community additions

Run the portable and Desktop checks on Windows:

```powershell
npm --prefix web-preview ci
npm --prefix web-preview run build
npm --prefix web-preview test

npm --prefix apps\desktop ci
npm --prefix apps\desktop run prepare:runtime
npm --prefix apps\desktop test
```

For a physical PC-to-phone test, start both native applications on the same
production mesh, grant Bluetooth/Nearby permissions, then verify public text,
private Noise text, receipts, QR verification, images and bounded voice notes
in both directions. Follow the full
[physical release gate](docs/RELEASING-PLATFORMS.md#required-release-gate-tests).

## Security model and warnings

- The Windows sidecar generates Noise and Ed25519 private keys natively and
  protects them with Windows DPAPI for the current user.
- The Electron renderer uses sandboxing, context isolation, origin checks and
  ownership checks for radio operations.
- Private files travel inside authenticated Noise sessions; public files
  require a valid announced identity and signature.
- File sizes, fragments, timestamps, duplicates and relay TTL values are
  bounded by shared policies.
- Browser-only identities use session storage and provide weaker protection
  than native storage.
- Connecting to a Nostr relay exposes the client's IP address to that relay.
- BitChat private Nostr envelopes are application-specific and are not generic
  NIP-17, NIP-44 or NIP-59 interoperability.
- Passing automated protocol tests is not a substitute for an independent
  security audit.

Report vulnerabilities privately according to [SECURITY.md](SECURITY.md). Do
not include private keys, credentials, personal chat data or exploitable
details in a public issue.

## Relationship to the official projects

This GitHub repository is standalone and is not registered as a GitHub fork.
It deliberately preserves upstream history and attribution so changes remain
reviewable.

- Apple upstream: <https://github.com/permissionlesstech/bitchat>
- Apple history anchor: official `v1.7.1` tag,
  `9edb7c26ef7bdcf3bb29e7907b38997f8d5cd0fa`
- Android upstream: <https://github.com/permissionlesstech/bitchat-android>
- Android pinned revision: `49753ccb888531bfc413431e7002b0776a8268f0`

The supplied Apple workspace contains tracked differences from its history
anchor; it is not claimed to be byte-for-byte identical. Review
[UPSTREAM.md](UPSTREAM.md) and the
[upstream difference audit](docs/UPSTREAM-DIFF-AUDIT.md) for exact provenance.

## Repository layout

```text
bitchat/                 Apple application source
bitchatTests/            Apple and protocol tests
android-app/             pinned official Android Git submodule
apps/android/            Android integration and release scripts
apps/desktop/            community Windows Desktop host
web-preview/             portable core and browser preview
protocol-conformance/    shared wire-level contract
docs/                    architecture, parity, security and release guides
```

## Contributing

This project is under active development and welcomes focused contributions in
Windows BLE interoperability, Android/Apple protocol compatibility, security
review, accessibility, testing, packaging and documentation.

Read [CONTRIBUTING.md](CONTRIBUTING.md), choose an item from the
[roadmap](ROADMAP.md), and describe the automated and physical devices used for
validation. Community additions should remain isolated and should reuse the
shared contract instead of duplicating packet constants or native code.

## License

The repository root and community additions are released under the
[Unlicense](LICENSE). The pinned Android project and any redistributed Android
APK remain governed by the upstream GNU GPL v3 license and corresponding-source
requirements. Third-party dependencies retain their own licenses.

BitChat names, upstream application listings and upstream source links are
included for identification and attribution. They do not imply official
endorsement of this community distribution.
