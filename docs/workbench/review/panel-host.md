# The panel host: keep the instruments mounted

**P2 — tight coupling inventory; all extraction deferred.**

Golden Layout and Tabulator solve real product problems: rearrangeable live
views and dense editable data. Keeping their imperative instances alive is a
correctness requirement when a refresh could otherwise destroy an edit. A
functional React architecture should surround those instances with predictable
data transformations, not pretend the instances are pure values.

## What is working

Both shells use [APP_ROUTES](../../../src/web/src/app/routes.tsx).
[WorkspaceRoutePanel](../../../src/web/src/workspace/WorkspaceRoutePanel.tsx)
gives each panel its route context and rendering error boundary.
[split-root-stack](../../../src/web/src/workspace/split-root-stack.ts) preserves
existing content when splitting. [Sheet synchronization](../../../src/web/src/workbench/use-resource-sheet-synchronization.ts)
defers data/configuration reconciliation during editing. These choices match
the docs and should survive any cleanup.

The [Inbox detail loader](../../../src/web/src/pages/load-inbox-item.ts) fetches
a record and its attention separately; opening a detail does not require
loading the collection. Preserve full conversation context for mail threads;
a flat event feed is not an interchangeable replacement for a conversation.

## Coupling inventory: identify it without moving it

| Boundary | Evidence and cost | Eventual seam | Why defer |
| --- | --- | --- | --- |
| Host ↔ Coleo navigation policy | `GoldenWorkspace.routeAttentionChannels` hardcodes task/bug/Arm routes in addition to `APP_ROUTES`; host changes when domain attention changes | Route contributions can declare attention policy alongside title/navigation metadata | First decide channel versus per-panel attention semantics |
| Host ↔ persistence ↔ chrome | `GoldenWorkspace.tsx` is 1,339 lines and owns docking, route state, profile restore/save, local fallback, and shell UI | Workspace serialization/persistence policy plus a focused Golden Layout adapter | Splitting by line count risks remounting panels or changing save timing |
| Sheet ↔ history ↔ embedded roots | `ResourceSheet.tsx` is 877 lines, with a mount effect covering table events, history replay, row details, observers, and cleanup | Pure history transitions and a bounded renderer lifecycle owner | Preserve editor, selection, expanded-root, and undo guarantees first |
| Feature ↔ all view modes | `TasksPage.tsx` is 1,431 lines; `BugsPage.tsx` 911; `MessagingPage.tsx` 645 | Domain query/action controller plus explicit list/detail compositions | Some shared state is intentional; avoid hooks that merely relocate a giant component |
| Viewer ↔ transport ↔ caches ↔ telemetry | `ArmViewerPage.tsx` is 3,329 lines and owns stream presentation plus browser-local history/preferences | Separate event-log model, telemetry queries, and viewer presentation | This review sampled the integration boundary, not every Viewer interaction |
| Registration ↔ loading | `APP_ROUTES` imports components through the pages barrel at module load | Keep static metadata and use lazy component loaders where worthwhile | No bundle trace was run; this is an eager source dependency, not a measured startup regression |
| Public sheet contract ↔ vendor/domain | `ResourceSheetColumn` exposes Tabulator `Validator` and task/bug `StatusSeriesEntity` | Narrow validation/presentation callbacks only when another consumer needs them | A vendor adapter is allowed to know its vendor; a universal grid DSL is not justified |
| Profile selection ↔ persistence timing | `useSavedView` and `useViewPreferences` combine server snapshots, drafts, provider rerenders, and timers | Explicit draft identity and save revisions | Correctness work in the notebook chapter must precede reuse |

Source anchors: [host](../../../src/web/src/workspace/GoldenWorkspace.tsx),
[sheet](../../../src/web/src/workbench/ResourceSheet.tsx),
[Tasks](../../../src/web/src/pages/TasksPage.tsx),
[Bugs](../../../src/web/src/pages/BugsPage.tsx),
[Inbox](../../../src/web/src/pages/MessagingPage.tsx),
[Viewer](../../../src/web/src/pages/ArmViewerPage.tsx),
[vendor contract](../../../src/web/src/workbench/resource-sheet-tabulator.ts),
[saved views](../../../src/web/src/workbench/profile-context.tsx).
Line counts refer to the reviewed snapshot, not a target size.

## Two ownership decisions hidden by the current vocabulary

**A view instance is not a saved view.** Panels have independent routes, but
`useSavedView` resolves a stable key within a profile, such as `tasks-sheet`.
Two panels using that key share the persisted definition. The layout stores
route state, not a general independent view-definition reference for every
panel. The guide's “view instance stored in each panel” should distinguish
panel identity, route parameters, saved-view identity, and transient interaction
state. Decide whether two task panels should share filter edits or fork views.
Do not silently make per-panel settings permanent as part of cleanup.

**A fallback is not a second authority.** The host saves a browser-local layout
and later the API layout, then prefers the server layout on restore. That is
consistent with a server authority but can discard a newer local arrangement
after an API save failure. Also, the unguarded `localStorage.setItem` occurs
before scheduling the API save; a storage exception can prevent that save
path entirely. Define fallback/error behavior before moving persistence to a
hook. Browser-local preferences are explicitly permitted in ADR-004; their mere
presence is not a violation.

## Direction to choose

**Recommended: keep the host; extract policy when behavior is protected.**
Start with explicit route contributions and pure serialization/history
transitions. Keep one owner for each imperative instance. Use effects for
external lifecycle synchronization and keep cleanup close to acquisition.
Do not split one instance across many hooks that coordinate through a bag of
mutable refs: that can hide the coupling while increasing ordering assumptions.

Pure models should take time/identity as input when they need it, return a new
state or command description, and leave network and DOM work to a small shell.
Stable resource keys and equality checks should prevent unnecessary imperative
updates. Adding `useMemo` everywhere does not establish those semantics.

**Alternative: retain application-specific modules until another product
requires extraction.** Still describe their actual responsibilities and fix
state loss. A large integration adapter is tolerable when its invariants are
explicit and well tested. A 1,339-line host that also defines product policy
should not be described as an already reusable platform.

## Proposed follow-up commits, only after selection

| Commit | Bounded change | Acceptance |
| --- | --- | --- |
| `fix(web): keep layout persistence working without browser storage` | Isolate local fallback failure from API save scheduling | Throw from storage; API save still runs; failure is visible; restore precedence stays explicit |
| `refactor(web): declare attention policy with route contributions` | Move the existing route/channel mapping after attention semantics are chosen | Classic and Golden navigation still agree; no route loses expected attention behavior |
| `refactor(web): separate sheet history transitions from table effects` | Pure model for recording/truncating/replaying edit and move history | Refresh adds no history; rejected edits do not corrupt history; active editor and row expansion survive |

Before any adapter extraction, run the relevant Tasks/Bugs/Inbox/detail,
stability, and error-boundary Playwright suites through `bun run test:e2e:web`.
Include split/resize, profile refresh, dark/light editing, undo/redo, and
restored deep links. Keep renderer-library upgrades out of the refactor.

The reusable future product is a bench with replaceable recipes. It is not
Coleo with every noun generalized and every side effect hidden behind a hook.
