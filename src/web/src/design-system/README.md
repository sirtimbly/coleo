# Coleo Design System

This folder is the visual foundation for the workbench. Components here are
compact, theme-aware, keyboard accessible, and deliberately unaware of Coleo
domain objects.

Use these primitives before adding one-off cards, headers, rows, badges, empty
states, or toolbars. Domain features may compose them but should not duplicate
their spacing, borders, density, or interaction states.

The existing CSS custom properties remain the source of truth for color and
typography. Tabulator receives an adapter theme in `sheet-theme.css` so its
spreadsheet surface participates in the same light and dark themes.

Sheet row formatting uses the semantic Blue, Green, Orange, and Purple choices.
Persisted legacy Emerald, Amber, and Rose values are normalized when rendered so
existing user formatting continues to appear with the corrected palette.

Task and bug sheets share `SheetWorkspaceToolbar` for search, counts,
Burndown/Activity selectors, filters, and actions. Tabulator headers, rows,
editors, menus, and selection states use the same Coleo token palette.

Task and bug lifecycle colors live in `resource-status-styles.ts`. Burndown
legends, chart segments, and editable sheet status cells consume that shared
palette so analytical and operational views never assign different meanings to
the same color.

## Shape contract

`shapes.css` is the single shape policy for the web app, including HeroUI,
native controls, Adaptive Cards, Tabulator editors, and Golden Layout. It is
imported after the library styles in `index.css`; both themes use the same values.

| Element | Radius | Token |
| --- | --- | --- |
| Action buttons, menu actions, selectable segments | 0 px | `--shape-button` |
| Cards, panels, dialogs, menus, segmented-group frames | 2 px | `--shape-container` |
| Small details and inset decorations | 1 px | `--shape-detail` |
| Single-line text/search/numeric fields | 2 px | `--shape-field` |
| Navigation buttons | Pill, no border | `--shape-navigation` |
| Textareas and selects | 2 px | `--shape-container` |

Status dots, radio indicators, avatars, and progress tracks keep their intentional
round geometry. Inputs embedded inside a compound field or a spreadsheet cell
stay flush; the containing field owns the outline.

`controls.css` holds shared library adaptations. For example, a select value
must not copy a menu checkmark into the trigger and enlarge the field.

Use the semantic tokens in custom CSS. Existing `rounded-md` through `rounded-4xl`
utilities resolve to 2 px, and `rounded-xs`/`rounded-sm` resolve to 1 px. Do not add
page-specific shape overrides, arbitrary radii, or toolbar descendant rules.
The role-based control rules deliberately override legacy radius utilities so
the same button keeps its shape inside and outside a toolbar.

`NavigationButton` opens another route or screen. It has a subtle background, no
border, and a pill silhouette; native anchors or buttons can use
`data-navigation-control` for the same treatment. Do not infer navigation from a
ghost variant: Save, Start/Stop, refresh, filters, and toggles remain square.

`ToolbarToggleButton` is for independent on/off actions. `SegmentedPanelControl`
is for mutually exclusive optional panels; the selected segment has an underline,
and pressing it again clears the selection. Both consume the same shape policy.

Run `bunx playwright test e2e/design-system.spec.ts` from the repository root to
check the actual rendered cascade in both themes, including portaled menus.
Review full pages and open overlays as well as isolated controls: a consistent
shape must survive different parents, selection, focus, and narrow toolbars.

## Telemetry filter hierarchy

Use `telemetry-filters` for secondary chart controls: 12 px regular values and
sentence-case buttons, 11 px muted labels, and 28 px field/action heights.
Resolution segments fit inside that height and use a quiet fill plus an underline
for selection. Apply uses the secondary button variant. Keep this compact style
scoped to chart filters; primary page toolbars and task forms retain their sizing.

## Grid typography

Tasks and Bugs expose `Grid font size` first in their View sidebar. Store the
choice in `ViewPreferences.gridFontSize` per saved view. The numeric stepper accepts 8–28 px in 1 px steps, defaulting to 11 px
at default browser zoom. Previously saved Small/Medium/Large values resolve to
11/13/15 px. The ResourceSheet adapter scales headers, tags, and expanded row text with
cells and adjusts row heights. Keep the scale scoped to the grid so toolbar,
configuration, cards, and application typography remain independent.
