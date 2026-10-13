# Terminal bake-off: test both candidates

**Historical hands-on guide, 2026-10-09.** Both candidates were implemented and
tested against one shared fixture service. Tim has since selected Python/Rich +
Textual based on its visual quality and feature coverage. These instructions are
retained for reproducibility, not as an open decision checkpoint. See the
[concluded bake-off](./terminal-bake-off.md) and [active implementation plan](./implementation-plan.md).

## 1. Start the fixture service

Run these commands from the repository root. The implementation session left the
service running at **127.0.0.1:8091**; check before starting another copy:

```sh
curl -sS http://127.0.0.1:8091/api/health
# If it isn't running:
bun run e2e/support/terminal-bake-off/server.ts
```

The fixture service uses temporary storage, not your real project mailbox. Its
startup output names that directory. Stopping it removes that temporary state.
See `e2e/support/terminal-bake-off/README.md` in the repository for the complete
fixture implementation contract.

Configure **each terminal** where you run a candidate:

```sh
export COLEO_API_URL=http://127.0.0.1:8091
export COLEO_API_KEY=dev-terminal-bakeoff
```

TypeScript uses the repository's installed Bun dependencies (`bun install` after
pulling changes). Python requires `uv`:

```sh
uv sync --project experiments/inbox-python --locked
```

## 2. Run the four experiences

### TypeScript CLI

```sh
bun run src/cli/index.ts inbox --facet messages --limit 5
bun run src/cli/index.ts inbox --facet messages --limit 3 --presentation cards
bun run src/cli/index.ts inbox --facet messages --limit 3 --presentation timeline
bun run src/cli/index.ts inbox --facet messages --limit 2 --tree --metadata overview
bun run src/cli/index.ts inbox show @0fabce72
```

### TypeScript / OpenTUI

```sh
bun run src/cli/index.ts inbox tui --facet messages --limit 5
```

Use **Up/Down or j/k**, **Enter** for detail, **Escape** back, **Space** select,
**Left/Right** fold, **/** search, **r** refresh, **n** older roots, **m** metadata,
**?** help, and **:** for actions/filters/presentation. Select a menu item with
arrows + Enter. Query menu entries open an input with supported values in its
prompt. **Tab** switches panes. **q** or **Ctrl+C** quits outside text entry.

### Python / Rich CLI

```sh
uv run --project experiments/inbox-python coleo-inbox --facet messages --limit 5
uv run --project experiments/inbox-python coleo-inbox --facet messages --limit 3 --presentation cards
uv run --project experiments/inbox-python coleo-inbox --facet messages --limit 3 --presentation timeline
uv run --project experiments/inbox-python coleo-inbox --facet messages --limit 2 --tree --metadata overview
uv run --project experiments/inbox-python coleo-inbox show @0fabce72
```

### Python / Textual

```sh
uv run --project experiments/inbox-python coleo-inbox tui --facet messages --limit 5
```

Use **Up/Down or j/k**, **Enter**, **Escape**, **Space**, **Left/Right**, **/**,
**r**, and **?** for the same core intents. **Tab** reaches the native filter and
action controls. **Ctrl+B** selects a branch, **Ctrl+R** marks the selection read,
**Ctrl+L** loads older roots. **Ctrl+Q** or **Ctrl+C** quits. The footer and help
list these host-specific keys; neither framework's host keys are claimed to be
identical to the other client.

**m** or the Metadata button toggles the scoped metadata panel in Textual too.

Both CLI candidates accept `--width 45`, `--color never`, and `--json` for the
same comparison cases. Both support offline JSON view validation. Use the shared
source definition rather than the development-only captured Python fixture when
testing current definitions:

```sh
bun run src/cli/index.ts inbox validate src/workbench/examples/inbox-triage.json
uv run --project experiments/inbox-python coleo-inbox validate src/workbench/examples/inbox-triage.json
```

## 3. Exercise the same workflow

Start with the `review` conversation: reference **`@0fabce72`**. It has API and
terminal branches, a sent-only message, and unread children. `handoff` is read.
There are six Inbox roots, so a limit of five exercises paging.

1. Compare table, cards and timeline CLI output at 100 and 45 columns. Inspect
   full content using the reference without repeating list filters.
2. In each TUI, search, change mailbox, load the next page, inspect a reply, and
   navigate back. Try a wide split then resize below 100 columns.
3. Select the API branch, collapse it, and verify selection remains. Add a reply
   with the control below; selected IDs must not grow. Read should reject the old
   revision. Explicitly clear/reselect and retry against the new revision.
