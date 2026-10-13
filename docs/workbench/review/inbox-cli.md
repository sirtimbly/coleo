# Named Inbox CLI snapshots

**Milestone 1d, implemented 2026-10-08.** `coleo inbox` is the first actual terminal consumer of the
workbench's named-view API. It fetches HTTP snapshots and exits; it opens no socket,
database, Maildir, or JetStream connection. The next slice is the live TUI (1e).

**Status update:** this Bun implementation is the current behavioral reference,
not the selected long-term terminal runtime. Python/Rich + Textual is selected;
the Bun CLI remains supported during Python parity work and is deprecated only
after the explicit migration gates in the [implementation plan](./implementation-plan.md).
The former `coleo inbox tui` OpenTUI candidate has been removed; the separate
Arms dashboard still uses OpenTUI.

## Command contract

```sh
coleo inbox --help
coleo inbox views
coleo inbox --view inbox-triage
coleo inbox --facet messages --limit 5 --json
coleo inbox --mailbox archive --search review
coleo inbox --brain-category operations --sort asc --limit 2
coleo inbox --facet messages --limit 2 --pages 2 --tree
coleo inbox --facet messages --expand roots --metadata overview
coleo inbox validate ./src/workbench/examples/inbox-triage.json
```

During source development, use `bun run src/cli/index.ts inbox ...` for the same
commands. `COLEO_API_URL` selects the API; `COLEO_API_KEY` (or `COLEO_API_TOKEN`)
is sent in the normal `X-API-Key` header. A request has a 15-second timeout.
Credentials are not included in output or diagnostic messages.

The CLI first resolves `/api/workbench/named-views/:id?client=cli`. It builds its
view flags and command names from that response's interaction definitions,
validates values through the shared typed invocation helper, then calls the
existing `/api/workbench/inbox?query=...` collection endpoint. Renaming an alias
in a definition changes accepted flags and generated help together. Unknown
flags/commands and collisions with CLI host options are errors.

For the builtin `inbox-triage`, view flags are:

| Flag | Meaning |
| --- | --- |
| `--search`, `-s` | Normalized search within the query |
| `--facet` | `attention`, `messages`, `brain`, `arms`, `history`, or `all` |
| `--mailbox` | `inbox`, `sent`, or `archive`; selects the messages facet |
| `--brain-category` | Brain category; selects the brain facet |
| `--sort` | Timestamp direction, `asc` or `desc` |
| `--limit` | Root items per page, 1–200 |
| `--presentation` | `grid`, `cards`, or `timeline`; fields come from that presentation |
| `--help`, `-h` | Generated help |

Explicitly incompatible facet/mailbox/category combinations are rejected,
independent of flag order. Repeated flags or their aliases are rejected. Values
beginning with a dash use `--flag=value`. Named filters and query defaults remain
part of the query; a renderer, metadata, or tree change does not change query
identity or cursor semantics.

Host options are `--view`, `--json`, `--profile`, `--cursor`, `--pages`, `--tree`,
`--expand`, `--metadata`, `--branch`, `--width`, and `--color`. `--profile` chooses the attention profile;
it is not an authentication option. `--expand collapsed|roots|all` implies a tree
and otherwise uses the named hierarchy default. `--metadata <id>` enables a
declared panel, or `none` closes it. Terminal charts/cards/timelines use declared
text fallbacks and expose their diagnostics.

Help can fall back to a known bundled definition when the API is unavailable,
with an explicit notice on stderr. Snapshots never fall back to local storage.
`validate` accepts JSON and uses the same headless view validation without an API
request. This does not select the broader YAML/JSONC authoring format or install
the file as an active server definition.

## Text and JSON output

Text uses a compact scope/count/freshness header and the resolved renderer.
`--presentation grid` uses an aligned, terminal-width table. Subjects receive
the most space; state flags become a single
State column, dates use readable ages, and source labels are compacted. Low-priority
columns are omitted with a notice at narrow widths. Every message occupies one
physical line with Unicode-aware ellipsis truncation instead of wrapping.
`--width 100` overrides detected terminal width; `COLUMNS` and an 80-column fallback
are used when stdout has no width. Terminal escape/control sequences are removed.

