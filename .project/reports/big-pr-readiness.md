# Workbench and component distribution PR readiness

Reviewed: 2026-10-16.

## Verdict

PR [#123](https://github.com/sirtimbly/coleo/pull/123) is open for review.
The outstanding implementation is being included with the API-only hosting
correction, and macOS notifications have a separate commit. Merge readiness still
depends on GitHub checks and review of the breaking command migration.

## Branch and scope

- Branch: `codex/workbench-resource-view-foundation`.
- After fetching origin: 15 commits ahead of `origin/master`, zero behind.
- Proposed full worktree diff at inspection: 1,142 files, 39,660 insertions,
  2,618 deletions, including 815 detected renames. This includes the earlier
  monorepo moves and workbench/client commits, not just the installer work.
- Uncommitted diff at inspection: 397 files, 9,189 insertions, 853 deletions,
  including 281 renames from the web-client relocation.
- Counts exclude the commit-message and readiness documents added by this review.
- Inspected new client/server/installer paths contain no untracked files over 1 MB.
  The file/rename inventory was computed using a temporary Git index; the actual
  staging area was left untouched.

## Suggested PR title

`feat(workbench)!: ship multi-client workspaces and separate operator tools`

Review the PR in these groups:

1. Repository layout and web-client relocation.
2. Shared Inbox/resource contracts, API routes, and client command migration.
3. Python and macOS multi-module workspaces.
4. Operator configuration, lifecycle, and process recovery ownership.
5. Component installers, artifact production, and release automation.
6. Migration documentation and regression tests.

## Commit scope

Use `component-cli-commit-message.txt` for the outstanding operator/client/install
work. Preserve the separate macOS notification feature as its own commit:

`feat(macos): add configurable message notifications`

That feature comprises `ColeoInboxApp.swift`, `MessageNotifications.swift`,
`MessageNotificationTests.swift`, and `clients/macos/NOTIFICATIONS.md`.
The macOS packaging scripts belong with component distribution, not notifications.

## Verification

Previously completed and recorded in `component-cli-installation-verification.md`:

- 271 Python tests, including the owned API fixture and terminal coverage.
- 1,422 Bun unit tests plus 33 integration tests; 19 existing TODOs.
- Additional final operator hardening tests and live isolated API/NATS/agent lifecycle.
- 12 bootstrap/manifest tests and 8 Go installer tests under the race detector.
- Real macOS arm64 installed artifacts, CLI/TUI isolation, profile routing, and uninstall.
- Server/web/docs builds, TypeScript checks, shellcheck, and workflow YAML parsing.

New checks in this readiness review:

- `swift test` in `clients/macos`: 34 passed, including message notifications.
- `bun run --cwd clients/web lint`: passed.
- `git diff --check`: passed.

## Breaking changes and release gates

The commit and PR title use `!`: migrated API-backed `coleo` commands now direct
users to separately installed `coleo-client`; JSON consumers need the documented
command contracts. API static hosting is removed; the installed web component
is launched with `coleo-client web`. Arm recovery requires recorded
ownership; legacy unrecorded arms are not automatically adopted.

Other-platform native installer verification remains a release CI gate. Apple
signing/notarization is conditional on credentials; it is not claimed as locally
verified. Existing releases do not contain the new installer assets; the published
installation path becomes usable with the first component release.
