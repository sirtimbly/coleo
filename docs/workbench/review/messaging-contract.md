# Messaging: execution baseline and first contract slice

**Accepted direction: 2026-10-01.** This records the starting implementation
boundary for [the accepted plan](./implementation-plan.md), including Tim's
requirement to preserve ResourceView modularity across clients.

## ResourceView composition inspected in the current React application

There is no single component literally named `ResourceView` in this checkout.
The hierarchy is composed by these existing components and product pages:

| Module | Responsibility and portable meaning |
| --- | --- |
| `design-system/toolbar-template.tsx`, `src/workbench/toolbar-templates.ts` | Two ordered toolbar rows; registry-provided controls, labels, dividers, and spacers. Current defaults and visual editing use this shared model. |
| `design-system/SheetWorkspaceToolbar.tsx` | Primary resource/search/action/state controls and secondary filters/presentation/selection/insight controls, with product extension widgets. |
| `SheetInsightPanel`, `TasksPage`'s `TaskInsightPanel` | Optional metadata visualization above the resource collection. Closed insights consume no content height. Burndown/activity are views of metadata, not alternative resource identities. |
| `workbench/ProjectionInbox.tsx` | Inbox composition: two toolbars, facet/search controls, empty/loading feedback, grid/card renderer selection. Currently owns some client filtering and facet counts. |
| `workbench/AdaptiveCardCollection.tsx` | Layout of already-projected resources with stable keys and a supplied renderer. It does not fetch, filter, or sort resources. |
| `workbench/ResourceSheet.tsx`, `TaskSheet`, `BugSheet` | Tabulator resource presentation, columns, editing, selection, ordering, details, and history. Public contracts still expose vendor/runtime concerns scheduled for extraction. |
| `workbench/InboxCardTable.tsx` | Tabulator Inbox grid with expandable React card details; preserves its table and nested roots across updates. |
| `TasksPage`, `BugsPage`, `ProcessesPage`, `MessagingPage` | Product compositions bind controls, optional metadata, resource projections, and commands to the selected renderer. |

Blueprints represent this hierarchy explicitly: **toolbar 1 → toolbar 2 →
optional metadata/insights → resource presentation**, with feedback and commands
available to the composition. Grid, Adaptive Cards, and custom renderers share
resource/query identity. CLI flags/subcommands and TUI keys/menus expose toolbar
purposes; terminal tables/lists expose resources; text summaries can provide
metadata fallbacks. Exceptions remain visible through capability diagnostics.
Browser geometry, icons, React nodes, Tabulator types, and editor buffers are
client concerns. Field selection and command meaning are portable.

## Current Messaging source and command inventory

`MessagingPage.load` performs these nine reads for the Inbox. Mail-only mode
still reads all three mailboxes. This is the migration inventory, not a proposed
API-to-API aggregation implementation.

| Current read | Authority | Existing behavior to preserve |
| --- | --- | --- |
| `listActivity(limit:100)` | Retained JetStream activity | Producer/actor, resource targets, stable activity ID and sequence; activity detail links. |
| `listActivity(producer:brain, limit:200)` | Same retained activity store | Operations/tasks/arms/decisions/planning/alerts categories; older pages use `beforeSequence`, not timestamps alone. General and Brain activity are deduplicated by ID. |
| `listInbox(limit:100)` | Inbox Maildir | Unread flags, read/archive actions, thread context. |
| `listSent(limit:100)` | Sent Maildir | Replies remain in conversation context; sent threads are a mailbox scope. |
| `listArchive(limit:100)` | Archive Maildir | Archived threads remain inspectable and preserve mailbox context. |
| `listStatusReports(limit:100)` | SQLite status reports | Full report details; `status:<id>` duplicates the durable inbox representation and needs one canonical summary owner. |
| `getRecentEvents(limit:100, sinceMs:24h)` | Retained event store | Notable event filtering and sequence-addressed details. Failure is currently flattened into an empty array. |
| `listWorkbenchAttention(includeArchived:true, limit:1000)` | SQLite attention by profile/item | Read, resolved, archived, snoozed, and assigned state; separate from transient panel observation. |
| `listWorkbenchInbox(limit:200)` | SQLite durable summaries | Planning gate, reports, blocked/failed tasks, critical/high bugs, and swarm recommendations. Planning-blocked tasks are focused into the planning-gate item. |

Current semantic IDs include `thread:<mailbox>:<threadId>`, `status:<reportId>`,
`activity:<activityId>`, event identities, `task:<id>`, `bug:<id>`,
`brain:planning-gate`, and `swarm:<recommendationId>`. A resource summary and an
immutable event are different representations even when they reference the same
task. The existing task-focused suppression policy must be characterized before
changing it; do not erase distinct event history as an incidental deduplication.

