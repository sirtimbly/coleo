# Workbench frontend infrastructure

This folder owns reusable application-shell behavior:

- stable resource and projection contracts;
- static contribution registries;
- the single live-update connection and subscription fan-out;
- database-backed profiles, saved views, and layouts;
- shared projection surfaces such as sheets, inboxes, and timelines.

Domain pages should use these services instead of creating their own WebSocket
connections or saving configuration directly to browser storage.

## Task workspace

Task and bug lists give their remaining height directly to Handsontable so long
lists scroll inside the sheet. Search and actions live in the single top
toolbar. Burndown and Activity views are optional insight panels opened by the
compact icon selectors in that toolbar; neither view reserves space until it is
selected.

## Manual sheet ordering

Task, plan-item, and bug sheets expose Handsontable's supported manual row-move
interaction through a dedicated Order gutter. The gutter is both the visible
grip and the row position column: select a row header, then drag it to move the
whole row. Moves are persisted through the domain reorder endpoints, including
neighbor IDs for fractionally indexed tasks. Manual moving is unavailable while
a saved column sort is active so the displayed order and persisted order cannot
contradict one another.

## Creatable tag cells

Task and bug Tags columns extend the native MultiSelect editor with an explicit
Add tag action beside its search input. A new search value is added to the
cell's option source, selected through Handsontable's normal checkbox path, and
saved immediately. Pressing Enter performs the same action. Existing options
are selected instead of duplicated, using a case-insensitive match.
