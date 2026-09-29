# Implementation plan: one resource model, several ways to work

**Direction selected by Tim on 2026-09-29; implementation plan for acceptance.**
This plan supersedes the alternatives and ordering in the four review chapters.
Their findings remain the evidence record. This PR changes documentation only;
runtime work begins in follow-up commits/PRs after the plan is accepted.

## What we are building

Coleo owns the resources and their commands. The workbench arranges ways to see
and act on them. A panel is a **collection**, a **detail**, or a **form**. Its
renderer can change without changing the resource's identity, query semantics,
or permitted actions. The browser is the first client of these contracts;
the CLI and TUI will be the next practical tests of their portability.

Keep the bench metaphor, with five precise responsibilities:

| Part | Owns | Does not own |
| --- | --- | --- |
| Resource model | Identity, typed fields, query/command contracts, semantic purpose | React nodes, table widgets, docking geometry |
| Product recipe | Task/bug/mail/Arm workflow, resource presentations, contributed controls | Transport lifetime or another panel's filter state |
| Signal desk | Change relevance, bounded refresh scheduling, reconnect recovery | Durable Inbox read/resolved state |
| Panel notebook | That panel's query, presentation, and successfully saved settings | A shared mutable view keyed only by resource type |
| Panel host | Placement, visibility, route/deep-link handoff, adapter lifetime | Task lifecycle policy or vendor-neutral resource definitions |

The priority is **Messaging API and recovery first**. Do not hold that work for
a complete shared framework, new toolbar syntax, or a second client.

## Disposition of every review topic

| Review topic | Selected direction |
| --- | --- |
| Bench: generic collections | Generalize the collection boundary; retain Adaptive Cards as one renderer |
| Bench: toolbar dependency inversion | Separate semantic schema, application lookup, and visual rendering; both editors use one model |
| Bench: Tabulator/domain leakage | Remove vendor and Coleo-specific types from public sheet contracts; isolate the adapter |
| Bench: derived state, effect counters, product recipes | Use pure transformations and explicit actions; move feature policy out of infrastructure |
| Signal: Messaging request fan-out and burst/race behavior | Highest priority: one collection endpoint, one client refresh owner, defined recovery and partial-data behavior |
| Signal: duplicated task updates and Processes refresh races | Consolidate incrementally using the same refresh contract |
| Signal: tab attention | Unseen change in this particular panel's view; never a channel-wide reset |
| Notebook N1: profile identity | Valid finding, later phase; preserve current data and document limitations, do not expand profile work now |
| Notebook N2: settings saves | Simple server round trip and canonical refresh; no durable draft/offline save system |
| Notebook N3: simultaneous edits | Accepted follow-up, low priority; retain documented last-write-wins across independent clients for now |
| Notebook N3: schema versions | Implement fully with the toolbar model/editor/DSL, including safe import migration |
| Panel host: coupling inventory | All identified seams are targets, staged behind behavior checks |
| Panel host: independent view state | Each panel owns filters, sort, display mode, columns, selection, and insight state |
| Panel host: browser storage failure | Prevent fallback failures from blocking API persistence |
| Panel host: classic shell | Retire classic-only code; Golden Layout becomes the sole browser shell |
| Future clients | Shared serializable contracts; CLI snapshot and TUI live slices before any native-app commitment |

This resolves the review's architectural choices. Two interaction details were
asked separately: immediate settings saves versus Apply, and toolbar text syntax.
Unless changed during plan review, the proposed defaults below are immediate
saves for completed changes and YAML as text notation. They are implementation
defaults, not claims that Tim explicitly selected a parser or save gesture.

## 1. Make Messaging a coherent API projection

Evolve the existing `/api/workbench/inbox` collection endpoint into the single
read entry point for Messaging's list. It currently covers only part of the
screen's data; do not add another overlapping aggregator without a migration
reason. The server should call domain services directly, not make loopback HTTP
calls to nine endpoints. Existing targeted record and full-thread endpoints
remain the entry points for detail panels.

The collection query includes facet, mailbox, search, filters, sort, and cursor.
Use one normalized query representation shared by the API and client; preserve
the existing Brain categories, archived/sent mail behavior, attention facets,
and retained-history paging. Mail uses the same projection machinery with its
own scope. Fetch the requested scope rather than every hidden facet on each
refresh. Return counts needed by visible controls with documented scope.

