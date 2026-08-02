# BitChat Android (feature native additive)

Community releases build an exact official-source revision but are not official
upstream binaries. Public `platform-v*` releases require a verified production
signature; Debug and unsigned APKs are for local validation only.

Android uses the official Kotlin client rather than a WebView or a second
JavaScript port. `android-app/` is a Git submodule and `upstream.json` pins the
reviewed revision used by automation. `setup.ps1` initializes or verifies that
official checkout. The original Swift tree and the official Android checkout
remain untouched.

This pin supports the official Android application and its native message,
Noise, Nostr, file and voice paths. It is not identical to the newer Apple wire
surface: courier envelopes, board posts, prekey bundles, group messages,
ping/pong and Nostr carrier packets are absent from its `MessageType` enum, and
the Apple group/vouch Noise payloads are absent as well. The shared contract
tests preserve Android's supported subset without modifying or overstating it.

## Build on Windows

JDK 21 and Android SDK API 37 are required. `build-debug.ps1` prefers the
isolated toolchains under `.external/toolchains/jdk-21` and
`.external/android-sdk`; otherwise it uses `JAVA_HOME` and
`ANDROID_SDK_ROOT`.

```powershell
cd apps\android
.\build-debug.ps1
```

The script verifies the exact Windows AAPT2 binary pinned by
`windows-toolchain-lock.json`, runs Android lint, builds the debug variant and
copies the universal phone APK to:

```text
apps\android\dist\bitchat-debug.apk
```

Run the upstream unit suite separately when required:

```powershell
.\build-debug.ps1 -RunTests
```

At the pinned revision, APK packaging succeeds on Windows. The upstream lint
task completes but its own configured report still contains existing findings;
inspect `android-app/app/build/reports/lint-results-debug.html`.
Part of the upstream Robolectric suite also fails on Windows (notably
SQLite-backed and timing-sensitive tests). The script reports test failures
without deleting the already generated APK.

For a local Release build, use:

```powershell
.\build-release.ps1
```

Without signing variables this produces `bitchat-release-unsigned.apk` for
local validation only. A distributable APK requires the five Android secrets
listed in `../../docs/RELEASING-PLATFORMS.md` and:

```powershell
.\build-release.ps1 -RequireSigning
```

The signing script verifies the APK after signing and removes its temporary
keystore. See `NOTICE.md` before redistributing an Android artifact.

## Install on a phone

Enable Developer options and USB debugging, connect and authorize the phone,
then run from the repository root:

```powershell
.\.external\android-sdk\platform-tools\adb.exe devices
.\.external\android-sdk\platform-tools\adb.exe install -r .\apps\android\dist\bitchat-debug.apk
```

If a store-signed build with the same package name is already installed,
Android may reject the debug signature. Do not uninstall it unless you accept
losing its local application data.

For BLE verification, grant Nearby devices/Bluetooth permission, keep the
Windows desktop application open, and test public then private messages in both
directions. A real transport test needs a physical phone; an emulator cannot
prove BLE radio interoperability.
