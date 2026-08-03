# Official sources and community additions

This repository is an **unofficial community multiplatform preview**. It is not
an official release channel of the upstream BitChat maintainers.

## Apple source

The original Swift application comes from:

- repository: <https://github.com/permissionlesstech/bitchat>
- community history anchor: official tag `v1.7.1`, commit
  `9edb7c26ef7bdcf3bb29e7907b38997f8d5cd0fa`
- local bundle identifier: `chat.bitchat`
- local marketing version: `1.7.1`
- root license: Unlicense

The workspace was originally supplied without its Git metadata. The community
`main` branch is therefore anchored to the matching official `v1.7.1` tag so
the upstream history is preserved, while all current workspace differences
remain visible in the future community commit. This anchor does **not** claim
that the supplied ZIP was byte-for-byte identical to that tag. The official
repository is configured locally as the read-only-intent `upstream` remote; a
separate community fork should be configured as `origin` for publication. See
`docs/UPSTREAM-DIFF-AUDIT.md` for the required review of those differences.

## Android source

The Android client is linked as the `android-app/` Git submodule:

- repository: <https://github.com/permissionlesstech/bitchat-android>
- pinned commit: `49753ccb888531bfc413431e7002b0776a8268f0`
- local application ID: `com.bitchat.droid`
- local version: `1.7.5` (`versionCode` 36)
- license at the pinned revision: GNU GPL v3

`apps/android/upstream.json` is the machine-readable source of this pin. The
build and release scripts verify it and publish the corresponding source beside
every community-built APK.

## Community additions

The portable Web core, Windows Desktop host, native Windows BLE/DPAPI sidecar,
platform workflows and documentation are community additions. They do not
imply endorsement by the upstream maintainers. Their exact capability and
security boundaries are documented in `docs/PLATFORM-FEATURES.md`.
