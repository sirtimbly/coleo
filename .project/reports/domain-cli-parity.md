# Tasks, Bugs, Inbox, and Brain cutover audit

Date: 2026-10-16. Source audit: `server/src/cli/commands/{tasks,bugs,inbox,brain}.ts`,
Inbox option/action adapters, CSV helpers, task maintenance service, and Brain routes.
Shared worktree: owned domain files were clean before this work; unrelated existing
operator, transport, web relocation, and macOS changes were preserved.

## Implemented and verified

- `tasks list -s STATUS` now accepts the legacy alias. Explicit `tasks list` defaults
  to 20 rows; bare `tasks` retains its established 100-row module snapshot default.
  Flags before the positional operation also work. Bugs accepts `-s` as well.
- Explicit `tasks list` now sends `sort=created-desc`. The public task list API
  accepts only that supplied sort value; omission retains its existing workspace
  order. Newest-first ordering happens before SQL pagination, with ID ascending as
  a deterministic tie-breaker. Unicode fallback filtering preserves that order.
  Bare `tasks` and TUI collection calls do not send sort and retain current behavior.
- Brain human status now includes `pollIntervalMs`, previously omitted.
- Brain exposes existing API `pause`/`resume` alongside `start`/`stop`; all issue
  exactly one POST. Help identifies the selected API server and local operator path.
- Task help identifies server-workspace maintenance scope. Local daemon flags are
  rejected before HTTP, rather than silently interpreted as remote process options.

Tests (owned in-memory HTTP fixtures, temporary files/editor processes; no live server):

```text
uv run --extra tui pytest clients/python/tests/test_domain_parity.py clients/python/tests/test_csv_cli.py clients/python/tests/test_maintenance_cli.py -q
40 passed

uv run --extra tui pytest clients/python/tests/test_contract.py clients/python/tests/test_modules.py -q -k 'not textual and not old_detail and not module_picker'
48 passed, 4 deselected

# Follow-up: explicit task list ordering contract
bun test server/src/api/__tests__/task-list-sort.test.ts
4 passed (25 assertions, real in-memory SQLite with migrated schema)
bun test server/src/api/__tests__/tasks.test.ts
59 passed (212 assertions)
bun run typecheck
passed
uv run --extra tui pytest clients/python/tests/test_domain_parity.py -q
22 passed
uv run --extra tui pytest clients/python/tests/test_modules.py -q -k 'not textual and not old_detail and not module_picker'
9 passed, 4 deselected
```

The dedicated parity suite covers aliases/defaults, pagination, Brain controls and
failed writes without retries, status rendering, offline help, local-option rejection,
and Inbox views/local validation. Existing fixture suites cover CSV export/import/editor
success and failure, conflicts, discussions/replies/encoded IDs, maintenance partial
results, Inbox exact TypeScript snapshot fixtures, explicit read actions, stale
revisions, incomplete sources, and domain details. Installed-wheel testing remains
the integrator's release gate; this report does not claim it was performed.

## Exact command mapping

`old` below means `coleo`; replacements use `coleo-client` unless explicitly named.
All domain reads/writes now use the selected API connection, with no local database
fallback. Local CSV paths/editor and Git author lookup are intentional client I/O.
One-shot Python output retains its existing versioned JSON envelope or Rich display.
Input/transport errors exit 1, partial results exit 2, successful results exit 0.

