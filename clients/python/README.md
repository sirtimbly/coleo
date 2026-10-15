# Python Workbench — Rich CLI + Textual TUI

HTTP/WebSocket client for Coleo's Inbox, Tasks, Bugs, Brain, and Dashboard modules.
Inbox resolves the `inbox-triage` named view. Python never reads
Coleo databases/Maildir or invokes TypeScript at runtime. The Python project and
lockfile live at the repository root; client implementation and tests live here.

## Run from the repository root

Requires **mise** (Python 3.12.14) and **uv**. Dependencies are locked:
Rich 14.2.0, Textual 6.3.0, HTTPX 0.28.1, websockets 15.0.1.

```sh
uv sync --locked
export COLEO_API_URL=http://127.0.0.1:8091
# Optional for authenticated servers:
# export COLEO_API_KEY=your-key

uv run coleo-inbox --help
uv run coleo-inbox views --json
uv run coleo-inbox validate clients/python/src/coleo_inbox/fixtures/definition.json --json
uv run coleo-inbox --facet messages --limit 5
uv run coleo-inbox --facet messages --limit 5 --presentation cards
uv run coleo-inbox --facet messages --limit 5 --presentation timeline
uv run coleo-inbox --facet messages --tree --expand all --metadata overview
uv run coleo-inbox --facet messages --expand collapsed --width 45 --color never
uv run coleo-inbox --facet messages --pages 2 --json
uv run coleo-inbox tui --facet messages --limit 5
uv run coleo-inbox modules
uv run coleo-inbox tasks --status blocked --search migration
uv run coleo-inbox tasks --limit 25 --offset 25 --json
uv run coleo-inbox tasks show <full-task-id>
uv run coleo-inbox bugs --status open
uv run coleo-inbox bugs show <full-bug-id> --json
uv run coleo-inbox brain status
uv run coleo-inbox dashboard --json
uv run coleo-inbox tui tasks
```

The parent/shared fixture service must be started separately; this project does
not start or replace it. Default API URL without the environment variable is
`http://127.0.0.1:8080`. HTTP sends `X-API-Key` and Bearer when a key is supplied;
the current Coleo middleware uses **X-API-Key**. No key is placed in URLs.

Copy a displayed stable `@xxxxxxxx` reference (or full ID from JSON):

```sh
uv run coleo-inbox show '@xxxxxxxx'
# Writes: use seeded fixture messages for the bake-off.
# Repeat the listing's scope/window options so the selection is loaded.
uv run coleo-inbox mark-read '@xxxxxxxx' --facet messages --limit 5 --json
uv run coleo-inbox mark-read '@xxxxxxxx' --branch --facet messages --limit 5 --json
```

`show` uses the independent reference endpoint, regardless of search/cursor.
Thread references select all loaded selectable members. Message references select
one member, or loaded descendants with `--branch`. All requested references are
resolved before the first write. Sent-only context is explicitly reported as
skipped. A 409 is surfaced without automatically retrying writes. A successful
write is followed by a fresh HTTP snapshot.

### Installation without a checkout command

```sh
uv tool install .
coleo-inbox --help
```

The executable is `coleo-inbox`, **not** a replacement for an installed `coleo`.
Use `uv run …` when evaluating edits from this checkout.

## Domain modules

### Runtime module catalog

The CLI and TUI read an external JSON catalog at startup. Catalog changes require
an explicit TUI reload or a new CLI invocation, not a rebuild or reinstall.
The file is authoritative: removing an entry removes it from the launcher, and
bundled entries are not merged back in.

Default location:

