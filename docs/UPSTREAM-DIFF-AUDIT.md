# Apple upstream difference audit

## Provenance decision

The community `main` branch is anchored to the official BitChat Apple tag
`v1.7.1` (`9edb7c26ef7bdcf3bb29e7907b38997f8d5cd0fa`). The supplied workspace had no
Git metadata, so this is a transparent history anchor matching the declared
Apple version, not a claim that the supplied ZIP was identical to that tag.

## Current tracked difference snapshot

Before the first community commit, Git reports:

- 86 modified upstream-tracked files (including the community line-ending policy);
- 4 deleted upstream-tracked files;
- community additions remain new files until committed;
- no working file was changed while attaching the official history.

Tracked differences by top-level area at the audit point:

| Area | Changed paths |
| --- | ---: |
| `bitchat/` | 50 |
| `bitchatTests/` | 27 |
| `.github/` | 4 |
| `localPackages/` | 3 |
| root/configuration files | 6 |

Files absent relative to the official anchor:

- `bitchat/Utils/SafeRegex.swift`
- `bitchatTests/NicknameNormalizationTests.swift`
- `bitchatTests/Services/SafeRegexTests.swift`
- `localPackages/BitFoundation/Tests/BitFoundationTests/DeliveryStatusNotSentYetTests.swift`

These differences predate or accompany the community workspace and must be
reviewed as code changes; they must not be described as untouched official
source merely because the history is now connected.

## Review commands

```powershell
git diff --stat v1.7.1
git diff v1.7.1 -- bitchat bitchatTests localPackages
git status --short
```

Do not restore or discard these paths mechanically. Review their behavior and
tests, then document accepted differences in the first community commit and
release notes.
