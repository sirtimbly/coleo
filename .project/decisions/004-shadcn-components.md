# ADR-004: Workbench UI Architecture and Component System

**Status**: Accepted (revised to reflect the workbench refactor)

**Date**: 2025-01-13

**Updated**: 2026-09-21

## Context

The original decision chose small, shadcn-inspired Tailwind components for the
Observatory. That describes the starting point, not the current application.
The July–September 2026 refactor established a workbench: multiple live,
configurable projections over the same project resources, hosted in persistent
tabs and split panels. It changed the shell, data presentation, controls,
theming, saved preferences, and detail navigation across the UI.

A component-library choice alone cannot describe this architecture. Sheets,
card collections, singleton viewers, telemetry, conversations, and project
editors have different data and interaction requirements. They need a shared
visual language without losing their domain behavior or duplicating state.

This revision replaces the earlier recommendation to grow toward the shadcn
CLI. The filename is retained so existing ADR links continue to resolve.

## Decision

Use a **Coleo-owned workbench and design system**, composed from React 19,
TypeScript, HeroUI v3 controls, Tailwind CSS v4 tokens, and specialized rendering
libraries behind application-owned contracts. React Router and a static route
registry supply views to both Golden Layout and the classic shell. Vite builds
the browser application.

The workbench is the application architecture, not a separate frontend or a
requirement to render every surface through one library.

### 1. Separate visual, application, and domain responsibilities

Paths below are relative to `src/web/src/` unless stated otherwise.

| Layer | Responsibility | Main implementation |
| --- | --- | --- |
| Visual foundation | Shared surfaces, controls, spacing, shape, typography, semantic state colors | `design-system/`, `index.css` |
| Workbench infrastructure | Resource/view contracts, saved preferences, live signals, reusable projection adapters | `workbench/` |
| Workspace shell | Route-backed tabs, splits, focus, panel state, layout persistence | `workspace/`, `app/routes.tsx` |
| Domain composition | Queries, mutations, resource schemas, presenters, workflow rules | `pages/`, domain components and hooks |
| Card presentation | Trusted templates, envelope presenters, SDK host, action dispatch | `adaptive-cards/` |
| Service boundary | Authoritative resources, events, preferences, attention, and card actions | Repository `src/api/` and API-owned persistence |

`components/` still contains shared and specialized application components.
Its existence does not make it a second design system. New visual patterns
belong in the shared foundation; domain components compose them.

Resources have stable identities. Events, sampled metrics, conversations,
runs, and documents remain distinct contracts. A projection selects how to
present them; it does not redefine their ownership or persistence semantics.

### 2. Share controls, themes, and hierarchy

Use HeroUI and existing Coleo primitives for buttons, inputs, selects, menus,
dialogs, and related controls. Native controls remain appropriate within shared
adapters. Domain validation, loading, disabled, selected, and error state stay
with the owning feature; a presentation library does not authorize a command.

- `index.css` supplies semantic color and typography tokens. `shapes.css` and
  `controls.css` adapt HeroUI, native controls, cards, sheets, and workspace
  chrome to the same policy, including portaled menus and editors.
- The theme supports light, dark, and system modes. The current default is
  **system**, with the explicit preference in browser storage.
- Action buttons use square geometry; containers and fields use small shared
  radii. Navigation controls have their own pill treatment. Component placement
  must not change what those shapes mean.
- `resource-status-styles.ts` supplies lifecycle colors shared by sheets and
  burndown charts. Page-specific palettes must not assign different meanings
  to the same status.
- Size is scoped to the surface. HeroUI control sizes, toolbar row sizes,
  collection density, card presentation, grid font size, and secondary telemetry
  controls are separate settings. There is no universal inherited `size` prop
  across every workbench component. Grid font size must not resize toolbars or
  the surrounding application.

### 3. Treat toolbars as configured compositions

`ToolbarTemplateProvider` combines defaults with profile-backed overrides.
`ToolbarTemplateRows` renders the two-row schema defined in repository
`src/workbench/toolbar-templates.ts`: named widgets, labels, dividers, spacers,
visibility, order, and `small`/`large` row sizing. The `/toolbars` screen edits
these compositions. Widget identifiers are allowlisted; configuration arranges
known controls rather than injecting executable UI.