`--presentation cards` uses boxed stacked text entries with readable subjects,
source/age facts, and wrapped previews. The registered Timeline presentation
resolves to a plain stacked-list text fallback with visible diagnostics, rather
than silently rendering another grid. Both respect selected fields, reply ancestry,
terminal width, and stable references. These are terminal text presentations of
the same data, rather than the browser's Adaptive Card SDK or graphical timeline.
JSON remains structured data rather than painted terminal output. Presentation
changes do not change the query or item ordering.

Cards have colored title bars, resource icons, state diamonds/dots, and box-drawn
frames. Timeline text has date dividers, a vertical spine, state points, colored
title bands, and readable preview text. Shapes carry meaning without color:
`◆` needs action, `●` unread, `○` read. Padding/truncation happens before applying
ANSI styles, so escape bytes cannot break terminal alignment.

`--color auto|always|never` controls ANSI. Auto colors interactive terminals,
respects `NO_COLOR`, and supports `FORCE_COLOR`; piped output is uncolored by
default. `--color always` explicitly enables styling when capturing output, and
`--color never` disables it. JSON is never decorated with ANSI.

The Ref column uses stable short references such as `@cdbd0616`. They can be used
with `show` without repeating list filters; `mark-read` still resolves within an
explicit loaded query/window. References are resolved exactly with collision
checks. They are derived from canonical IDs, not row numbers, so sorting
or newly arriving messages cannot redirect a reference to a different resource.
Full IDs, full field values, per-page times, and opaque continuation cursors remain
in `--json`. The default text view does not dump long IDs or base64 cursor tokens.

`--tree` adds loaded replies in their actual parent/child order, respecting the
selected expansion mode. Query paging counts roots, not replies. JSON always
retains complete loaded thread projections, including revisions, parent IDs,
coverage, and context locations, even when text is folded.

The JSON envelope is ordinary versioned data:

```text
schemaVersion: 1
kind: inbox.snapshot
view: resolved named definition, features, and interactions
query: normalized effective query
presentation: chosen ID, implementation, and fields
pages: portable collection responses, each with its own source boundaries/freshness
items: unique loaded root items
rows: visible projected IDs, parent IDs, depths, selectable state, and field values
metadataPanelId / metadata: selected panel and its scoped values
diagnostics: fallback/source/coverage messages
complete: authoritative coverage of the requested window
traversal: loaded/requested pages, next cursor, retry cursor, exhausted status
```

This is not an atomic cross-store snapshot. Per-page source clocks/boundaries stay
visible. `complete` describes the requested window; `exhausted` separately says
whether the query's history ended. A normal one-page result with more history is
complete and exits successfully.

Use `--pages <n>` to request up to 100 pages or pass the opaque `nextCursor` back
with `--cursor`. The query, profile, sort, filters, and page size must match the
cursor. A source outage, incomplete counts, missing source states, or repeated
items stops traversal. Partial data is labeled, counts can be unknown, and a
retry cursor is exposed; no stale cache is available in a one-shot process.
Repeated continuation cursors and wrong-query/page/schema envelopes are errors.

| Exit | Meaning |
| --- | --- |
| `0` | Complete requested window, successful command, help, or validation |
| `2` | Incomplete sources, or successful writes whose refresh is incomplete/unavailable |
| `1` | Invalid command/definition, transport/contract error, or action failure |

JSON diagnostics stay in the envelope. Errors use `kind: inbox.error`; text errors
go to stderr. Help is text. No legitimate empty result is reported for an outage.

## Inspect and act

```sh
coleo inbox show 'thread:inbox:review' --facet messages --json
coleo inbox mark-read 'message:<review-api@example.test>' --facet messages --json
coleo inbox mark-read 'message:<review-api@example.test>' --branch --facet messages --json
```

Use full IDs or the displayed compact references. `show` resolves identities
independently of list eligibility, filters, sort, page size, and mailbox through
`GET /api/workbench/inbox/references/:reference`; it then uses the existing targeted
detail API. A deleted/expired identity is not found, and unavailable lookup sources
are diagnosed. Read actions still require the intended view/window. These examples use fixture
IDs; replace them with actual IDs/references. `show` resolves targeted thread/message/event/
record APIs and returns full detail without implicitly changing read state.

