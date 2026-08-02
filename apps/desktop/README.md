# BitChat Desktop Community Preview (feature additive)

This Windows host reuses the portable Web core and adds a native BLE GATT
peripheral behind the same radio boundary. It does not copy or modify the
original Swift application. Generated runtime files remain under ignored
`runtime/` and `dist/` directories.

This is an unofficial community feature under active development. Local builds
are intentionally unsigned; public `platform-v*` releases require Windows
Authenticode signing and remain prereleases until the physical release gate
passes.

## Run on Windows

Node.js 22.12 or newer and .NET SDK 8 are required.

```powershell
cd apps\desktop
npm install
npm start
```

To build the portable desktop application:

```powershell
npm run package:windows
```

Run `dist\bitchat-desktop-win32-x64\bitchat-desktop.exe`. The folder is a
portable, unsigned development build; it is not a signed production installer.
The validated workspace also contains
`dist\bitchat-desktop-win32-x64.zip` for transfer to another Windows PC.

To generate a per-user installer after packaging, install Inno Setup 6 and run:

```powershell
npm run installer:windows
```

The installer remains unsigned unless the release workflow receives the two
Windows certificate secrets documented in
`../../docs/RELEASING-PLATFORMS.md`. Certificates and passwords are never
stored in this repository.

The packaged end-to-end diagnostic is:

```powershell
$env:BITCHAT_DESKTOP_SMOKE_TEST = "1"
& dist\bitchat-desktop-win32-x64\bitchat-desktop.exe
Remove-Item Env:BITCHAT_DESKTOP_SMOKE_TEST
```

It starts the local runtime, advertises the test BLE service through the native
Windows sidecar, writes one frame and exits. The report is written to
`%TEMP%\bitchat-desktop-smoke.json`.

## Architecture and scope

- The renderer depends on a reusable radio-link interface.
- Electron selects the native Windows peripheral implementation; a regular
  Chromium browser keeps the Web Bluetooth central implementation.
- Both implementations reuse the same BitChat packet codec, Noise XX session,
  deduplication, verified relay policy and Nostr adapters.
- The packaged host loads or creates its Noise and Ed25519 secrets through the
  native Windows sidecar. They are encrypted with DPAPI for the current Windows
  user and are not written to Web Storage.
- UUIDs and wire values come from
  `protocol-conformance/bitchat-wire-v1.json`; they are not duplicated in the
  Electron host.
- The native host supports multiple subscribed BLE centrals. Text, receipts and
  public/private files are consumed by the reusable engine; newer packet
  families are relayed only when their bounded family policy accepts them.
- Electron radio IPC is restricted to a renderer owned by the application and
  loaded from its loopback origin.
- The QR action uses Android's signed `bitchat://verify` contract. QR codes
  expire after five minutes, expose public keys only and complete verification
  through the existing encrypted Noise session. The Desktop camera scanner and
  Android scanner can therefore verify either direction without duplicating
  identity or cryptographic logic.
- Desktop hides the Web Preview's multi-user test controls. Its persisted
  history is isolated under Electron's user-data directory and can be cleared
  without deleting the DPAPI-protected mesh identity.

The Windows radio exists while the desktop application is running. Closing the
application stops advertising; this feature is not a Windows background
service. The UI sends and receives native-format files/images, optimizes large
photos, and records/plays bounded voice-note files through the shared media
pipeline. It does not implement live push-to-talk, group management, boards,
prekeys, or courier storage. Those wire
families being relayable does not make their application workflows available.

See `../../docs/PLATFORM-FEATURES.md` for the exact parity and security matrix.

## Test with Android

1. Build and install the Android feature described in `../android/README.md`.
2. Enable Bluetooth and Nearby devices permission on the phone.
3. Start the Windows desktop application and keep it open.
4. Use the production mesh network on both clients and send a public message.
5. Verify reception in both directions, then test a private conversation after
   the Noise session is established.

The automated smoke test validates Windows advertising locally. Actual
PC-to-phone radio interoperability still requires a physical Android device in
range.