Selection semantics belong to the control contract. `ToolbarToggleButton`
represents independent on/off state with `isSelected`, `aria-pressed`, and a
visible toggle indicator. `SegmentedPanelControl` represents zero-or-one open
insight panel and allows deselecting the current segment. Collection display
controls select a concrete display mode. Do not infer selection behavior merely
from adjacent buttons or their styling.

### 4. Use specialized projections behind shared contracts

| Surface | Current presentation and retained behavior |
| --- | --- |
| Tasks, Bugs, plan items, Discovery | Tabulator `ResourceSheet` adapters; editing, filtering, sorting, ordering, formatting, and details where supported |
| Resource card collections | `AdaptiveCardCollection`; domain code applies filters and sorting before rendering, and the collection preserves that order |
| Inbox | `ProjectionInbox` with a virtualized, read-only `InboxCardTable`, expandable cards, and an alternative card collection presentation |
| Project Mail | Separate `/mail` projection sharing messaging infrastructure; mailboxes, full threads, reply context, read/archive actions |
| Singleton task/bug details and editors | Trusted Adaptive Cards plus host-owned workflow controls and specialized discussions/diffs |
| Arm Fleet, Viewer, Processes | Shared collection framing with specialized stream, execution, and telemetry behavior |
| Dashboard and insight panels | Existing metric/chart implementations inside shared surfaces; Burndown and Activity opened on demand |
| Plan & Documents, Settings, Garden | Shared framing around specialized document reconciliation, settings, and Three.js/React Three Fiber scene behavior |

Activity, History, and Proposals compatibility routes hand off to Inbox facets.
Viewer requires Arm context and is opened from a resource selection. Project
Mail is a visible navigation destination, not merely a compatibility redirect.

#### Editable sheets

Tabulator 6.5.2 is the pinned production `ResourceSheet` runtime. Coleo owns the
column model, typed editors, API mutations, saved views, and undo/redo semantics.
Creatable tags, metadata formatting, insertion/deletion, and manual row ordering
must survive presentation refactors. Manual ordering is disabled while a saved
column sort is active.

Keep one imperative table instance per mounted sheet. Same-shape data refreshes
use incremental updates; changes to shape/order can replace data through the
adapter. Defer reconciliation while an editor is active, and keep server/live
updates out of user undo history. The Inbox scan table is a separate adapter:
its cells are not editable resource fields.

#### Adaptive Cards

`CardEnvelope` identifies a resource, creator, surface, and exact trusted
template version. The host lazily loads Adaptive Cards, renders schema 1.5 with
Coleo styling, and dispatches allowlisted actions. The server validates and
authorizes mutations independently of the rendered controls. Producers cannot
supply arbitrary templates, URLs, HTTP methods, or executable expressions.

Cards provide compact/detail presentation and bounded typed editing. They do
not replace resource schemas, charts, logs, threaded discussions, diffs, or plan
editors. Collection-owned presentation can hide per-card settings; editor cards
always retain full detail. Persisted generic card panels store an opaque instance
ID in route/layout state, not the full envelope.

### 5. Make each panel a complete, independently loadable view

Golden Layout is the default shell; classic mode remains supported. Both use
`APP_ROUTES`. Workspace panels use their own route context, including search
parameters and resource identifiers, so opening or navigating a detail panel
does not change a sibling collection's route.

A single-record viewer loads that record and its relevant attention state.
`InboxItemPage` is separate from the collection screen: opening a known item
seeds its per-item React Query cache for immediate display, then refreshes from
targeted record/event APIs. Direct links and restored panels load independently.
Message details intentionally load their conversation context. None of these
flows should fetch the entire Inbox just to find the selected item.

Splitting the workspace must preserve existing live panels. Reparent the
existing stack when adding the first sibling; do not serialize and reload the
whole layout to open a detail view. Profile/query refreshes and autosaves must
not recreate the workspace tree or discard local filters and expansion state.

### 6. Keep live data and durable preferences separate

The API owns domain state and mediates access to SQLite and event history.
`LiveProjectionProvider` consumes the shared browser WebSocket and distributes
signals. Projections reconcile relevant changes or invalidate/refetch their
queries. Sampled telemetry keeps its existing history and aggregation semantics;
it is not replaced by event counts.