Mail grouping currently lives in `pages/mail-page-utils.ts`: explicit Coleo
thread/task/bug/request headers, reply/reference headers, then subject fallback;
threads contain chronologically ordered messages from relevant mailboxes.
Extract this policy to a server/headless service with fixtures before moving
collection loading. A requested mailbox selects visible threads, not necessarily
all the messages needed to display their conversations.

Commands remain API-owned: attention PUT/bulk operations; mail read, archive,
send/reply; resource updates through domain/card action APIs; targeted Inbox
record/event, full report, and thread/message reads for details. Registered
command IDs describe purpose; a blueprint never supplies arbitrary URLs or code
and never authorizes an action. Every successful mutation refreshes affected
queries. The early command inventory is not a finished universal command bus.

## Portable contracts delivered in this slice

- `src/workbench/messaging-query.ts`: schema-validated query normalization and
  identity shared by future API/web/CLI/TUI consumers. Scope, profile, facet,
  mailbox, Brain category, search, AND filters, timestamp sort, and page size are
  explicit. Unused mailbox/category settings normalize away. A cursor and client
  request generation are separate from settings. Equivalent set filters,
  duplicate clauses, case-insensitive search, and date offsets normalize to the
  same identity. Other sort fields/operators require a deliberate contract
  extension, not silently different client behavior.
- `src/workbench/messaging-collection.ts`: ordinary JSON items with stable IDs,
  opaque revisions, representation kind, semantic detail references, selected
  source freshness, query-scoped counts, and opaque continuation. Metadata
  completeness describes the requested page, not exhaustion of history.
- `reconcileMessagingPage`: healthy sources replace their cached page sections;
  authoritative empty results clear them. Stale/unavailable/incomplete or missing
  sources retain previous data only for the same normalized query **and page**.
  A partial response does not advance traversal. Counts remain explicitly
  incomplete. This pure function does not implement fetch scheduling or reject
  obsolete network responses; that is the 1b controller's responsibility.
- `src/workbench/resource-view-definition.ts`: an early collection composition
  contract with named primary/secondary slots, optional metadata renderers,
  registered grid/card/custom presentations, field selections, and commands.
  Runtime registries validate resource-specific queries, fields, bindings, and
  command references. Client capability resolution retains stable feature IDs
  and reports declared fallbacks or unsupported features instead of hiding them.
- `src/workbench/examples/inbox-triage.json`: resolved JSON named-view fixture,
  deliberately independent of the unresolved YAML/JSONC authoring choice. Its
  optional metadata region starts closed. The custom timeline is a contract
  example, not a claim of an implemented Inbox timeline or terminal renderer.

These modules have no React, DOM, Tabulator, HeroUI, transport, or database
imports. Runtime validation uses the existing Zod dependency. They are small
repository modules, not packages. The collection-view schema is an early
implementation contract: full control inventory, detail/form composition,
toolbar editor migration, enclosing blueprint release versions, file authority,
and API resolution remain explicit delivery gates before the authoring format
is frozen or connected to existing editor/persistence paths.

## First bounded runtime correction

The existing `/api/workbench/inbox` read is still the durable-record subset,
not yet the complete Messaging collection. Its old implementation fetched a
short prefix from each source **before** applying cursor and attention filters.
This loses older pages and can incorrectly return empty when the prefix is
archived/snoozed. It also mixed locale-sensitive sorting with SQL keyset ordering.

Correct this now: apply visibility and keyset boundaries before limiting each
source, merge with binary timestamp/ID ordering, look ahead for a real next page,
and bind new cursors to the profile and durable projection. Keep old targeted
detail entry points and the existing `items`/`nextCursor` response. The complete
Messaging schema is not advertised by this legacy subset endpoint yet.

New durable cursors use a versioned envelope. Previously issued unversioned
tuple cursors are rejected with HTTP 400; restart traversal from the first page
after upgrading. A new page size can be used with a durable cursor because its
visibility query is unchanged. The later full Messaging cursor must bind all
normalized query semantics and retained-source boundaries.

Fixed-fixture acceptance: traverse more than the previous source prefix without
duplicates/skips; find visible items beyond a hidden prefix; tie-break identically
in SQL and TypeScript; reject malformed/cross-profile cursors and invalid page
sizes; verify swarm recommendations follow the same boundary/visibility rules.

## Next implementation boundary

1. Extract mail threading and Brain activity presentation policy into headless
   recipes, retaining existing fixture behavior and detail identifiers.
2. Implement API-side selected-scope adapters over domain services. Retained
   sources scan until enough matching items or actual exhaustion, carry sequence
   boundaries, and report service outages. Capture SQLite boundaries inside its
   own transaction; do not claim a Maildir/SQLite/JetStream atomic snapshot.