`mark-read` validates every ID before writing. A message ID selects only that
member; `--branch` expands it to its explicit loaded descendants. A thread root
selects its loaded conversation. Incoming replies are not added to the selected
snapshot. Thread commands carry its revision and exact member IDs; sent-only
context is reported as skipped. Records use the existing profile-scoped attention
API. Thread selections are bounded to the server's 1000-member action limit.

Incomplete windows cannot be used for mutation. A stale revision fails without
automatic retry. Commands expose completed targets if a later write fails. A
successful action refreshes the same projection; a failed refresh is distinguished
from a failed write so callers do not blindly repeat a successful mutation.

## Migration from raw mail commands

`coleo mail inbox` remains the legacy raw-Maildir listing. The workbench entry point
is `coleo inbox --facet messages`. Use `--limit` instead of the old `--count`, full
stable IDs instead of prefixes, `show` for inspection, and an explicit `mark-read`
for mutation. `--pages`/`--cursor` express projection traversal; they do not inherit
the old raw-mail `--all` meaning. An API connection is required for snapshots and
actions, and their data includes the same conversations/context as the browser.

## Evidence and code map

- `src/cli/commands/inbox.ts`: Commander dispatch, machine/text output, and exit status.
- `src/cli/inbox/options.ts`: resolved flags/help, typed arguments, scope transitions.
- `src/cli/inbox/api.ts`: authenticated HTTP and wire/schema/query/page validation.
- `src/cli/inbox/snapshot.ts`: bounded root paging, declared fields, tree/metadata rendering.
- `src/cli/inbox/actions.ts`: exact loaded selections and existing detail/mutation APIs.
- `src/api/messaging-reference.ts`: filter-independent reference-to-detail resolution.
- `src/workbench/resource-reference.ts`: shared identity-derived reference format.
- `src/cli/__tests__/inbox.test.ts`: actual API fixtures plus real CLI subprocess checks.

Tests cover query parity, inherited filters, changed aliases, paging and ancestry,
partial sources, stale/legacy envelopes, exact nested/branch actions, failures
before writes, post-action refresh, offline validation/help, and clean process exit
with only HTTP reads and no locally initialized database.

Verified: **17 focused CLI tests**, with **123 CLI/model/API tests and 482
assertions** in the combined check. Root typecheck, docs build, and whitespace
checks passed. The CLI bundles successfully and runs with the distribution's
packaged templates and installed dependencies. Live HTTP checks returned fresh
Brain text snapshots and a two-page mail JSON snapshot with four roots and 17
hierarchy rows, then exited successfully. Live verification used read-only commands;
mutation checks use isolated API/Maildir fixtures.

Readable-table follow-up: all **54 CLI tests, 290 assertions** pass, including
display-width checks at 20/40/60/80/120 columns, Unicode grapheme truncation,
one-line message rows, reply connectors, and stable-reference inspection/actions.
Root typecheck, docs build, and whitespace checks pass. Live 80- and 100-column
tables were checked; JSON snapshots retain full IDs, values, and cursors.

Reference-navigation follow-up: **74 CLI/API tests, 373 assertions** pass, including
read conversations outside the attention page, sent mail, nested-message point
reads, completed records, source outages/timeouts, and mutation selection isolation.
Typecheck, docs build, and whitespace checks pass. The live reported reference
`@cdbd0616` now resolves with plain `inbox show`, without repeating Messages filters,
and returns the intended infrastructure-health conversation successfully.

Presentation-dispatch follow-up: **58 CLI tests, 631 assertions** pass. Tests
verify distinct grid/card/list layouts, wrapped previews, Unicode width bounds
at 20/40/80/120 columns, and unchanged snapshot data. Typecheck, documentation
build, and whitespace checks pass. Live Cards output was checked as boxed entries
with subject, facts, and preview rather than another grid.

ANSI-graphics follow-up: **61 CLI tests, 963 assertions** pass. Color tests cover
TTY/NO_COLOR/FORCE_COLOR behavior, explicit overrides, colored and plain width
bounds, title background sequences, meaningful state points, timeline spines,
and undecorated JSON. Typecheck, docs build, and whitespace checks pass. Live
timeline drawing with forced ANSI was verified.