| Old command / flags / defaults | Replacement | Source / side effect / pagination / differences |
| --- | --- | --- |
| `tasks sync [-v/--verbose]` | same suffix | POST `/api/tasks/maintenance/sync`, `{}`. Server workspace `.project/plan.md` and linked plans; inserts missing tasks, marks pending completed, tracks hashes, enables auto-discover if absent. `-v` controls file details locally. Legacy used caller cwd/local DB. Missing/invalid plans now return partial exit 2 rather than apparent success. |
| `tasks reparse [-v/--verbose]` | same suffix | POST `/api/tasks/maintenance/reparse`, `{}`. Server workspace; clears only plan tasks/tracking and reimports. Server validates every replacement plan before deletion (legacy deleted first). No pagination. |
| `tasks unclaim` | same suffix | POST `/api/tasks/maintenance/unclaim`, `{}`. Resets all claimed/in-progress tasks to pending and clears assignment/claim/start timestamps; no ID selection. `-v` additionally accepted. |
| `tasks list [-s/--status STATUS] [-n/--limit N=20]` | same suffix | GET `/api/tasks?limit=20&offset=0&sort=created-desc[&status=...]`. Preserves legacy newest-first ordering; equal creation times use stable ID ascending. Adds `--offset`, `--search`, JSON and explicit next offset. **Bounds delta below.** Legacy local missing DB swallowed error; Python reports API failure. |
| `tasks csv-export PATH [-f/--filter all\|pending\|not-completed=all]` | same suffix | GET `/api/tasks/csv/export?filter=...`; writes CSV to client path (supports `~`). Full CSV, no collection pagination. |
| `tasks csv-import PATH` | same suffix | POST `/api/tasks/csv/import` with CSV text; server imports names/status/order/notes using existing CSV service. Invalid rows exit 1; missing IDs/conflicts now exit 2 (legacy only invalid rows changed exit status). |
| `tasks csv-edit [-f/--filter ...=all]` | same suffix | Export → local temporary CSV/editor → one import after successful editor exit. `COLEO_CSV_EDITOR`, then `COLEO_EDITOR`, then `EDITOR`, then `vi`. Editor output goes to stderr; failed editor never imports. |
| `tasks discuss TASK MESSAGE [-r/--reply-to COMMENT]` | same suffix | POST `/api/tasks/{encoded-id}/discussions`; human author from Git name/email with USER fallback; `client=cli`; reply parent passed explicitly. Versioned JSON adds comment metadata; no pagination or implicit retry. |
| `tasks discussions TASK [-n/--limit N=20] [--json]` | same suffix | GET same discussions endpoint, `limit`, plus new `offset=0`. Preserves `discussions`/`totalCount` fields; adds schemaVersion/kind/module/taskId. Bound 1–100 rather than unchecked legacy number. |
| `bugs csv-export PATH [-f/--filter ...=all]` | same suffix | GET `/api/bugs/csv/export`; same local path/output behavior as Tasks. Server maps pending to open and not-completed to neither resolved nor closed. |
| `bugs csv-import PATH` | same suffix | POST `/api/bugs/csv/import`; same import/partial result rules as Tasks. |
| `bugs csv-edit [-f/--filter ...=all]` | same suffix | Export/editor/import sequence as Tasks. These are all operations registered by legacy `bugs.ts`; Python list/show are additional capabilities. |
| `inbox [view flags] [host flags]` | `inbox [same flags]` (also root snapshot) | GET named view then `/api/workbench/inbox`; same query normalization and opaque cursor behavior. Details below. |
| `inbox views [--json]` | `views [--json]` | GET `/api/workbench/named-views`; schemaVersion/views unchanged. **Drop the `inbox` prefix for this metadata command.** |
| `inbox validate PATH [--json]` | `validate PATH [--json]` | Reads/validates local JSON definition with no HTTP; resolved view JSON preserved. **Drop the `inbox` prefix.** |
| `inbox show REF [view/host flags]` | `inbox show REF [same flags]` (also root `show`) | Named-view lookup, encoded reference resolution, detail reads. Does not load/search the current collection to resolve REF. `inbox.detail` envelope, 0 complete / 2 incomplete. |
| `inbox mark-read REFS... [--branch] [view/host flags]` | `inbox mark-read REFS... [same flags]` (also root `mark-read`) | Loads bounded snapshot, validates explicit targets, posts revision-aware thread actions / attention bulk, then refreshes. No implicit mark-read on show. `inbox.action` retained; failure 1, post-write refresh/incomplete result 2. |
| `brain status` | `brain status` for remote orchestration; `coleo-server brain status` for local process | Python GET `/api/brain/status`, SQLite-backed orchestration state/counts/plan/model access. Legacy mixed local JSON state + DB counts with daemon fallback. API status is **not local process status**. |
| `brain run [-i/--interval MS=30000] [--cycles N] [-v/--verbose] [--once] [--clean] [--swarm-evaluation MODE] [--swarm-window-polls N]` | `coleo-server brain run` (operator-owned) | Local foreground polling/process cleanup/runtime options; never migrate to Python API commands. Operator must independently verify all flag mappings. |
| `brain start [--self-modify]` | `coleo-server brain start` (operator-owned) | Local background lifecycle; Python `brain start` instead POSTs `/api/brain/start` on selected server with `{}`. Not a transparent alias. |
| `brain stop [-f/--force] [-t/--timeout MS=5000] [--self-modify]` | `coleo-server brain stop` (operator-owned) | Local graceful/forced lifecycle; Python `brain stop` POSTs `/api/brain/stop` with no local daemon flags. |
| `brain restart [-f/--force] [-t/--timeout MS=5000] [--self-modify]` | `coleo-server brain restart` (operator-owned) | Local restart. No Python restart command or synthetic stop/start sequence. |
| `brain logs [-n/--lines N=50]` | `coleo-server brain logs` (operator-owned) | Local daemon log tail, not activity/transcript API. |
| `brain prompt:task` | retain legacy local diagnostic until operator diagnostic registration exists | Uses local DB, cwd, runtime directory and task-determination generator. No public API equivalent in audited routes. |
| `brain prompt:context [ID-OR-SUBJECT=next]` | retain legacy local diagnostic until operator diagnostic registration exists | Local DB/context generation; default selects pending task by priority/creation. No Python equivalent. |