Define the response as ordinary JSON data: schema version, query identity,
items with stable IDs and revisions, summaries/counts, continuation cursor,
and per-source freshness/completeness. A request generation ID remains a client
concern; a response's source revisions describe data, not its arrival order.
Keep renderer templates/React components out of this API contract.

The contract must guarantee:

1. Deterministic item identity and ordering, with a stable tie-breaker. Resource
   summaries and immutable events stay distinct; deduplicate duplicate source
   representations without flattening mail conversations.
2. Cursors bind to the normalized query and source continuation boundaries.
   Changing filters starts a new traversal. Do not fetch a short source prefix
   and then apply the cursor in a way that silently skips older results.
3. Failed sources are explicitly unavailable or stale, not silently empty.
   Preserve previously loaded sections when the response cannot replace them
   authoritatively; label incomplete counts. A legitimate empty result remains
   distinguishable from an outage.
4. No claim of a cross-store atomic snapshot. SQLite, mail, and retained events
   have different clocks/ownership. Capture consistent boundaries where each
   source supports them and disclose freshness where it does not. A single
   endpoint reduces coordination work; it does not create a distributed
   transaction. Use a materialized projection only if required by measured
   latency or pagination correctness.
5. Commands complete through the API; successful actions refresh the affected
   projection. Server validation and authorization stay authoritative.

In the client, replace the nine-source local-state merge with one query-backed
collection controller. Cache by the normalized query/scope, not by panel ID
alone. Panels may share an identical server result while owning separate query
settings. Keep one request in flight per query and one pending refresh; reject
obsolete responses after query changes. Continuous events must refresh within a
bounded interval rather than waiting indefinitely for silence. Disconnecting
only the socket and reconnecting triggers active-query recovery without relying
on browser focus or network events.

**Acceptance:** the collection uses one request for its requested scope; mail
threads and direct item links retain their context; continuous events do not
starve updates; an old response cannot replace a new query; partial outages are
visible; cursor paging has no duplicate/skipped items in fixed-fixture tests;
socket-only outages recover without manual refresh. Add the relevant API and
browser tests before replacing the existing loading path.

## 2. Give each panel its own view and attention

Separate three identities: resource ID, reusable view-template ID, and panel ID.
Persist panel configuration under workspace/panel identity and schema version,
not `tasks-sheet` as a shared mutable record for every task panel. A reusable
view/template initializes a panel; editing that panel does not mutate siblings
or its source template. An explicit later command may save a reusable template.

A duplicated panel starts with copied settings and a new identity. A restored
panel keeps its saved settings. Migrating older layouts copies their current
shared defaults into each restored panel once. Deep links identify resources or
queries without accidentally reusing another panel's preference record.
Keep field-editor buffers and scroll position local to the live renderer; do
not turn them into server settings merely because the panel has a notebook.

For attention, track a panel's last observed semantic result separately from
its most recent result. Relevant changes include records entering/leaving the
filter, changed displayed fields, and changed displayed summaries. Ignore
transport heartbeats, redundant payloads, and unrelated resource changes.
When a hint is insufficient to determine relevance, refresh the bounded query
and compare results rather than assuming every event matters to every panel.

Clear the dot only for a panel whose current result has been presented while
that panel is visible in the foreground application. Clicking a loading tab
does not acknowledge unseen data. Another panel—even one viewing the same
resource type—keeps its own marker. A filter change establishes a new baseline
when its result is rendered. A restored session starts its baseline after its
first successful load; do not invent a persisted backlog of tab notifications.
These are proposed operational rules for the selected per-view meaning.

Durable Inbox read/resolve/snooze state remains separate. Deferring profile work
does not justify reusing a shared profile/channel counter for panel attention.

**Acceptance:** two differently filtered Tasks panels can be edited, duplicated,
closed, and restored independently; a relevant hidden-panel change sets only
its dot; viewing one panel cannot clear another; redundant refreshes and
heartbeat events never light dots; a reconnect recovers both data and relevance.

## 3. Simplify settings persistence and retire classic mode

Use a normal mutation lifecycle: completed user change → API save → canonical
server response (or targeted reload) → updated panel state. “Reload” means the
affected query/settings, not the browser document or Golden Layout tree.
Do not add a durable draft store, save-on-unmount machinery, or offline merge UI.