- macOS: `~/Library/Application Support/Coleo/modules.json` (shared with the native
  app's default catalog).
- Other platforms: `$XDG_CONFIG_HOME/coleo/modules.json`, defaulting to
  `~/.config/coleo/modules.json`.
- `COLEO_CONFIG_DIR` overrides the configuration directory.

On first setup only, a missing default file is seeded from the package's
`resources/modules.json`. An explicitly chosen missing file is reported as an
error instead of replaced. There is no automatic file watcher.

```sh
coleo-inbox modules path                    # Print the active catalog path
coleo-inbox modules choose /path/modules.json # Validate, use in place, remember path
coleo-inbox modules reload --json           # Read current contents and list entries
coleo-inbox --catalog /path/modules.json modules
coleo-inbox --catalog /path/modules.json tui tasks
```

`choose` remembers the original file location in `python-client.json` in the
configuration directory; it does not copy the catalog. `--catalog` selects a
file for just that invocation. Python and macOS can read the same catalog file,
but remember their selected file locations independently.

In the TUI, **+ / Ctrl+O → Reload catalog / Choose catalog…** provides explicit
controls. The command palette also offers both actions. The picker shows the
active path. Reload failures retain the last valid launcher list and display the
error. Existing tabs keep their recipe, title, query, and session; new tabs use
the refreshed catalog.

The schema matches the native macOS catalog, for example:

```json
{
  "schemaVersion": 1,
  "modules": [
    {
      "id": "project-work",
      "title": "Project work",
      "description": "Browse project tasks",
      "symbol": "checklist",
      "renderer": "tasks"
    }
  ]
}
```

This registers `coleo-inbox project-work` and `coleo-inbox tui project-work` using
the Tasks implementation. Supported renderers are `messaging`, `tasks`, `bugs`,
`brain`, and `dashboard`. Messaging recipes require `namedView` and may specify
`facet`, `mailbox`, `brainCategory`, and `presentation`; explicit CLI flags take
precedence over those defaults. Host command IDs such as `modules`, `tui`,
`views`, `validate`, `show`, and `mark-read` are reserved. A new renderer still
requires Python code; catalogs are not executable plugins.

### Module commands

`modules [--json]` lists client modules without contacting the server; `views`
continues to list server-authored named Messaging views. Domain modules use their
own production APIs, not Inbox facet projections:

| Module | CLI | TUI |
|---|---|---|
| Tasks | `tasks [list]`, `tasks show <ID>` | Status/search filters, paged table, full detail |
| Bugs | `bugs [list]`, `bugs show <ID>` | Status/search filters, paged table, full detail |
| Brain | `brain [status]`, `brain start`, `brain stop` | Health/planning facts, Start/Stop buttons |
| Dashboard | `dashboard` | Brain, task, and bug summaries with counts by status |

Use `<module> --help` for offline command help. Collections accept `--search`,
`--status`, `--limit` (1–100), and `--offset`; use full IDs for domain details.
Domain output supports `--json`, `--width` (30–500), and `--color`. JSON preserves
complete API records inside versioned `module.collection`, `module.detail`,
`module.overview`, or `module.action` envelopes. A partial overview exits **2**
and includes per-source `errors`; invalid input or failed requests exit **1**.
Start/Stop are explicit writes, sent once without automatic retry.

Open any module with `tui inbox|tasks|bugs|brain|dashboard`. **Ctrl+O** or the tab
bar's **+** opens a searchable Textual module picker. Each opening creates an
independent document, including repeated instances of the same module. Tabs retain
their query, selection, page, presentation, and resized column widths. **Ctrl+W**
closes the active document and its owned work; **Ctrl+PageUp/PageDown** switches tabs.
The HTTP client stays open until the workbench exits. Modules are also available
in Textual's command palette.

Domain screens refresh every 15 seconds or with **Ctrl+R**. Search applies on
Enter; editing its draft cannot affect later pages until submitted. **Next** /
**Previous** page through 100 records at a time; **Ctrl+L** advances. Enter inspects
the focused record. Below 100 terminal columns, detail replaces the table and
Escape returns. Failed collection refreshes retain and label the previous
snapshot. Dashboard sources fail independently; unavailable values are shown as
errors rather than zeros. Tasks/Bugs currently support browsing and inspection;
editing workflows remain in the web client.

### Original CLI workflows

Tasks and Bugs support the original CSV export/import/editor workflow:

```sh
uv run coleo-inbox tasks csv-export ~/tasks.csv --filter not-completed
uv run coleo-inbox tasks csv-import ~/tasks.csv --json
uv run coleo-inbox bugs csv-export ~/bugs.csv --filter pending
uv run coleo-inbox bugs csv-import ~/bugs.csv
uv run coleo-inbox tasks csv-edit
uv run coleo-inbox bugs csv-edit --filter not-completed
```

Exports include all matching rows, without the interactive list's pagination limit.
Filters are `all`, `pending` (open bugs), and `not-completed` (excludes completed
tasks or resolved/closed bugs). Archived bugs are excluded. CSV uses the original
nine-column format, including `_original_*` columns and percent-escaped text.
Keep those original columns intact: imports update existing IDs, compare edited
fields against their original values, and report concurrent-change conflicts.
Name, status, notes, and order are editable; imports do not create or delete rows.
Changing order values changes relative ordering; merely moving unchanged CSV lines
does not. Existing TypeScript CLI exports remain compatible.

`csv-edit` chooses `COLEO_CSV_EDITOR`, then `COLEO_EDITOR`, then `EDITOR`, then `vi`.
Quoted editor paths and arguments work. Only a successful editor exit imports the
temporary file; temporary files are cleaned up afterward. Editor output goes to
stderr so stdout remains available for the command's result.

CSV commands provide Rich summaries or `--json` result envelopes. Invalid rows
exit **1** without writes; missing IDs or conflicts exit **2**, with successful
row updates reported explicitly. Import requests are never automatically retried.
These workflows require a server with `/api/tasks/csv` and `/api/bugs/csv` routes;
Python continues to use HTTP exclusively.

Task discussions are also ported:

```sh
uv run coleo-inbox tasks discussions <ID> --limit 20 --json
uv run coleo-inbox tasks discuss <ID> "A comment"
uv run coleo-inbox tasks discuss <ID> "A reply" --reply-to <comment-ID> --json
```

Discussion output uses Rich Markdown cards or JSON. Author identity uses Git's
configured email/name, falling back to `USER`, matching the original CLI.
### Task maintenance

```sh
uv run coleo-inbox tasks sync --verbose
uv run coleo-inbox tasks reparse --json
uv run coleo-inbox tasks unclaim --json
```

These commands run on the connected server using its configured workspace
(`COLEO_PROJECT_DIR`, then `COLEO_REMOTE_WORKDIR`, then the server's working directory).
Remote Arm Host workspaces are supported. The Python client's working directory
does not select the project.

- `sync` discovers `.project/plan.md` and its referenced plans, skips unchanged
  hashes, adds new tasks, and marks pending tasks complete when checked off.
  Existing active task states are preserved.
- `reparse` replaces all plan-sourced tasks and resets plan-file tracking while
  preserving manual tasks. Replacement plans are parsed before deletion, and
  database changes are transactional. Missing or failed plans leave stored tasks intact.
- `unclaim` resets claimed/in-progress tasks to pending and clears their assignee,
  claim time, and start time, matching the original bulk testing reset.

All three provide Rich summaries or `--json`; `--verbose` adds per-file details.
Reported plan errors exit **2**; request/input failures exit **1**. Requests are
sent once without automatic retry. Requires the updated server maintenance routes.

## Live UI

Textual native **Tabs**, **ContentSwitcher**, **OptionList**, **DataTable**, **Tree**,
**Input**, **Select**, **Markdown**, **Collapsible**, **Button**, modal and footer
widgets handle interaction and terminal lifecycle. Each document owns its controls
and sidebar beneath the tab strip. Sidebars start at 18 cells, tables at 64, and
lists/timelines at 34, with space reserved for detail. Drag dividers or focus them
and use Left/Right to resize. The Sidebar button toggles navigation; narrow
terminals hide it initially. Full message/record cards expose raw data under
collapsed Technical details.
Wide terminals show list/detail together; below 100 columns, Enter opens detail
and Escape returns to the collection. Tab reaches toolbar controls. At very
narrow widths toolbar rows scroll horizontally as controls receive focus.

| Intent | Key/control |
|---|---|
| Open another module | Ctrl+O or tab bar + |
| Close active tab | Ctrl+W or tab bar × |
| Switch tabs | Ctrl+PageUp / Ctrl+PageDown |
| Navigate | Up/Down or API-resolved j/k |
| Inspect full content | Enter |
| Back | Escape |
| Search | `/`, type normally, Enter applies |
| Facet/mailbox/Brain category/sort | Sidebar list and native dropdowns; Tab to focus |
| Select individual member | Space in grid |
| Select loaded branch | Ctrl+B or Branch button; Space in tree scope |
| Fold/unfold | Left/Right; native tree disclosure |
| Mark explicit selection read | Ctrl+R or Read button |
| Clear selection | Clear button |
| Refresh | API-resolved r or Refresh button |
| Load more | Ctrl+L or More button |
| Grid/cards/timeline | Presentation dropdown |
| Generated keyboard help | API-resolved `?`, F1 or ? button |
| Scoped metadata panel | `m` or Metadata button |
| Quit | Ctrl+Q or Ctrl+C |

API `client=tui` keyboard bindings are consumed using shared operation IDs;
host controls supply operations without TUI bindings in the current named view.
Scope guards leave text entry to Input/Select. Platform `primary` is mapped to
Ctrl because Meta delivery is terminal-dependent; this limitation is shown in
help. Selection and focus are distinct. Folding preserves selection. A changed
query clears selection. Refresh retains exact selected IDs **and their original
thread revision**, so newly arriving replies are not implicitly selected. A stale
revision is rejected by the service rather than silently upgraded.

The socket sends `{type:"auth",apiKey:"…"}`, waits for `{type:"auth",success:true}`,
then subscribes to relevant Coleo channels. Application-level ping every 20s
matches the server's heartbeat contract. Broadcasts only invalidate HTTP reads.
Burst invalidations coalesce into one refresh lane; query generations reject
obsolete results. Socket-only reconnect reauthenticates and reloads the active
window. Writes hold that lane. Failed/incomplete refreshes label retained stale
data and disable actions. There is no cross-source atomicity claim.

## CLI output and compatibility

The following named-view behaviors apply to Inbox; domain commands are described above.

- Flags, aliases, choices and help come from the resolved CLI interactions.
- Base filters/profile/query are inherited; mailbox/category transitions match
  the TypeScript options adapter. Host limits: 1–100 pages, width 20–300.
- Rich owns table widths, ellipsis, panels, tree/timeline and Markdown layout.
  CLI cards and timeline are visibly distinct; JSON preserves the server's
  declared fallback/diagnostics rather than rewriting the contract.
- Text uses short ages (`5m`, `2h`, `8d`) or compact dates, and mailbox labels
  such as `Inbox (5)`. Query-wide total/unread/action counts and source freshness
  are shown separately from the loaded count; unavailable counts say `unknown`.
  Table rows stay single-line with Rich ellipsis. Opaque continuation tokens are
  never printed in text: the footer points to `--pages` or `--json` for the cursor.
  Structured JSON retains full timestamps/cursors; message detail retains exact
  timestamp headers. Cards and full bodies may wrap intentionally within Rich.
- `NO_COLOR` is honored in auto mode; `--color always|never` overrides auto.
  Redirected auto output has no ANSI. JSON bypasses Rich entirely.
- Exit **0**: complete requested window/help, even when more pages exist;
  **2**: incomplete sources/counts or post-write refresh failure;
  **1**: invalid options, transport/reference/action failure.
- One-shot commands never open WebSockets or enter interactive terminal mode.
- Bundled definition is used only for explicitly labeled offline help, never as
  a fallback for actual Inbox content.

## Tests and fixture provenance

```sh
uv run --group dev pytest clients/python/tests -q

# Full suite including shared production-route fixtures and real PTY smoke:
# Owns port 8092, uses a non-dev API key, always terminates its server process.
# Enables fixture-only mutation tests (reset/add-reply/read); never use real mail.
uv run --group dev python clients/python/run-integration.py
# Override an occupied port with COLEO_FIXTURE_PORT=8093.

# Opt-in READ-ONLY integration once the parent's fixture server is running:
COLEO_TEST_API_URL=http://127.0.0.1:8091 \
  uv run --group dev pytest clients/python/tests/test_shared_server.py -q
```

`generate-fixtures.ts` is a **development-only** capture script importing the
actual named-view resolver, serializable Messaging registry, thread model and CLI snapshot implementation. It
writes only `src/coleo_inbox/fixtures/`. Run `bun
clients/python/generate-fixtures.ts` from the repository root when the
canonical protocol changes. No Bun/TypeScript dependency is needed to run the
installed Python client or its captured-fixture tests.

The tests compare whole Python JSON snapshots against TypeScript-generated
expected envelopes (all/roots/collapsed), exercise representative Unicode and
branching/sent-context messages, verify identity/cursor failures, exact writes,
stale revisions, selection stability, source failures, and 20/45/100-column Rich
output. Textual Pilot tests exercise actual widgets, selection, folds, input
guards, help, detail, presentation, resize, paging and actions. Local real HTTP
and WebSocket servers test auth headers, auth-before-subscribe, auth rejection,
80-hint bursts, socket-only reconnect recovery and task cancellation.

Original integrated verification: **60 passed in 12.13s**, Python 3.12.11 on macOS arm64,
against an owned shared fixture server on port 8092 with a non-dev API key.
The runner terminated its server afterward. Real PTY tests started Textual,
waited for authenticated live state, resized the terminal and quit using both
Ctrl+Q and Ctrl+C. Both verified exact termios restoration, alternate-screen
exit, zero process status and no traceback. Actual API tests assert the six
toolbar operations have `available=false` and empty TUI keyboard bindings, then
exercise their native controls without altering the resolved response. Fixture
mutations verify exact selected IDs, a 409 after an incoming reply, explicit
reselection/read success, skipped sent context, and revision invalidation after
another client's read even when membership is unchanged. These mutation tests
require `COLEO_TEST_FIXTURE_WRITES=1`, set only by the owned-server runner by
default. Without `COLEO_TEST_API_URL`, all three shared tests and two PTY cases
are skipped. `uv sync --locked` also
passed. The source-checkout `coleo-inbox --help` command successfully resolved
the running local API's current named-view definition.

Compact text presentation follow-up: **63 passed, 2 skipped in 10.99s** against
the already-running port 8091 fixture, with fixture mutations explicitly disabled.
The skipped cases are the two mutation scenarios; authenticated read-only API,
headless Textual and real PTY checks passed. Live CLI output was inspected at
100 and 45 columns. The shared 8091 process was neither restarted nor stopped.

Domain-module verification: **79 passed in 19.12s** with the owned integration
runner. Thirteen new tests cover domain CLI validation/JSON, command collisions, partial summaries,
record identity, TUI search/paging, detail refresh, stale-response rejection,
module switching, and Brain controls. Read-only checks against the local API
loaded 100 tasks, 92 bugs, and all three Dashboard sources. Brain write tests
use mocked HTTP; no live Brain start/stop was performed.

## Code tour

| File | Responsibility |
|---|---|
| `api.py`, `contracts.py` | HTTP/auth, query identity, references, hierarchy boundary |
| `options.py` | Definition-driven flags plus host options |
| `validation.py` | Offline schema-v1 validation/resolution against the captured Messaging registry |
| `snapshot.py` | Paging, response envelope, scoped metadata and diagnostics |
| `selection.py` | Frozen exact member/revision selection and writes |
| `presentation.py` | Rich renderables, safe text and detail content recipe |
| `session.py` | Ordered refresh, stale retention, WebSocket lifecycle |
| `app.py` | Native Textual composition and operation dispatch |
| `cli.py` | One-shot/TUI entry, JSON and exit statuses |
| `modules.py` | Domain registry, validated API envelopes, shared Rich/fact rendering |
| `module_catalog.py`, `resources/modules.json` | External catalog loading/validation and first-run defaults |
| `catalog_dialog.py` | Native Textual catalog-path chooser |
| `module_cli.py` | Tasks/Bugs/Brain/Dashboard commands and argument validation |
| `module_app.py` | Domain Textual screens, module picker, paging, refresh and detail workers |

## Explicit bounds / integration needs

- **Local `validate <path> [--json]` is offline and supports schema-v1 Messaging
  definitions against the captured registry.** The common raw definition resolves
  to the same complete JSON envelope as TypeScript. Validation checks known
  resources, fields, widgets, renderers, profiles, operations, commands, bindings,
  active references, layouts, duplicate IDs/flags, key conflicts, and host CLI
  collisions. Unknown references, extra schema fields and future schema versions
  are rejected. It does not discover custom server plugins or future registry
  extensions: regenerate fixtures and update the adapter when that boundary
  changes. This is bounded protocol parity, not a universal Zod implementation.
- TUI timeline is an explicitly labeled timestamp-ordered native tree fallback;
  cards use multiline native Tree rows. CLI uses actual Rich panels/timeline.
- The host controls implement the current Messaging recipe, not arbitrary future
  server-defined widgets. Unknown snapshot bindings/commands fail explicitly.
- The current named view has no keyboard binding for mark-read or filter facets;
  native controls and documented host shortcuts supply those actions.
- The Python validator is a bounded consumer boundary, not full generated
  Pydantic/OpenAPI coverage of every optional record/event payload.
- Real PTY startup/resize/quit restoration is tested on macOS arm64. A broader
  physical-terminal/macOS/Linux matrix remains untested.
- The shared server's production HTTP routes, native controls, revision-checked
  read actions, add-reply control and authenticated WebSocket lifecycle passed
  integration on owned port 8092. The fixture-control source-outage scenario
  remains a hands-on comparison step; local tests cover retained partial data.

Both candidates remain experiments; this implementation makes no winner claim.
