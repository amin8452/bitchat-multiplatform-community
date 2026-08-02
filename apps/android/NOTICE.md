# Android source and license notice

The scripts in this directory belong to the additive platform integration in
this repository. They initialize or verify the official Android submodule from
the repository and exact commit recorded in `upstream.json`; the checkout is
kept under `android-app/` and is never rewritten by the integration.

The downloaded Android client is licensed separately under **GNU GPL v3**.
Its repository, exact revision and complete corresponding source are recorded
in `upstream.json`. Every generated Android distribution directory also
receives the upstream `LICENSE.md` as `LICENSE-GPL-3.0.md`.

The GitHub release workflow additionally exports the exact pinned Git tree as
`bitchat-android-<version>-source-<commit>.zip` beside the APK. Keep that source
archive, this notice, `upstream.json` and the GPL license with redistributed
release artifacts.

Do not describe the Android APK as covered only by the root Unlicense. Anyone
redistributing the APK must preserve the GPL notice and make the corresponding
source for the pinned revision available.
