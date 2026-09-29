# The bench: separate tools from product recipes

**September 29 disposition:** select a portable resource core, generic collection
rendering, semantic slots, and a shared visual/text toolbar model. The
[implementation plan](./implementation-plan.md) supersedes the alternatives and
classic-shell preservation requirements below; these remain the original review.

**P2 — observed dependency mismatch; refactoring deferred.**

The workbench README calls its folder reusable application-shell behavior;
the guide says design-system components do not know about tasks, Arms, Brain,
or routing. The four-layer story is a useful direction, but it is not an
enforced dependency boundary today.

## What the code actually owns

| Code | Actual responsibility | Reuse assessment |
| --- | --- | --- |
| `resource-sheet-model.ts` | Pure filtering, sorting, column projection, stable row identity, move neighbors | Strongest candidate for reuse; needs only structural data contracts |
| `AdaptiveCardCollection.tsx` | Ordered generic items, CSS layout, animation, injected card rendering | Mostly a generic collection; its name and presentation types tie it to cards unnecessarily |
| `ResourceSheet.tsx` and `resource-sheet-tabulator.ts` | React/Tabulator lifetime, editing, undo, row details, vendor mapping | Useful adapter; public columns still expose Tabulator `Validator` and Coleo status entities |
| `TaskSheet`, `BugSheet`, `DiscoverySheet`, `ArmCollectionRow` | Domain schemas, statuses, mutations, navigation or presentation | Product recipes, despite living beside generic infrastructure |
| `CollectionViewToolbar` and `SheetWorkspaceToolbar` | Visual controls plus profile-backed template lookup | Application compositions inside the visual foundation |
| `types.ts` | Both generic preferences and Coleo `ResourceKind`, `ArmRun`, channel unions | A shared file, not a portable domain model |

Evidence: [pure sheet model](../../../src/web/src/workbench/resource-sheet-model.ts),
[collection](../../../src/web/src/workbench/AdaptiveCardCollection.tsx),
[column contract](../../../src/web/src/workbench/resource-sheet-tabulator.ts),
[task recipe](../../../src/web/src/workbench/TaskSheet.tsx),
[collection toolbar](../../../src/web/src/design-system/CollectionViewToolbar.tsx),
[sheet toolbar](../../../src/web/src/design-system/SheetWorkspaceToolbar.tsx),
[status palette](../../../src/web/src/design-system/resource-status-styles.ts),
and [contracts](../../../src/web/src/workbench/types.ts).

The toolbar dependency is especially concrete: visual components call
`useToolbarTemplate`, which requires the workbench's profile context. Meanwhile
the template provider imports parsing through the design-system module. A new
application cannot take that toolbar as a visual primitive without taking
profile wiring too. This is an ownership inversion, not evidence of a runtime
module-cycle failure.

`ResourceSheetColumn<T>` is generic over rows, but its `validator` is a Tabulator
type and `statusEntity` selects task/bug styling. Calling the whole contract
vendor-neutral overstates it. The pure projection model really is neutral;
the renderer-facing column contract is deliberately adapted to a vendor.

## Direction to choose

**Recommended: keep a small reusable core and explicit Coleo compositions.**
An eventual dependency direction should read:

```text
Coleo feature → workbench composition → visual primitives / renderer adapter
                       ↓
                pure projection model
```

Start with the toolbar: a visual toolbar receives a template and widgets;
an application wrapper reads the profile. Keep the shared parser in its existing
non-React module, `src/workbench/toolbar-templates.ts`, and import it directly.
The server and browser already sharing that allowlisted schema is a good choice.
Do not replace it with an executable plugin registry.

Treat domain sheets as recipes and eventually colocate them with the feature
that owns their statuses and edits. Do not move dozens of files just to satisfy
a diagram. Name the intended boundary now; move a recipe when changing it.

**Alternative: accept a Coleo-specific workbench.** Revise the documentation to
say that only selected models and primitives are reusable. This is reasonable
if another application remains hypothetical, but the design-system ownership
claim must then explicitly acknowledge its connected components.

## Functional programming that earns its keep

Keep projection as `rows + columns + preferences → projected rows`. Existing
helpers return new arrays without mutating domain records, and stable IDs keep
sorting separate from resource identity. Preserve those properties when adding
filters. Local mutation of a newly allocated Map or array is fine; purity is
about observable effects, not banning every assignment.

Avoid mirrors of derived state and event-counter props. For example,
`TaskSheet` observes `draftFilterToggleRequest` in an effect, changes filters,
then reports `draftsOnly` back upward. A future feature controller can own the
user action and apply a pure `toggleDraftFilter` transformation once. Keep the
previous-status restoration rule; replacing it with a simplistic boolean would
lose existing behavior. React's [effect guidance](https://react.dev/learn/you-might-not-need-an-effect)
supports deriving display values during render and handling user actions where
they occur; external table synchronization still belongs in effects.

Do not turn every type in `types.ts` into a generic framework requirement.
`WorkbenchEvent`, `MetricSample`, and `PlanDocumentRef` have no consumers found
outside their declarations in the inspected frontend. They communicate intent,
but they are not evidence that the app executes through a unified model.

## Proposed follow-up commits, only after selection

| Commit | Bounded change | Acceptance |
| --- | --- | --- |
| `refactor(web): separate toolbar rendering from profile lookup` | Keep connected wrappers at the workbench boundary; pass templates into visual components | Render primitives without profile providers; existing toolbar overrides and both shells behave identically |
| `refactor(web): make draft filtering an explicit view action` | Extract the filter transition and call it from the owning feature | Non-status filters survive; prior statuses restore; no effect-counter protocol |
| `docs(workbench): label product recipes and portable contracts` | Update ownership guidance after the chosen boundary exists | The documented import direction matches actual imports |

For a pivot to a support desk, reuse the collection model, surface primitives,
toolbar renderer, and stable panel identity. Supply ticket fields, ticket
commands, and API queries as new recipes. Keep Brain, Arm, plan reconciliation,
and task lifecycle policy in Coleo. A second real consumer should determine
which remaining interfaces deserve extraction.