Proposed interaction default: dropdown/toggle changes commit immediately;
resizing commits on gesture completion, and text/number input commits on an
explicit completion gesture. Avoid per-keystroke requests. Serialize changes to
one settings record or disable its relevant controls during the round trip,
so the ordinary single-user flow cannot overwrite itself. A failed save shows
an error and retains the last confirmed configuration, with an explicit retry
action if appropriate; never display “saved” before success. Closing a panel
does not cancel an already dispatched application-owned save.

Text DSL editing and actual resource forms necessarily have temporary input
buffers. Those are ordinary form state, not the durable settings-draft system
rejected here. An invalid text document is not sent to the server. Multi-device
conflict detection and profile-specific attention remain later work.

Catch browser-storage failures independently of API saves. Keep the server
authoritative and make restore precedence explicit. Remove the classic-mode
selector and classic-only shell path early, honoring old stored `classic`
preferences by opening Golden Layout. Preserve direct URLs, navigation,
resource forms, error boundaries, and components that happen to be shared with
classic. Delete code based on verified consumers, not folder names. Keep browser
routing where it provides deep-link entry even after the second shell is gone.

**Acceptance:** a completed settings change survives reload; failures are
visible; blocked browser storage does not block API saving; panes/editors remain
mounted; existing deep links and old shell preferences open the Golden host;
no requirement to keep testing a retired classic implementation.

## 4. Build portable resource and rendering contracts

Prefer `ResourceCollection` as the generic boundary and retain
`AdaptiveCardCollection` as a compatibility wrapper during migration. The name
matches `ResourceRef` and `ResourceSheet`; “Adaptive” describes responsive
presentation, while Adaptive Cards remains a specific renderer. A rename alone
is not the fix: the core receives projected items, stable keys, presentation
intent, and semantic actions without importing card-envelope or SDK types.

Separate the sheet into a dependency-free TypeScript model, a web-facing
composition, and `TabulatorSheetAdapter`. Public model contracts contain fields,
sort/filter rules, validation results, edit/move commands, and history
transitions. They contain no Tabulator `Validator`, DOM objects, React nodes,
HeroUI types, or task/bug status unions. Coleo recipes provide lifecycle labels,
formatting intent, fields, and command mappings. The web wrapper may depend on
React; the Tabulator adapter necessarily depends on Tabulator. This makes the
boundary dependency-free without claiming that a functioning renderer has none.

Maintain separate wire and runtime contracts. JSON field descriptors use stable
field/command IDs and serializable constraints. Client registries may map those
IDs to typed functions. Do not try to serialize JavaScript readers, validators,
or event handlers for Swift or another client. Server validation remains the
final rule even if a renderer offers immediate validation feedback.

Keep pure projection/history functions deterministic; pass time and identity
in when needed. Model edit outcomes and pending/confirmed history explicitly so
failed mutations do not create successful-looking undo records. The adapter
alone owns DOM lifecycle, selection, editor protection, and resize observers.
Use one focused instance owner rather than many hooks sharing mutable refs.

**Acceptance:** import and test the model without React, Tabulator, or a DOM;
no vendor types escape its API; demonstrate a second minimal renderer with the
same resource description; existing tags, formatting, row moves, details,
undo/redo, live editor preservation, and scale gates still pass. Keep library
upgrades out of this extraction.

## 5. Give panels and controls semantic slots

Start with an inventory of every existing toolbar widget, field/editor kind,
action, selection mode, and insight control. Classify all known controls before
freezing schema v1; do not force a unique widget into an inappropriate common
slot merely to avoid an extension. Stable purpose names describe behavior;
icons, widget implementations, and placement are replaceable.

| Region or slot | Purpose and examples |
| --- | --- |
| `toolbar.primary.identity` | Resource/view title, subject, scope |
| `toolbar.primary.context` | Mailbox, facet, selected Arm, breadcrumb |
| `toolbar.primary.search` | Search within the current view |
| `toolbar.primary.actions` | Create, refresh, compose, start/stop, domain commands |
| `toolbar.primary.state` | Connection, progress, counts, save/error feedback |
| `toolbar.secondary.filters` | Status, tags, date range, domain filters |
| `toolbar.secondary.sort` | Sort order and manual-order eligibility |
| `toolbar.secondary.presentation` | Sheet/cards, density, columns, typography |
| `toolbar.secondary.selection` | Selected-count summary, batch actions, row formatting |
| `toolbar.secondary.insights` | Optional overview, burndown, activity selectors |
| `insights` | Optional telemetry or resource overview; no reserved height when closed |
| `content` | Collection renderer, resource detail, or form fields |
| `content.summary`, `content.fields`, `content.related` | Named detail/form composition points |
| `feedback` | Empty/loading/error states and command results |

