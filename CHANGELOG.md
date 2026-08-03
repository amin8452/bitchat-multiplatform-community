# Changelog

All notable changes to the additive Web, Windows and Android platform features
are documented here. The original Apple history remains in Git.

## 0.1.0-platform - Unreleased community preview

### Added

- Portable Web protocol core with BitChat packets, Noise sessions, Nostr,
  bounded media transfer and contract tests.
- Windows Electron feature with a native BLE GATT and DPAPI sidecar, QR
  verification, media support and a portable package.
- Reproducible build of the pinned official Android client without modifying
  its checkout.
- Optional Windows and Android code signing, Windows installer generation,
  GitHub Actions validation, CodeQL, dependency updates and attested prerelease
  assets.
- Explicit unofficial-preview identity, official-source attribution, Android
  submodule linkage, strict signed-release gates and community governance files.

### Known limits

- Full push-to-talk, groups, boards, prekeys and courier-storage workflows are
  not implemented in the Windows interface.
- The pinned Android revision does not expose every recent Apple packet family.
- Physical BLE interoperability and production signing must be validated on
  the exact release artifacts before promoting a prerelease.
