# Publishing and announcing the community preview

## Required positioning

Use this description consistently:

> BitChat Community Multiplatform Preview is an unofficial community
> distribution based on the original BitChat Apple source, a pinned official
> Android source, and an experimental Windows Desktop feature. It is under
> active development, has not received an independent audit as a complete
> distribution, and does not yet provide full feature parity.

Never use `official`, `fully secure`, `fully anonymous`, `production-ready`,
`complete parity` or `works on every PC` for a community release unless the
relevant upstream owner or independent evidence supports that exact claim.

## Release contents

| Asset | Audience | Requirement |
| --- | --- | --- |
| `bitchat-android-<version>-community-preview.apk` | Android testers | Production-signed and certificate-verified |
| `bitchat-desktop-<version>-windows-x64-setup.exe` | Normal Windows installation | Authenticode-signed |
| `bitchat-desktop-<version>-windows-x64-portable.zip` | Portable Windows use | Contains signed executables |
| `SHA256SUMS-*.txt` | Everyone | Verify before installation |
| `SOURCE-MANIFEST.txt` and provenance | Reviewers | Must match the release tag |
| Android source archive, GPL and notice | Android redistributors | Must accompany the community APK |

Debug APKs, unsigned Release APKs and unsigned Windows packages are local or CI
test outputs, never public release assets.

## Preview requirements

- Windows 10 or 11 x64 on a recent PC with a Bluetooth Low Energy adapter that
  supports the required GATT peripheral role.
- Android 8.0 / API 26 or newer with Bluetooth and Nearby devices permissions.
- The Windows application must remain open for its BLE radio to advertise.
- Real interoperability still depends on adapter, driver and phone behavior;
  publish only the combinations actually tested.

## Announcement checklist

- Link both official upstream repositories and `UPSTREAM.md`.
- Link the exact community release, source tag, checksums and verification instructions.
- State supported Windows architecture and Android minimum API.
- List the physical devices and operating-system versions actually tested.
- Link `PLATFORM-FEATURES.md`, `ROADMAP.md`, `SECURITY.md` and `PRIVACY_POLICY.md`.
- Explain that the Android community signature may conflict with an official installation using the same application ID.
- Invite contributors without claiming a team that has not been formed.

## Suggested short announcement

> BitChat Desktop Community Preview is now available for technical testing on
> Windows, together with a reproducible community build of the pinned official
> Android source. The original Swift source remains attributed to the upstream
> BitChat project. This is an unofficial prerelease: signed downloads,
> checksums, known limits and contribution areas are published with the source.