Collections have two toolbar tiers, optional insights, and content. Detail and
form panels use the same named regions but omit irrelevant slots. Domain
widgets declare their purpose, supported panel kinds, required capabilities,
state binding, accessible label, and optional keyboard action. Common examples
are action, independent toggle, exclusive choice, search, filter, value input,
status, label, spacer, and divider; domain-specific controls use registered IDs.
Selection semantics must not be inferred from how neighboring buttons look.

Treat resource fields similarly: identity/title, summary, lifecycle, assignee,
tags, temporal values, progress/metrics, related resources, body, and actions.
These are semantic roles, not a requirement that every resource has every field.
Charts, discussions, logs, diffs, and plan editors remain specialized content.
Dashboard and Garden can be project-detail recipes with specialized content;
the three panel kinds do not require flattening those interfaces into forms.

A definition selects allowed widgets and orders them in named slots; widgets
implement purpose. A screen declares available capabilities. The host supplies
live bindings. Layout never authorizes a command. Keep the registry static for
now, with additions reviewed as application code.

## 6. Make visual and text toolbar editing two views of one model

Use a single versioned `ToolbarDefinition` model and runtime parser shared by
the API, visual editor, and text editor. Build on the existing shared module in
`src/workbench/toolbar-templates.ts`; eliminate parsing imports that travel
through a React component. Separate reusable defaults from per-panel overrides.
Editing a template must be an explicit action, not an incidental change to
another open panel's toolbar.

Proposed text default: a deliberately small YAML notation with named slots,
widget IDs, labels, visibility, order, and typed options. JSON is the canonical
wire/storage shape. A compact example of the intended model—not a parser
already implemented—is:

```yaml
schemaVersion: 1
id: tasks-collection
panelKind: collection
slots:
  toolbar.primary.identity:
    - id: heading
      widget: resource.identity
  toolbar.primary.search:
    - id: search
      widget: collection.search
  toolbar.secondary.filters:
    - id: status
      widget: tasks.status-filter
  toolbar.secondary.insights:
    - id: burndown
      widget: tasks.burndown-toggle
```

The visual editor supports no-code placement, reorder, visibility, labels,
options, and preview. It does not edit another schema behind the text editor's
back. Parse → validate → canonical model → preview/save is the shared pipeline.
Allowlist IDs and typed bindings; no JavaScript evaluation, arbitrary requests,
or second executable templating language. Preview shows unsupported bindings
explicitly. Narrow-panel overflow and keyboard access remain part of rendering.

Implement schema versions here, not as a counter incremented on every write:
explicitly migrate legacy unversioned two-row templates; distinguish document
schema version from record revision; validate on client and server; reject
unsupported future versions before import replaces any data; preserve the
original document on migration errors. Cover toolbar, panel-state, and enclosing
import-bundle version boundaries as they are changed.

**Acceptance:** visual → model → text → model preserves meaning and stable IDs;
malformed documents and unknown/incompatible widgets yield actionable errors;
legacy templates migrate; future versions leave saved data untouched; no
round-trip promises about retaining YAML comments/whitespace unless separately
implemented. Reuse the existing visual editor where it supports this model.

## 7. Thin the host and prove reuse with another client

Move route metadata and per-view relevance policy beside product contributions.
Separate workspace serialization/persistence from Golden Layout lifetime and
chrome. Extract pure sheet history before splitting its effects. Give Tasks,
Bugs, Messaging, and Viewer focused query/action controllers and explicit
collection/detail/form compositions; a huge hook with the same responsibilities
is not progress. Audit eager route loading with a bundle trace before deciding
which screens to lazy-load. Preserve tab/card error isolation, split reparenting,
editor continuity, metric sampling, and plan reconciliation.

Use three contract levels for future interfaces:

| Shared level | Contents | Consumers |
| --- | --- | --- |
| Service contract | JSON resources, queries, commands, errors, pagination, freshness/change hints | Every client, including non-TypeScript clients |
| Headless TypeScript model | Pure projection, presentation intent, validated definitions, refresh state transitions | Web, CLI/TUI where compatible; a future TS-native client after validation |
| Client adapter | React/Tabulator/Golden Layout, terminal widgets, native UI | One client only |

