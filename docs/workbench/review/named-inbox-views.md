# Named Inbox views and coordinated interactions

**Milestone 1c, implemented 2026-10-06.** This connects the early resource-view
definition to an API and a real browser consumer. Next are the CLI snapshot (1d)
and live TUI (1e).

## Try the browser view

Open `/messaging?view=inbox-triage`. The browser resolves the named definition,
then loads the existing scoped Messaging collection with that definition's query.
An explicit facet/mailbox/category in the URL overrides its corresponding default.
The reusable definition supplies search, filters, timestamp order, and page size;
interactive changes configure the current view rather than rewriting the builtin.

The two toolbar tiers come from the definition's semantic slots. The grid uses
its declared fields. The presentation menu offers grid, cards, and timeline.
The timeline currently resolves to a text list, with a visible fallback message.
Presentation changes preserve the query and do not issue another collection read.

The browser adapter groups controls by semantic slot, placing mailbox/category
controls alongside the view selector. It measures their full and icon-only widths
and resolves them into **one row where possible, two rows maximum**. The primary
and secondary slots remain logical groups even when they share a physical row.
Context/search groups align left; action/status groups can align right with
space between them.

When full controls cannot fit within the row limit, the resolver first removes
the title/avatar region, then hides button text while retaining icons, accessible
names, and hover labels. If more space is needed, action buttons consolidate into
an ellipsis context panel first. Status/value controls and then choices can follow,
while toggle buttons remain directly accessible longest. The panel uses the same semantic group
labels and the original controls/callbacks, so disabled actions, filters, and
selection targets retain their behavior. The full layout is restored when the
pane grows. Impossible pinned-width constraints use bounded scrolling within the
same row limit rather than silently removing required controls.

The definition supplies `toolbar.maxRows` and `toolbar.groups` (label/alignment).
Widget registrations supply `layout` defaults, which controls can override:

```json
{
  "id": "mark-read",
  "widget": "inbox.mark-read",
  "label": "Mark read",
  "command": "inbox.mark-read",
  "layout": { "kind": "action", "priority": 60, "collapse": "icon", "overflow": true }
}
```

Within a control kind, higher priority keeps it visible longer. `collapse` can be
`none`, `icon`, `value`, or `hide`. Choices use `value`: compact mode hides the
label/count but preserves the selected value and dropdown arrow, avoiding
indistinguishable filter icons. Overflowed choices render as labeled radio-option
groups in one panel. Identity defaults to `hide`; actions and toggles can collapse
to icons; search narrows to a compact input and stays pinned. Partial overrides inherit the other
widget defaults. These are presentation hints, not permission or query changes.

Packing uses both available rows and backfills spare group space before moving
choices into overflow. Mailbox, compose, category, history, and clear-selection
contributions have separate semantic descriptors, so an action inside a context
group does not force its dropdown into the context menu prematurely.

Keyboard Help is an ordinary action for packing purposes and can move into the
action menu. Its panel still toggles open/closed and shows its active state, but
it does not receive the retention preference used by Metadata and other toggles.
Invoking an enabled overflow action dismisses the menu, allowing the opened panel
to receive focus; choice lists remain open for configuring options.

Source freshness is part of the identity element, replacing the descriptive
subtitle under the title. It does not occupy a separate feedback row. The full
source summary is available on hover when its text is truncated; outage/error
feedback still appears explicitly below the toolbar.

Metadata starts closed. Opening it shows a text-summary fallback above content.
Unread/action counts describe the requested query; the latest timestamp describes
loaded items. Unknown counts stay unknown, and incomplete data is labeled. These
values come from a headless helper that terminal clients can also use.

Focus the named collection or one of its non-editing controls to use:

| Key | Operation |
| --- | --- |
| `/` | Focus search |
| `r` | Refresh the current query |
| `?` | Open interaction help |
| Escape, while help has focus | Close help and restore previous focus |

