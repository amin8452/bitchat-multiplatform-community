# Community multiplatform roadmap

This roadmap describes the unofficial community additions. It does not make
commitments on behalf of the upstream Apple or Android maintainers.

## Preview release gate — required

- Preserve official source attribution and Android GPL v3 corresponding source.
- Publish Android only as a verified production-signed Release APK.
- Publish Windows only as signed executables, a signed installer and a portable ZIP.
- Replace inherited Electron metadata with community-preview identity.
- Pass CI, dependency audits, CodeQL, checksums and build provenance.
- Pass the physical Windows 10/11 ↔ Android matrix documented in
  `docs/RELEASING-PLATFORMS.md` using downloaded release assets.
- Publish accurate limitations, privacy behavior and a private security-reporting path.

## Preview stabilization

- Resolve remaining BLE discovery/reconnect differences across adapters and phones.
- Profile and improve large image and voice-note transfer latency.
- Add installer upgrade/uninstall testing and a documented manual update path.
- Expand accessibility, localization and failure-state coverage on Desktop.
- Obtain an independent review of the new Desktop IPC, BLE relay and release pipeline.

## Capability work

- Evaluate native Desktop workflows for live push-to-talk.
- Evaluate groups, boards, prekeys and courier storage without claiming relay support as UI parity.
- Keep the shared protocol contract aligned with upstream Apple and Android changes.
- Add features only when interoperability, limits and security tests exist first.

## Help wanted

The project is seeking contributors for Windows Bluetooth, Android
interoperability, security review, accessibility, localization, release
engineering and documentation. See `CONTRIBUTING.md` and `TEAM.md`.