3. Evolve the existing endpoint to emit the portable response, with full-scope,
   pagination, deduplication, thread, and partial-failure API tests. Do not replace
   the current browser loading path until those gates pass.
4. Add the single web refresh owner: one in-flight request and one queued
   refresh, bounded bursts, query-generation guards, and authenticated socket
   reconnect recovery. Browser checks cover live editor continuity and direct
   thread/item links.
5. Resolve `inbox-triage` through the API and expose CLI text/JSON snapshots of
   that named view; then the live TUI. Blueprint file-format/editor work follows
   the accepted source-authority rules. CLI compatibility may deliberately break.

## Verification record

Initial focused baseline: **15 tests passed, 0 failed** across
`workbench-foundation`, `websocket-reconnect`, and `refresh-gate`. This is not
browser recovery evidence.

Focused commands for this slice:

```sh
bun test src/workbench/__tests__/ src/api/__tests__/workbench-inbox-pagination.test.ts \
  src/api/__tests__/workbench-foundation.test.ts src/api/__tests__/inbox-item-detail.test.ts \
  src/api/__tests__/brain-swarm.test.ts src/web/__tests__/websocket-reconnect.test.ts \
  src/web/__tests__/refresh-gate.test.ts
bun run typecheck
bun run docs:build
git diff --check
```

Verified on 2026-10-01:

- **58 tests passed, 0 failed, 335 assertions** across the eight suites above.
  The 14 new headless contract tests and eight new API regression tests are
  included in the normal unit/watch scripts.
- Before the runtime fix, all eight new API regression cases failed against the
  existing endpoint. The 532-record traversal returned only 57 records; hidden
  task/swarm prefixes returned empty. These fixtures pass after the correction.
- Root TypeScript checking, documentation production build, and `git diff
  --check` passed.
- All three headless contract entry points bundled successfully with Bun's
  browser target into a temporary directory, demonstrating no server/DOM-only
  import dependency. This is portability evidence, not an initial-app bundle
  performance measurement.

Browser race/reconnect validation is still required when 1b changes the loading
controller. No complete 1a/1b or terminal rewrite acceptance is implied by the
initial contract/paging slice.

The subsequent [nested-group and threading contract](./threading-contract.md)
adds source-owned reply relationships, independent visibility/focus, and explicit
loaded-member selection. The report now opens the `inbox-thread-review` named
view over API-projected Maildir fixtures; the original `inbox-triage` example
remains available as the initial composition fixture.

## Interactive HTML report

<a href="/workbench-report.html" target="_blank" rel="noopener">Open the interactive workbench report</a>.
The self-contained file is `docs/public/workbench-report.html`; it also opens
directly from disk without a server, external assets, or a running Coleo API.

```sh
bun run demo:workbench
bun run demo:workbench --serve
```

The first command regenerates the report with fresh test/type-check evidence and
an isolated 532-record API paging fixture. The second also serves it at
`http://127.0.0.1:4174/workbench-report.html` on a separate local server.

The demo imports the actual query, `projectMessagingItems`, named-view parser,
capability resolver, and reconciliation modules. The shared example registry is
`src/workbench/examples/inbox-triage-registry.ts`. Its browser grid/cards/custom
timeline and CLI/TUI previews are HTML adapters over illustrative records.
Commands modify only local fixture state. The paging chart uses the current Hono
endpoint and an explicitly labelled reproduction of the old prefix algorithm.

The added pure projection preserves mailbox scopes, Brain categories, attention
and planning-gate focus, typed AND filters, normalized search, and stable sort
order. It projects complete input; API adapters must apply these semantics before
paging rather than filtering an arbitrary short prefix afterward.

Report verification on 2026-10-02:

- **65 focused tests passed, 0 failed, 357 assertions**, including four projection
  tests and three regressions protecting literal JavaScript/JSON embedding and
  clean regeneration of the committed HTML artifact. These checks were rerun on
  the updated `master` baseline at `acfb53d` before committing this slice.
- Root and isolated browser TypeScript checks passed during report generation.
- Thirteen browser smoke checks covered client/presentation identity, optional
  metadata placement, multi-word search, sort, mail-only scope, outage retention,
  authoritative empty results, source recovery, CLI JSON, and definition editing.
  TUI keyboard navigation/detail inspection and CLI-JSON-to-TUI-list switching
  were additionally exercised.
- Desktop (1440px) and mobile (390px) layouts were inspected; the mobile document
  has no horizontal page overflow. Wide resource tables scroll inside the view.
- The final Lighthouse snapshot scored **100 accessibility, best practices, SEO,
  and agentic browsing**. Performance was not audited. The page loaded with no
  console errors and no external asset requests.