Help comes from the resolved profile. It also shows terminal mappings and explicit
diagnostics for navigation shortcuts with no browser adapter yet. Next/previous,
open, selection, and folding key adapters remain part of live-client parity in
1e. Existing pointer/thread controls are usable. The named view's top read action
targets an explicit selection and is disabled when there is no selection.

Single-character shortcuts do not fire while typing in inputs, editable content,
or composition input. The handler belongs to the local collection, so keys outside
it do not dispatch to a background Inbox. Refresh is disabled during a mutation or
current load. Modified browser shortcuts retain their normal behavior.

## API contract

Reusable definitions have a separate API namespace from persisted panel settings:

| Request | Response / purpose |
| --- | --- |
| `GET /api/workbench/named-views` | Versioned list of builtin names; initially `inbox-triage` |
| `GET /api/workbench/named-views/inbox-triage?client=web` | Resolved browser definition |
| Same request with `client=cli` or `client=tui` | Identical resource definition and query identity, with client mappings and presentation fallbacks |
| `POST /api/workbench/named-views/resolve` | Validate and resolve `{ "client": "cli", "definition": { ... } }` without replacing a stored definition |

The envelope contains `schemaVersion`, `client`, `definition`, `queryIdentity`,
`features`, and `interactions`. The definition carries query, fields, commands,
two toolbar tiers, optional metadata, renderer choices, hierarchy defaults, and
an interaction-profile reference. Features disclose unavailable implementations
and declared fallbacks. Interactions contain labels, operation IDs, typed values
and targets, effective keys, CLI mappings, and binding-availability diagnostics.

`client` selects a registered adapter contract rather than arbitrary requested
capabilities. Resolving terminal mappings does not start a terminal client or prove
its executable is implemented. Unknown names return 404. Invalid clients,
definitions, future schema versions, and conflicting bindings return 400 with
diagnostics. A failed browser lookup shows an error and retry control before any
collection read, rather than silently displaying a different Inbox.

Resolved definitions are excluded from the browser's persisted query cache. They
are obtained from the current API, and cancelled pending resolutions cannot be
dehydrated into persisted state.

The builtin is imported from the existing JSON fixture into the production recipe.
The broader blueprint format, authoring lifecycle, and visual/text editors retain
their separate plan gates.

## Interaction definition

`interactionProfile: "collection-navigation"` inherits reusable bindings.
The view's `interactions` array adds or replaces bindings by stable ID. Overrides
replace a whole binding, avoiding surprising combinations of inherited keys and
flags. `disabled: true` explicitly removes one. Keyboard mappings have shared
defaults plus optional `web`/`tui` overrides; an empty override disables that
client's keys without changing the other client's mapping.

For example, the shared search binding is:

```json
{
  "id": "search",
  "operation": "collection.search",
  "keyboard": {
    "shared": [{ "key": "/", "scope": "collection" }]
  },
  "cli": { "flag": "--search", "alias": "-s" }
}
```

The registry defines `collection.search` as a query operation bound to
`query.search`, accepting a string. The typed descriptor validates values for
flags and interactive controls. Command operations declare their API command
and exact target; mark-read accepts explicit selected IDs. Navigation defaults
use generic `collection.*` IDs, and the Messaging recipe supplies resource-specific
command references.

Validation covers inherited/overridden bindings, duplicate IDs, overlapping key
scopes, duplicate flags/aliases/subcommands, platform-dependent `primary` modifiers,
host/browser reservations, unknown profiles/operations, and commands absent from
the view. Resource-view validation also checks fields, slot/widget compatibility,
query values, and renderer definitions. Layout and shortcuts never authorize
API actions.

## Code map

