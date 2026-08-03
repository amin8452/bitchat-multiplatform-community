# Contributing

Keep platform additions isolated under `apps/` and reuse the portable core in
`web-preview/`. Do not copy packet constants: update the reviewed contract in
`protocol-conformance/bitchat-wire-v1.json` and its conformance tests instead.

## Local checks on Windows

Use Node.js 22.12 or newer, .NET SDK 8, JDK 21 and Android SDK API 37.

Initialize the official Android submodule after cloning:

```powershell
git submodule update --init --recursive
```

```powershell
.\apps\android\setup.ps1
npm --prefix web-preview ci
npm --prefix web-preview run build
npm --prefix web-preview test
npm --prefix apps\desktop ci
npm --prefix apps\desktop run prepare:runtime
npm --prefix apps\desktop test
.\apps\android\build-debug.ps1
```

Generated dependencies, toolchains, runtime files, APKs and Desktop packages
are ignored. The Android source is represented by its Git submodule commit.
Never commit signing certificates, passwords, local identities or other
secrets. Submit focused changes and describe which automated and physical tests
were run.

See `docs/PLATFORM-FEATURES.md` for the supported surface and
`docs/RELEASING-PLATFORMS.md` for publication rules.

## Joining the community team

Start with an issue describing the platform area and validation you can own.
Maintainer roles and review expectations are listed in `TEAM.md`; no affiliation
with the upstream maintainers is implied.
