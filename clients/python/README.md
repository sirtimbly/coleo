# Python Inbox candidate — Rich + Textual

HTTP/WebSocket client for Coleo's `inbox-triage` named view. Python never reads
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

## Live UI

Textual native **DataTable**, **Tree**, **Input**, **Select**, **Markdown**,
**Button**, modal and footer widgets handle interaction and terminal lifecycle.
Wide terminals show list/detail together; below 100 columns, Enter opens detail
and Escape returns to the collection. Tab reaches toolbar controls. At very
narrow widths toolbar rows scroll horizontally as controls receive focus.

| Intent | Key/control |
|---|---|
| Navigate | Up/Down or API-resolved j/k |
| Inspect full content | Enter |
| Back | Escape |
| Search | `/`, type normally, Enter applies |
| Facet/mailbox/Brain category/sort | Native dropdowns; Tab to focus |
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

Latest integrated verification: **60 passed in 12.13s**, Python 3.12.11 on macOS arm64,
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