Inbox host flags retained: `--view` (default inbox-triage), `--json`, `--cursor`,
`--pages` (1–100, default 1), `--profile` (attention/query profile, not connection),
`--tree`, `--expand collapsed|roots|all` (view default), `--branch`, `--metadata ID|none`
(view default), `--width` (20–300, terminal default), `--color auto|always|never`
(auto, honors NO_COLOR), `--help/-h`. View-defined search/facet/mailbox/brain-category/
limit/sort/presentation flags and aliases still come from the resolved view, not a
hardcoded legacy list. No streaming; `--pages` bounds cursor traversal. Human output
uses Rich rather than the old text formatter; JSON snapshot fixture parity passes.

## Cutover recommendation and remaining differences

- **Bugs:** all three legacy registrations are replaceable by the table above after
  installed-client verification. No remaining local Bugs command.
- **Tasks:** every legacy action has an API-backed Python replacement. Sync/reparse
  intentionally operate on the server workspace and use the safer existing server
  maintenance contract. Explicit list defaults/short flags and newest-first ordering
  now match. **The ordering blocker is closed:** `sort=created-desc` is validated
  against a fixed supported value and ordered in SQL before pagination; omission
  leaves default API ordering unchanged. Python limit remains 1–100 (legacy unchecked
  SQLite LIMIT; API permits up to 500): document bounded pagination at cutover.
  No remaining missing task action; installed-client verification still gates retirement.
- **Inbox:** registration replaceable; migration text must map `views`/`validate`
  to root client commands explicitly. Existing JSON contracts are preserved.
- **Brain:** do not retire the whole family based on API controls. Operator lifecycle
  replacement is a separate track; prompt diagnostics still need retained registration.
  API `pause`/`resume` are extra controls, not legacy daemon commands. The existing
  API start/stop routes do manage the server's process; the distinction is target
  host, transport, options, and available local diagnostics, not merely state toggles.

## Retained local operations disposition

These are explicit **retain in transitional local CLI pending operator migration**
recommendations, not claims that new operator names already exist. None should be
replaced by a generic HTTP passthrough or selected-client local DB access.

| Operation | Source/side effects | Disposition |
| --- | --- | --- |
| Brain `prompt:task`, `prompt:context [task]` | Local DB/workspace prompt generation | Operator diagnostics; retain old registration until implemented there. |
| `debug intent MESSAGE [-s/--subject=Test message] [-v] [--mock-arms=...]` | Local model/harness intent processing, configurable mock arm context | Operator/developer harness diagnostic; retain. |
| `debug intent-batch [-v]` | Local model/harness batch diagnostic | Operator/developer diagnostic; retain. |
| `branch create TASK [-n/--name] [-b/--base=master]` | Local git branch/worktree mutation | Local operator workflow helper; retain. |
| `branch commit TASK [-m/--message]` | Organizes/stages/commits local changes | Local operator workflow helper; retain. |
| `branch push [BRANCH] [-f/--force]` | Pushes repository branch (current branch default) | Local git workflow, not client API; retain. |
| `branch pr-draft TASK [-t/--title] [-d/--description]` | Reads local git commits/files, writes PR draft | Local operator workflow helper; retain. |
| `branch workflow TASK [-n/--name] [-b/--base=master] [--push] [--draft]` | Composite branch/commit/optional push/draft | Local operator workflow helper; retain. |
| `status-reports backfill [--project=CWD] [--task-id=historical-status-reports] [--arm-id=human] [--dry-run]` | Reads `.project/status-*.md`, initializes local DB, idempotently creates task/report rows; dry run still initializes DB | Server operator maintenance job; retain until operator command or bounded server-owned workspace job exists. Not migrated by task sync. |
| `discoveries summarize [-t/--task SUBJECT-OR-ID] [-v/--verbose]` | Local DB discovery/task selection and LLM summarizer diagnostics; can use mock task | Retain operator diagnostic; discovery list/resolve/history belong to the other agent and do not imply summarizer parity. |

Other host processes (`serve`, `agent`, `web`, `imap`, `mcp`) and local initialization
remain operator/integrator scope. Arm local logs and remote activity mapping belong
  to the remote-family report. No TypeScript registration changes were made here.

Changed files: `module_cli.py`, `modules.py`, dedicated `test_domain_parity.py`, and
this report; follow-up also changes `server/src/api/routes/tasks.ts` and adds
`server/src/api/__tests__/task-list-sort.test.ts`.
Suggested commit: `fix(client): close task and brain command parity gaps`.