Keep these as small repository modules initially, not published packages or a
new dynamic plugin runtime. A native client shares service semantics; it need
not render a two-row web toolbar pixel for pixel.

The first portability slice is the same Inbox query in three forms: browser
collection, CLI one-shot text/JSON output, and a live TUI view. The CLI prints
scope and freshness, exposes incomplete results consistently, and exits without
a socket. The TUI uses HTTP snapshots plus the same change/recovery protocol;
it maps semantic commands to keys and terminal controls. Adapt existing CLI/TUI
code rather than launching a second terminal framework. Neither gains direct
database or JetStream access for the sake of reuse.

Later, timebox one native spike: load, filter, inspect, and act on the same
Inbox data, then test offline/reconnect and error paths. Compare SwiftUI's
native UI plus a service client against Perry's TypeScript/native adapters.
[Perry's published model](https://www.perryts.com/) describes native compilation
and platform widgets but also language/package limitations. Treat it as a
candidate, not evidence that the React/Tabulator app compiles unchanged. Validate
HTTP, WebSocket/auth, model dependencies, packaging, and target-platform controls
before choosing it. No native framework commitment belongs in this phase.

## Delivery order and exit gates

Each row is a bounded slice; split implementation commits by fix, preserve
behavior before extraction, and update this checklist as evidence lands.

| Order | Planned slice / commit theme | Depends on | Exit gate |
| --- | --- | --- | --- |
| 1a | `feat(api): unify messaging collection queries` | Existing domain services; minimal query contract | Single scoped endpoint, paging/freshness/partial-failure contract tests |
| 1b | `fix(web): make messaging refresh ordered and recoverable` | 1a | Single collection load path; burst, stale-response, reconnect browser checks |
| 2a | `feat(workbench): persist independent panel view state` | Minimal panel schema | Two same-resource panels stay independent across restore |
| 2b | `fix(workbench): track unseen changes per panel` | 1b, 2a | Query-relevant changes and observation rules; no sibling clearing |
| 2c | `fix(web): save settings with a canonical round trip` | 2a | Success/failure and same-panel request ordering; no durable drafts |
| 2d | `refactor(web): retire the classic workspace shell` | Deep-link coverage | Old shell preference and routes open Golden; shared components survive |
| 3a | `refactor(workbench): isolate resource models from renderers` | Small model/adapter contract | No UI/vendor imports in core; tags/edit/history behavior preserved |
| 3b | `refactor(web): generalize resource collection rendering` | 3a | Cards and a second simple renderer use the same resource model |
| 4a | `feat(workbench): define semantic panel and toolbar slots` | Control inventory; 2a, 3a | Existing controls mapped; visual layer has no profile lookup |
| 4b | `feat(workbench): version toolbar definitions and migrations` | 4a | Legacy migration and atomic rejection of unsupported imports |
| 4c | `feat(web): unify visual and text toolbar editing` | 4b; syntax decision | Meaning-preserving round trips and usable preview/errors |
| 5a | `refactor(web): separate workspace policy from renderer lifetime` | Relevant behavior coverage | Host/sheet/feature seams split without remount regressions |
| 5b | `fix(web): consolidate remaining projection refresh owners` | 1b's proven controller | Tasks/Processes use one policy; no burst/order regressions |
| 6 | `feat(cli): expose shared resource snapshots` then TUI live slice | 1a's stable contract; core where useful | Same query/action semantics across clients |
| Later | Profile ownership, cross-client conflict handling, native spike | Actual product demand | Separate scoped plans; no blockage of Messaging or editor work |

Boundary fixes can accompany the first feature that needs them; the order is
not permission to delay a demonstrated correctness defect until a later cleanup.
Run focused API/model tests per slice and the relevant
`bun run test:e2e:web` suites for changed interactions. For shared adapter work,
include light/dark, narrow panes, split/resize, undo/redo, live editing, and
restored deep links; run applicable type/lint/build checks. Do not rerun classic
parity as an acceptance condition after that shell is removed.

## Explicitly deferred or excluded

Profile expansion and per-profile attention migration remain recorded for later;
this plan does not reclassify existing profiles as authentication. Simultaneous
multi-device settings edits stay low priority; no CRDT, collaborative settings
editor, or durable offline drafts. No third-party runtime plugins, no wholesale
renderer/library replacement, no database migration, and no browser connection
to JetStream. Schemas and adapters must enable future clients without requiring
those clients to be built before the current product improves.
