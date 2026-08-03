# Coleo Workbench

This directory records the architecture and migration decisions for Coleo's
browser workbench. It is intentionally kept beside the product documentation
so future changes to the UI can be reviewed against the same small set of
domain rules.

## Product model

Coleo is an operating environment for a project, not a collection of unrelated
dashboard pages. The browser shell presents live, configurable views over the
same project state while the Brain and Arms continue to operate independently.

The workbench uses these concepts:

- **Resource**: a stable reference to a task, bug, Arm, Brain, message, plan,
  template, document, proposal, or run.
- **Event**: an immutable fact emitted by the server or event stream.
- **Metric sample**: numeric, time-indexed telemetry. Metric samples are not
  events and retain their existing sampling and aggregation semantics.
- **Conversation**: an ordered exchange among people, Brain, Arms, and the
  system, optionally attached to another resource.
- **Run**: the execution interval that begins when an Arm claims a task or bug
  after asking Brain for work. Launching an Arm does not itself create a run.
- **Document**: a versioned project artifact. A plan is a specialized
  collaborative document whose edits can regenerate and reconcile tasks.
- **Command**: a context-sensitive user action.
- **Projection**: a live query presented as a sheet, inbox, timeline, process
  monitor, document, conversation, or dashboard.
- **Workspace**: persisted Golden Layout geometry plus the view instance stored
  in each panel.

## Runtime data flow

1. Existing APIs and JetStream remain authoritative for domain data and events.
2. Existing Arm metric history and message metric tables remain authoritative
   for sampled telemetry.
3. One browser WebSocket connection fans server messages out to projections.
4. A projection either applies a small append/update directly or invalidates
   its React Query cache.
5. Background changes mark relevant workbench panels as needing attention.
6. View preferences and complete workspace layouts are persisted through the
   workbench API and may be private or shared.

## UI layers

The frontend is divided into four layers:

1. `design-system/` contains visual primitives and tokens. These components do
   not know about tasks, Arms, Brain, or routing.
2. `workbench/` contains registries, live projection infrastructure, saved-view
   state, and resource/view contracts.
3. Domain features supply projection schemas, row renderers, commands, and
   detail components.
4. Golden Layout hosts registered view instances and persists their placement.

Handsontable remains the production sheet implementation. An opt-in Tabulator
Tasks projection is available as a migration spike and is not yet used by Bugs,
Discovery, plan items, or default Tasks workspaces. Inbox, timeline, document,
process, and dashboard surfaces use the Coleo design system so they share one
compact interaction language.

## Persistence

`workbench_profiles` represents a portable UI identity even when Coleo is
running behind a single API key. A profile owns view definitions and layouts.
Each view has both a database ID and a stable per-profile key; this lets two
profiles customize `tasks-sheet` independently and makes shared views
copy-on-edit instead of mutating their owner.

Saved views contain:

- projection kind and resource type;
- filters and sort order;
- visible, hidden, and ordered columns;
- column widths and density;
- optional sharing metadata.

Saved layouts contain Golden Layout configuration and a schema version. The
export endpoint returns a portable bundle containing the profile, its views,
and layouts. Import creates or replaces that configuration without changing
project-domain data.

## Migration rules

- Preserve existing domain behavior while replacing presentation components.
- Keep plans specialized; never reduce plan reconciliation to generic document
  persistence.
- Keep telemetry sampling separate from the event stream.
- Use stable resource IDs in panel state instead of component-owned selection.
- Route every live subscription through the shared projection provider.
- Add file-level documentation to every migrated or newly created source file.
- Start with static registries in the main bundle. Dynamic third-party plugins
  are deliberately outside this migration.

## Current migration map

| Existing surface | Workbench destination |
| --- | --- |
| `TaskGrid`, `BugGrid` | Handsontable `ResourceSheet` |
| Mail, activity, history, and proposals | Inbox facets backed by `ProjectionInbox` |
| Arm telemetry components | metric-backed dashboard panels |
| Setup plan editor | retained as the specialized collaborative plan document |
| Golden Layout local storage | versioned database-backed workspace layout |
| Grid-specific local storage | database-backed saved view preferences |

Legacy row/grid components remain in the source tree only as type/style
compatibility dependencies for detail pages. No navigation route renders them
as its list implementation.

## Implementation record

The initial workbench migration was completed on 2026-07-31 in
`codex/workbench-ui`.

- Tasks, bugs, and discovery lists now use the shared Handsontable sheet.
- Brain, Arm, project, system, and attention streams share one inbox surface.
- Activity uses the reusable event timeline; implicit Arm work uses Processes.
- Saved views, profiles, portable imports/exports, and complete Golden Layout
  workspaces persist in SQLite.
