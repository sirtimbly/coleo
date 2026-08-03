# Coleo Design System

This folder is the visual foundation for the workbench. Components here are
compact, theme-aware, keyboard accessible, and deliberately unaware of Coleo
domain objects.

Use these primitives before adding one-off cards, headers, rows, badges, empty
states, or toolbars. Domain features may compose them but should not duplicate
their spacing, borders, density, or interaction states.

The existing CSS custom properties remain the source of truth for color and
typography. Handsontable receives an adapter theme in `sheet-theme.css` so its
spreadsheet surface participates in the same light and dark themes.

Sheet row formatting uses the semantic Blue, Green, Orange, and Purple choices.
Persisted legacy Emerald, Amber, and Rose values are normalized when rendered so
existing user formatting continues to appear with the corrected palette.

Task and bug sheets share `SheetWorkspaceToolbar` for search, counts,
Burndown/Activity selectors, filters, and actions. Handsontable header
highlights use the same muted accent mix as selected cells instead of its
default white active-header treatment.

Task and bug lifecycle colors live in `resource-status-styles.ts`. Burndown
legends, chart segments, and editable sheet status cells consume that shared
palette so analytical and operational views never assign different meanings to
the same color.
