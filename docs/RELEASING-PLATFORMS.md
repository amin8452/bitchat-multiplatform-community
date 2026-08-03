# Releasing the additive Windows and Android features

Platform artifacts are published as **prereleases** until their signed builds
pass the physical Windows-to-Android test matrix. The original Apple release
process remains independent.

## What is tracked

- Web and Desktop source, build scripts and lock files are tracked here.
- `android-app/` is the official Android Git submodule.
  `apps/android/upstream.json` independently pins its exact source revision,
  and `apps/android/setup.ps1` initializes or verifies it without patching it.
- Generated APKs, portable Desktop folders, installers and signing keys are not
  committed. GitHub Releases stores the generated assets.
- The repository root is Unlicensed. The downloaded Android application and
  its APK remain licensed under GNU GPL v3; publish its generated corresponding
  source archive, `NOTICE-android.md`, `android-upstream.json` and
  `LICENSE-GPL-3.0.md` with that APK.

## Repository protection

Enable branch protection for `main` and require these checks:

- `Web core`
- `Windows desktop`
- `Android native`
- both `Platform CodeQL` jobs

Also enable GitHub secret scanning, push protection and Dependabot alerts.

## Signing secrets

Store all values as GitHub Actions repository or environment secrets. Never put
them in a workflow, source file, issue or release note.

| Secret | Purpose |
| --- | --- |
| `WINDOWS_CERTIFICATE_BASE64` | Base64-encoded Windows Authenticode PFX |
| `WINDOWS_CERTIFICATE_PASSWORD` | PFX password |
| `ANDROID_KEYSTORE_BASE64` | Base64-encoded Android JKS/keystore |
| `ANDROID_KEY_ALIAS` | Android signing key alias |
| `ANDROID_KEYSTORE_PASSWORD` | Android keystore password |
| `ANDROID_KEY_PASSWORD` | Android private-key password |
| `BITCHAT_GITHUB_RELEASE_CERT_SHA256` | SHA-256 certificate fingerprint embedded by the pinned Android build |

The Windows workflow requires signatures on the portable executables before
archiving and on the installer. The Android workflow requires all five Android
secrets and publishes only a verified signed Release APK. Missing signing
material fails the public release; Debug artifacts remain limited to the
validation workflow and are never attached to a `platform-v*` release.

## Create a prerelease

1. Make sure the validation and CodeQL workflows pass on `main`.
2. Update `CHANGELOG.md` and the version in `apps/desktop/package.json`.
3. Create and push an annotated preview tag such as
   `platform-v0.1.0-preview.1`.
4. The `Release Windows and Android` workflow builds, hashes, attests and
   publishes the assets as a GitHub prerelease. It also includes the separately
   attested root source manifest when that tag workflow has completed.
5. Verify `SHA256SUMS-windows.txt`, `SHA256SUMS-android.txt`, the GitHub
   attestations and both platform signatures before installation.

For a manual retry, run the workflow with an existing `platform-v*` tag. It
updates that release's assets without creating an unrelated source revision.

## Required release-gate tests

Run these tests using the downloaded release assets rather than local build
folders:

- clean installation and uninstall on a current Windows 10 x64 PC;
- clean installation on a current Windows 11 x64 PC;
- Android install or upgrade on at least two supported physical phones;
- Bluetooth discovery in both directions after permission denial/regrant;
- public text, private Noise text, delivery/read receipts and QR verification;
- public/private image and bounded voice-note transfer in both directions;
- reconnect after Bluetooth toggle, sleep/wake and app restart;
- invalid, oversized and interrupted transfers without a crash;
- signature and checksum verification on every distributed binary.

Do not call a prerelease production-ready until this matrix passes and the
remaining capability gaps in `PLATFORM-FEATURES.md` are accepted or closed.