4. Trigger a mail outage, restore it, then disconnect only WebSockets. Watch source
   status, retained data, and reconnect recovery.
5. Quit and check that your shell echo, cursor, and normal screen are restored.

Run fixture controls from another terminal:

```sh
# Reset before comparing the second candidate's writes.
curl -sS http://127.0.0.1:8091/__test/control -H 'Content-Type: application/json' -d '{"action":"reset"}'
curl -sS http://127.0.0.1:8091/__test/control -H 'Content-Type: application/json' -d '{"action":"add-reply"}'
curl -sS http://127.0.0.1:8091/__test/control -H 'Content-Type: application/json' -d '{"action":"source-outage","source":"mail","enabled":true}'
curl -sS http://127.0.0.1:8091/__test/control -H 'Content-Type: application/json' -d '{"action":"source-outage","source":"mail","enabled":false}'
curl -sS http://127.0.0.1:8091/__test/control -H 'Content-Type: application/json' -d '{"action":"burst","count":80}'
curl -sS http://127.0.0.1:8091/__test/control -H 'Content-Type: application/json' -d '{"action":"disconnect"}'
```

These control commands use the fixture's default development key mode. For a
strict custom key add `X-API-Key`. Both clients can run simultaneously; shared
writes will invalidate the other client's selection revision as intended.

## 4. Codebase tour

### Common starting point

Read `src/workbench/examples/inbox-triage.json` first. It declares the query,
fields/presentations, hierarchy, toolbar groups, and interaction profile. Then:

1. `src/workbench/named-resource-views.ts` resolves it for each client.
2. `src/api/routes/workbench-named-views.ts` publishes it over HTTP.
3. `src/api/messaging-collection.ts` owns source projection and root paging.
4. `src/api/messaging-reference.ts` resolves short references independently of a list.
5. `src/api/routes/mail-threads.ts` owns revision-checked exact member mutations.

Neither candidate owns mail grouping, persistence, or server command authority.

### TypeScript path

| Start here | What to inspect |
| --- | --- |
| `src/cli/commands/inbox.ts` | Dispatch: snapshot, show, write, validate, or dynamically loaded TUI |
| `src/cli/inbox/options.ts` | Resolved flag names/aliases, typed values and query overrides |
| `src/cli/inbox/api.ts` | HTTP/auth and CLI/TUI response validation |
| `src/cli/inbox/snapshot.ts` | Paging, fields, reply rows, metadata, completeness |
| `src/cli/inbox/table.ts` | `cli-table3`, `boxen`, `wrap-ansi` composition plus Coleo column policy |
| `src/cli/inbox/terminal-theme.ts` | Chalk styling; no handwritten SGR construction |
| `src/cli/inbox/detail.ts` | Human-readable full content rather than JSON in text mode |
| `src/cli/tui/inbox/index.ts` | OpenTUI session setup, control dispatch, and cleanup |
| `src/cli/tui/inbox/components.ts` | Native Select/Input/ScrollBox/Box/Text layout |
| `src/cli/tui/inbox/session.ts` | Shared projection controller, query changes, detail generations, writes |
| `src/cli/tui/inbox/model.ts` | Focus, expansion and frozen selected IDs/revisions |
| `src/cli/tui/inbox/transport.ts` | Authenticated WS lifecycle, relevant hints and recovery |
| `src/cli/tui/inbox/controls.ts` | Menu execution capability versus keyboard-binding availability |

Follow a read action: native selection → `model.ts` captured targets/revisions →
`session.ts` mutation hold → existing `inbox/actions.ts` HTTP calls → controller
refresh → native widgets update. No new reply is silently added to selection.

The output library split is real: one-shot CLI uses **cli-table3/boxen/Chalk/
wrap-ansi**, while live UI uses **OpenTUI 0.1.107**. Domain/query/selection code is
shared, but CLI and TUI presentation composition is separate. `ink.ts` is now
only a compatibility re-export of `terminal-theme.ts`; the Ink framework is not
installed. OpenTUI was kept pinned to avoid conflating a large dependency upgrade
with this comparison. Newer upstream features are not assumed available here.

### Python path

All candidate files are under `experiments/inbox-python/`:

