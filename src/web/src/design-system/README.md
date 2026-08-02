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