| Module | Responsibility |
| --- | --- |
| `src/workbench/resource-view-definition.ts` | Versioned composition and interaction references |
| `src/workbench/toolbar-layout.ts` | Semantic layout hints and deterministic, bounded row/overflow resolution |
| `src/workbench/interaction-definition.ts` | Wire schema, profile resolution, conflicts, key matching, typed invocations |
| `src/workbench/messaging-interactions.ts` | Operation registry, navigation profile, reserved keys |
| `src/workbench/messaging-view-registry.ts` | Production resource/widget/renderer registrations |
| `src/workbench/named-resource-views.ts` | Builtin lookup and client resolution |
| `src/workbench/messaging-metadata.ts` | Shared query/loaded-window metadata values |
| `src/api/routes/workbench-named-views.ts` | Listing, lookup, validation API |
| `src/web/src/pages/MessagingPage.tsx` | Named lookup, query defaults, presentation and metadata state |
| `src/web/src/workbench/ResourceViewToolbar.tsx` | Semantic slots adapted to the existing toolbar renderer |
| `src/web/src/workbench/ResourceInteractionHelp.tsx` | Help generated from effective bindings |
| `src/web/src/workbench/ProjectionInbox.tsx` | Focus-scoped dispatch and grid/card/text presentation |

## Verification

Focused checks cover cross-client definition/query parity, fallbacks, overrides,
conflicts, typed values, command targets, unknown counts, and non-destructive API
validation. Browser checks cover resolved defaults/fields, two toolbars, optional
metadata, presentation switching without refetch, generated help, focus restoration,
typing/modifier/composition guards, and failed lookup. The existing Messaging
recovery suite also passes, including exact nested read selection and one
post-action refresh.

Verified: **67 API/model tests, 291 assertions**, and **10 browser checks** across
the named-view and Messaging recovery suites. After the live cache correction,
all three named-view browser checks passed again. Root typecheck, web lint,
web build, docs build, and whitespace checks passed. The restarted live API
returned 200 for the resolved view; the live browser showed fresh sources,
settled loading, no alerts, and no console errors/warnings after reload.

The toolbar follow-up fixes flex-shrunk selectors, misplaced context controls,
and inconsistent button sizing. Four named-view browser checks now pass, including
a geometry regression with a four-digit count at 1400px, 980px, and 390px in the
Golden workspace. It checks clipping, overlapping controls, squeezed menu text,
compact sizes, and mailbox menu access. Web lint and the production build pass.

Adaptive-layout follow-up: headless tests cover grouping, priority, row limits,
identity/label collapse order, overflow-trigger space, deterministic restoration,
invalid dimensions, and preservation of controls. Browser checks now cover
one-row restoration at 2100px, two-row fitting through narrow panes, icon labels,
grouped overflow at 320px, disabled-action preservation, functional metadata
actions in overflow, and right alignment. Measurement applies the same interface
typography rules as the rendered controls, including single-word capitalization.

Latest adaptive verification: **74 API/model tests, 327 assertions**, and all
four named-Inbox browser checks passed. Root typecheck, web lint, production build,
documentation build, and whitespace checks passed. The live API was restarted
with the layout definitions; a 320px live pane used a grouped overflow panel with
working controls and preserved disabled actions, and a 2300px pane restored one
full-label row. The live browser had no console errors/warnings.

Choice-preserving follow-up: **76 API/model tests, 336 assertions**, and all four
named-Inbox browser checks passed. Checks cover visible selected values on compact
dropdowns, actions-first overflow, directly accessible Help/Metadata toggles,
functional grouped radio options, and two-row backfilling. Typecheck, lint, web
build, and docs build passed. The live 320px pane retains Messages/Inbox values
and both toggles; its overflow panel shows Actions followed by labeled Sort and
Presentation option lists.

```sh
bun test src/workbench/__tests__/ src/api/__tests__/workbench-named-views.test.ts \
  src/api/__tests__/workbench-foundation.test.ts src/api/__tests__/messaging-collection.test.ts
bun run typecheck
bun run --cwd src/web lint
bun run web:build
bun run test:e2e:web e2e/named-inbox.spec.ts e2e/messaging-recovery.spec.ts
bun run docs:build
git diff --check
```
