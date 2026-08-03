# Tabulator resource-sheet benchmark

This record defines the performance gate for Coleo's Tabulator migration. It
measures the behavior Coleo owns instead of relying on a vendor maximum-row
claim.

## Pass thresholds

| Workload | Automated threshold | Protected behavior |
| --- | ---: | --- |
| 1,000 rows | 50 ms | Resource-to-sheet projection |
| 10,000 rows | 250 ms | Resource-to-sheet projection |
| 50,000 rows | 1,250 ms | Resource-to-sheet projection |
| Interactive browser | 30 s test budget | Initial render, virtual scrolling, dark editors, Golden Layout resizing |
| Live reconciliation | No history loss | React Query/server updates followed by undo and redo API calls |
| Repeated navigation | No runtime error | Tasks, Bugs, and Discovery mount/unmount through the browser suite |

The 2026-08-03 reference run completed the projection workloads in 3.69 ms,
5.23 ms, and 28.00 ms respectively on the migration workstation. Thresholds
remain deliberately wider so ordinary local and CI variance does not create a
false regression.

The model thresholds run in
`src/web/__tests__/resource-sheet-model.test.ts`. Playwright covers the
rendering half of the gate with realistic Tasks, Bugs, plan-item, and Discovery
data. The browser tests select and edit virtualized rows, resize a Golden Layout
pane, reconcile mocked server responses, undo and redo edits and moves, and
navigate repeatedly between resource sheets.

## Implementation notes

- Tabulator renders only the visible DOM rows using its virtual renderer.
- React owns API resources and saved-view preferences.
- One stable Tabulator instance receives same-shape server and stream updates
  through `updateData()`, which does not add them to Coleo's history.
- Coleo owns edit and move history. Structural refreshes may replace rendered
  data without erasing user undo/redo actions.
- Column lookup and reconciliation use `Map` and `Set` indexes so a 50,000-row
  update does not introduce quadratic work.

Run the gate with:

```sh
bun test src/web/__tests__/resource-sheet-model.test.ts
bunx playwright test e2e/tasks.spec.ts
```