TanStack Query is shared across panels, but the UI is not uniformly query-backed:
some collection screens retain local loading state and subscribe to projection
signals. The architecture does not promise a complete cached Inbox. Cache
records at the boundary that actually owns them, and do not make collection
loading a prerequisite for details.

Profiles, saved view definitions, workspace layouts, and toolbar overrides
persist through the workbench API. Saved views include filters, sorts, columns,
density, grid typography, and collection display preferences. Versioned
profile/view/layout bundles support sharing and import/export without rewriting
domain records. A workbench profile is a portable UI identity, not a separate
authentication principal.

Browser storage still holds browser-local preferences such as theme and shell
mode, compatibility fallbacks, and selected presentation/cache state. It is not
the authoritative store for shared views or domain resources.

### 7. Preserve interactions and contain rendering failures

Refreshes must not destroy unchanged interactive content. Inbox rows reconcile
by stable ID, expanded React roots survive updates, and equal card envelopes
retain their SDK DOM. A changed card is replaced when its new rendering is ready.
Clicks inside a card must not bubble into a row-collapse interaction.

`ScreenErrorBoundary` protects each Golden Layout route panel, classic screen,
and expanded Inbox card, with an application-root fallback. A failed tab can be
retried or closed without resetting healthy siblings. These boundaries contain
React rendering failures; request failures, event-handler errors, and imperative
SDK failures still need explicit handling by their owner.

## Rationale and alternatives

- **Continue with ad hoc/shadcn-inspired page components:** retained useful
  simple components, but rejected as the overall architecture because it leaves
  each page to invent density, navigation, persistence, and live-update behavior.
- **Adopt one library for the entire UI:** rejected. HeroUI, Tabulator, Adaptive
  Cards, and the Garden renderer solve different problems. Coleo adapters and
  tokens provide consistency while preserving those capabilities.
- **Convert everything into Adaptive Cards:** rejected. Rich sheets, telemetry,
  conversations, diffs, and collaborative documents need specialized interactions.
- **Use browser-only layout/view preferences or per-panel sockets:** rejected as
  the primary model because shared profiles and multiple live panels need common
  persistence and transport ownership.

This applies [ADR-011](./011-production-first-technology-selection.md) to a core
interactive application and preserves the service boundary in
[ADR-012](./012-api-owned-sqlite-access-boundary.md).

## Consequences

- Changes to shared tokens and adapters affect the whole application. Verify
  light/dark themes, narrow panels, focus/selection, and portaled UI together.
- Multiple rendering runtimes require explicit lifecycle and resize handling.
  Unnecessary remounts are correctness bugs when they lose edits or click targets.
- Domain behavior remains in Coleo: adopting a library does not replace command
  validation, permissions, resource identity, or saved-view semantics.
- Keep registries and trusted templates static and reviewable. Arbitrary
  third-party runtime plugins remain outside this decision.
- Legacy files may remain for compatibility. Their presence does not establish
  a second supported list implementation or justify new page-specific patterns.

## Implementation references and verification

This record describes the current source tree, including the September Inbox
stability changes. Dated migration results below are historical evidence, not
claims that today's full suite or performance benchmarks have been rerun.

- [Workbench guide and migration record](../../docs/workbench/README.md)
- [Adaptive Card contracts, rendering, and security](../../docs/workbench/adaptive-cards.md)
- [Tabulator benchmark and upgrade gates](../../docs/workbench/tabulator-benchmark.md)
- [Design-system component and styling guidance](../../src/web/src/design-system/README.md)
- [Workbench adapter guidance](../../src/web/src/workbench/README.md)
- [Theme implementation](../../docs/THEME_SYSTEM.md)
- Runtime dependencies: [web package manifest](../../src/web/package.json)

For UI changes, use the relevant tests in `e2e/design-system.spec.ts`,
`e2e/tasks.spec.ts`, `e2e/inbox.spec.ts`, `e2e/adaptive-cards.spec.ts`,
`e2e/inbox-item-detail.spec.ts`, `e2e/inbox-stability.spec.ts`, and
`e2e/error-boundaries.spec.ts`. Run them through `bun run test:e2e:web` along
with appropriate type/lint/build checks. Sheet performance gates and migration
validation are documented separately rather than frozen into this ADR.