- Golden Layout remains mounted across profile/query refreshes; current event
  callbacks are supplied through refs so database auto-save cannot recreate
  the pane tree.
- Verification covered the full 930-test suite, project type checking, web
  linting, a production build, and visual checks of the sheet, inbox,
  Processes, and Settings surfaces.

### 2026-08-01 overlay reliability follow-up

- View configuration panels use an explicit overlay layer above Handsontable's
  cloned headers and editors.
- Column and context menus are initialized outside routine React prop updates,
  preventing unrelated profile or workspace renders from closing open menus.
- Focusing a Golden Layout pane no longer schedules a redundant layout save;
  actual layout state changes remain the persistence trigger.
- Portaled Handsontable menus receive the same light/dark design tokens as the
  sheet that opened them.

### 2026-08-02 projection migration

- Arm Fleet and Viewer now share one compact Arm row and the same workbench
  framing, while preserving Viewer as a dedicated workspace panel.
- Brain status and operational history use common projection surfaces.
- Task and bug sheets retain Handsontable for spreadsheet interaction and use
  consistent workbench headers, toolbars, and detail framing.
- Dashboard cards and activity summaries use shared surfaces without changing
  the existing metric and chart implementations.
- Inbox is the primary stream interface. Its Messages facet preserves read,
  reply, archive, full-thread viewing, and reply indentation. Brain, Arm,
  attention, and history facets expose the other operational streams.
- Mail, Activity, History, and Proposals remain compatibility redirects for old
  deep links and saved workspaces, but are omitted from launchers and
  navigation.
- Settings, project documents, and Garden now share workbench framing while
  retaining their specialized profile, plan-reconciliation, and 3D scene
  behavior.
- Brain links to the Inbox's Brain facet rather than maintaining a second
  activity feed. The Inbox retains Brain-specific semantic categories,
  formatted summaries, target navigation, live connection state, and
  retained-history paging.
- Viewer remains a route-backed detail projection for selected Arms, but is not
  exposed as a standalone launcher or navigation destination.
- Dashboard no longer owns recent-activity or notable-event feeds. It links to
  Inbox, which now ingests the high-signal server event stream while retaining
  task, bug, and Arm target navigation.
- Eight Playwright scenarios protect the Inbox, Brain handoff, Arm Fleet/Viewer, and task
  spreadsheet/detail flows.

### 2026-08-02 sheet performance follow-up

- Resource sheets own one imperative Handsontable instance instead of routing
  its editor portals and settings updates through React renders.
- Explicit column widths and row heights disable unnecessary automatic sizing,
  while Handsontable's row virtualization remains enabled with a small viewport
  buffer.
- The Subject column scrolls with the rest of the sheet. Removing its frozen
  overlay eliminates the duplicated first-column layer that made row-header
  repainting visible during selection.
- Sheet pagination runs only when the vertical viewport reaches the bottom
  threshold, not on every scroll event.
- The Tasks browser coverage samples row-header selection over multiple
  animation frames and rejects duplicate frozen-column cells.

### 2026-08-02 row metadata restoration

- Task and Bug sheets expose their existing metadata tags through Handsontable's
  native MultiSelect cell type. Selected tags render as removable chips, and
  edits persist string arrays while preserving unrelated metadata.
- Selecting any data cell or row header reveals the shared row-formatting
  toolbar without recreating the Handsontable instance.
- Bold and the existing slate, blue, green, amber, and rose row colors persist
  through each resource's `metadata.ui` object and render across the full row.
- Browser coverage protects Task formatting and the restored Bug tags/color
  behavior while keeping the critical workbench suite at eight scenarios.
- Every sheet with editable cells exposes Handsontable Undo and Redo through
  keyboard shortcuts and the context menu. React Query reconciliation uses
  `updateData()` so server responses preserve the current history stack.

### 2026-08-03 Tabulator migration spike

- Tasks remains Handsontable-backed by default. **Compare Tabulator** opens the
  experimental `?grid=tabulator` projection in a separate Golden Layout split
  so both runtimes can be evaluated against the same API data.
- The Tabulator bundle and stylesheet are loaded only when the preview is
  opened. React owns the resource data and callback refs while one imperative
  Tabulator instance owns grid interaction state.
- The first gate covers dark-theme presentation, Golden Layout resize redraws,
  single-row selection, Subject and Status editing, whole-row drag ordering,
  and the Details context action.
- The preview intentionally does not replace `ResourceSheet`, implement the
  creatable Tags editor, expose the shared view configurator, or become the
  default. Those remain later migration gates.
- A focused model test protects row conversion and update/reorder translation.
  Playwright exercises the preview beside Handsontable using real Golden Layout
  splitting before the production runtime can be changed.
