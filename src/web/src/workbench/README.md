# Workbench frontend infrastructure

This folder owns reusable application-shell behavior:

- stable resource and projection contracts;
- static contribution registries;
- the single live-update connection and subscription fan-out;
- database-backed profiles, saved views, and layouts;
- shared projection surfaces such as sheets, inboxes, and timelines.

Domain pages should use these services instead of creating their own WebSocket
connections or saving configuration directly to browser storage.

## Resource details

Sheets with a dedicated resource projection expose `Details` as the first
right-click action. It resolves the clicked Tabulator row through its stable
resource identifier before handing the resource to Golden Layout, so the
action stays correct after filtering, sorting, and manual ordering.

## Task workspace

Task and bug lists give their remaining height directly to Tabulator so long
lists scroll inside the sheet. Search and actions live in the single top
toolbar. Burndown and Activity views are optional insight panels opened by the
compact icon selectors in that toolbar; neither view reserves space until it is
selected.

Tasks entered directly in the workspace start as Drafts and are excluded from
the brain's runnable queue. The `Drafts Only` toolbar shortcut changes the saved
view's status filters, preserving other filter fields and restoring the
previous status selection when the shortcut is disabled.

## Manual sheet ordering

Task, plan-item, and bug sheets expose Tabulator's manual row-move interaction
through a dedicated Order gutter while the whole row remains draggable. Moves
are persisted through the domain reorder endpoints, including
neighbor IDs for fractionally indexed tasks. Manual moving is unavailable while
a saved column sort is active so the displayed order and persisted order cannot
contradict one another.

## Creatable tag cells

Task and bug Tags columns use the documented `tabulator-multiselect.ts` editor.
Its search field filters session-stable known values, and Add tag turns an
unmatched query into a selected value. Existing options are selected instead
of duplicated using a case-insensitive match; Apply commits one undoable API
edit.

## Tabulator upgrade checklist

1. Keep `tabulator-tables` pinned and review release notes before changing it.
2. Run the 1k/10k/50k model thresholds in
   `docs/workbench/tabulator-benchmark.md`.
3. Run the complete Tasks browser suite in light and dark themes.
4. Verify Subject/Status edits, Tags creation, insert/delete, ordering,
   undo/redo, saved columns, and Golden Layout resize/detail handoff.
5. Confirm the production bundle and lockfile contain no retired grid runtime
   or evaluation key.
6. Update `THIRD_PARTY_NOTICES.md` if the pinned version or license changes.