| Start here | What to inspect |
| --- | --- |
| `pyproject.toml`, `uv.lock` | Independent runtime/dependencies and executable |
| `src/coleo_inbox/cli.py` | CLI/TUI dispatch and exit behavior |
| `src/coleo_inbox/options.py` | Flags built from resolved interactions |
| `src/coleo_inbox/contracts.py` | Wire/query/hierarchy validation |
| `src/coleo_inbox/validation.py` | Offline schema-v1 validation using the captured registry |
| `src/coleo_inbox/api.py` | HTTP/auth, independent references and targeted detail |
| `src/coleo_inbox/snapshot.py` | Same JSON snapshot semantics and paging |
| `src/coleo_inbox/presentation.py` | Rich Table/Panel/Text/Markdown renderables and theme |
| `src/coleo_inbox/app.py` | Textual DataTable/Tree/Select/Input/Markdown/Button composition |
| `src/coleo_inbox/session.py` | Async refresh lane, WS recovery and retained partial data |
| `src/coleo_inbox/selection.py` | Captured revisions and exact selected-member writes |

Follow the same read action through Textual's button handler → `selection.py` →
`api.py` → `session.py` refresh → widgets. Rich/Textual provide more ready-made
widgets and Markdown presentation, but query normalization, selection and refresh
behavior have Python implementations that need conformance tests. The fixture
generator is development-only; Python execution never launches TypeScript.

### Small changes to compare

- **Add a displayed field:** shared view JSON, then inspect each presentation adapter.
- **Change appearance:** TS terminal theme/native widget styles versus Rich theme
  and Textual CSS. Compare how many files need edits.
- **Add a command:** common operation/API contract, then each client's execution
  adapter. Toolbar presence alone never grants mutation capability.
- **Add a shortcut:** common interaction profile, then verify both help screens
  and focus contexts; host-only keys are documented separately.
- **Change reconnect behavior:** shared TS controller versus Python session code;
  run both failure suites against the same fixture service.

## Differences to judge, not hide

| Area | TypeScript / OpenTUI candidate | Python / Rich + Textual candidate |
| --- | --- | --- |
| One-shot output | Several established libraries, small policy/composition layer | Cohesive Rich renderable API |
| TUI collection | Native selectable list; compact grid representation | Native DataTable and Tree |
| TUI full body | Wrapped native plain text, Markdown source readable | Native Markdown rendering |
| TUI timeline | Explicit cards/list fallback | Explicit native-tree fallback |
| Filters | Actions menu followed by typed value input | Native dropdown controls |
| Metadata | Interactive `m`/menu panel | Interactive `m`/button panel with explicit count/source scopes |
| Core semantics | Imports shared TypeScript models/controller | Equivalent Python code, checked against captured TS output |
| Packaging | Existing Bun/native OpenTUI install | Separate Python/uv environment |
| Offline validation | Canonical local registry | Captured Messaging schema-v1 registry, explicit unsupported/future rejection |

These are evaluation-ready candidates, not claims of full graphical renderer
parity. In particular, neither live TUI has a dedicated timeline widget yet.
The OpenTUI candidate does not claim Textual-equivalent widget coverage. This is
important evidence for the library choice, not a reason to conceal the fallback.
Shared fixture retained events are healthy but empty; real historical-event detail
coverage remains in the main API tests, not the fixture TUI tour.

## Verification and decision checkpoint

Latest integrated verification on macOS arm64:

- **47 TypeScript CLI/TUI/fixture tests, 1321 assertions** passed, including native
  widget tests, actual HTTP/WS behavior and real PTY startup/menu/action/quit checks.
- **66 Python tests** passed with the owned authenticated fixture runner, including
  whole-snapshot conformance, Textual Pilot interactions, live WS and PTY cleanup.
- Root TypeScript typecheck, documentation build, and whitespace checks passed.
- Both CLI candidates were run against the same persistent 8091 fixture service.

Re-run:

```sh
bun run typecheck
bun test --timeout 30000 src/cli/__tests__/inbox*.test.ts e2e/support/terminal-bake-off/server.test.ts
uv run --project experiments/inbox-python python experiments/inbox-python/run-integration.py
```

The Python integration runner owns port 8092 and cleans it up; it does not stop
your 8091 evaluation server. PTY checks verify Ctrl+C/normal quit restores terminal
attributes and leaves alternate screen. This is not a Windows/Linux test matrix.

Score visual quality, discoverability, keyboard behavior, code clarity, component
coverage, packaging friction and duplicated semantics separately. Record bugs
before ranking either candidate. **Decision: Tim selected Python/Rich + Textual.**
Neither candidate is removed until the Python client reaches the migration gates
in the implementation plan.
