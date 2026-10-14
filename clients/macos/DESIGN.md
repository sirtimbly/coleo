---
name: Coleo Inbox for macOS
description: A native, template-driven inbox workbench.
rounded:
  code: "4pt"
  search: "6pt"
  card: "8pt"
spacing:
  row-text: "4pt"
  row-controls: "8pt"
  collection-heading: "12pt"
  reply-indent: "14pt"
  detail-content: "16pt"
  reading-pane: "24pt"
---

# Design System: Coleo Inbox for macOS

## Overview

**Creative North Star: "Native macOS workbench"**

The user-pinned reference is Finder and standard macOS window UI. Compact,
familiar SwiftUI controls support scanning activity, selecting exact items for
actions, and reading full content. AppKit owns native window tabs, with independent
state per window. Template semantics choose content; the native host chooses placement.

**Key Characteristics:**
- System-native window chrome, controls, and feedback.
- Compact collections beside a comfortable reading pane.
- Explicit selection and data-freshness states.

## Colors

Use adaptive system semantics, not fixed color literals. Primary and secondary
foregrounds, `textBackgroundColor` for reading, and `controlBackgroundColor` for
cards follow system appearance. `Color.accentColor` marks unread/selection;
orange labels degraded data and unsupported content; green indicates live
connection; red indicates errors. Compact needs-action rows use a labeled flag
rather than blanket red; cards and timeline also use red action indicators.
Native color roles are intentionally not converted into CSS frontmatter colors.
Schema-v2 primitives live in this frontmatter; `.impeccable/design.json` carries
native interaction metadata, with no HTML/CSS component previews.

## Typography

System type: body for rows, semibold for unread titles, caption for secondary
metadata, caption2 for row state labels, headline for collection/card titles,
and semibold title2 for reading-pane titles. Document headings use title3/headline;
code uses monospaced callout. Counts use monospaced digits. Preserve selectable
detail text and native semantic type sizing.

## Layout

- Content-level `HSplitView`: sidebar starts at its minimum (160 pt Inbox,
  150 pt Tasks/Bugs). Lists/cards/timelines start at 340 pt; grids/tables at
  640 pt, clamped to leave at least 280 pt for details. Default window
  1180 × 760 pt; minimum 860 × 480 pt. Standard title bar and native AppKit tabs.
  Each tab contains a control bar above its split panes. Dividers begin below
  that bar; neither sidebars nor controls integrate into window title-bar chrome.
- Sidebar uses `.sidebar` List styling, SF Symbols, native selection, and
  contextual filters. Collection uses `.inset` List styling and reply indentation.
- Use the frontmatter spacing roles. Status has 8 pt horizontal/vertical padding;
  detail content is capped at 760 pt. Let the native split view handle resizing
  and sidebar visibility; there are no web breakpoints.
- Actions and search belong in the tab's content control bar; presentation, sort, and
  metadata use View Options. Status and bulk selection stay below the list.
  The control bar uses ordinary SwiftUI HStack, Button, Menu, and TextField;
  sidebar visibility is document-local and toggles with Control-Command-S.
  `ModuleColumnDefaults` positions native NSSplitView dividers on first layout
  and when the presentation width class or sidebar visibility changes. Ordinary
  refreshes leave user-dragged widths intact. A live 860 pt Tasks window confirmed
  150/428/280 pt panes, with the table narrowed only to fit the available space.

## Elevation & Depth

System window chrome, dividers, semantic backgrounds, and native selection convey
depth. No custom shadow vocabulary. Native focus, menus, selection, and window
motion supply interaction feedback; there are no custom animation timings.

## Shapes

Use native control shapes. The explicit rounded shapes are the toolbar search
field, cards, and literal code blocks, using the frontmatter radius roles.
Cards have a system control background and an accent outline when focused.

## Components

- **Navigation:** facets/counts in the sidebar; mailbox/category filters appear
  for their relevant facet. Unknown controls remain diagnostics in View Options.
- **Windows and tabs:** native AppKit tabs are workspaces, not presentation
  toggles. ⌘T opens another copy of the active module as a tab; ⌘N explicitly
  requests a separate window. Each UUID document owns its module/session.
- **Module launcher:** the native tab bar's plus button opens a 340 pt native popover
  with module search, a Tab/Window segmented picker, and descriptive icon rows.
  The Modules menu mirrors this catalog and adds catalog import/reload commands.
  Inbox, Tasks, Bugs, Brain, and Dashboard are domain modules. Inbox facets stay
  within the existing Inbox sidebar.
  Public AppKit `newWindowForTab(_:)` opens the picker through a window-local
  responder. There is no separate launcher button. New windows show the tab bar
  even with one document so the plus remains discoverable. Native plus-to-picker
  and picker-to-Brain-tab behavior were verified through Accessibility.
- **Domain collections:** Tasks and Bugs use native status sidebars, SwiftUI
  Tables, toolbar search, and resizable detail cards. Tables fill available height;
  loading, empty, retained-data, and detail-error states stay explicit.
- **Brain/Dashboard:** system GroupBoxes and labeled facts present authoritative
  status. Dashboard uses Swift Charts for counts by status. Source failures are
  independent and label retained snapshots; Brain controls disable while acting.
- **Collection:** grid/list, cards, and timestamp-ordered timeline use the resolved
  definition's fields. Reply folding preserves action selection.
- **Selection:** selecting a row previews it; checkboxes/Space independently
  freeze member IDs and thread revision for actions. New replies stay unselected.
- **Reading pane:** selectable text, Markdown headings/inline formatting/rules,
  and literal fenced code. Detail requests reject superseded responses.
- **Message cards:** native adaptation of the web AdaptiveCardView and
  message/event/resource templates. A creator strip (30 pt initials/SF Symbol,
  sender, kind, local options) sits above subject, date, recipients, and full
  Markdown body. An 8 pt rounded system separator outline encloses the card;
  body padding is 16 pt, inter-card spacing 16 pt, outer pane padding 20 pt,
  and content measure 800 pt maximum. Each thread message gets its own card.
  Native disclosure reveals raw technical details; copy-text lives in the menu.
  Only status values are humanized; identifiers and full message bodies remain
  intact. The collection's cards presentation shares the creator/body structure.
- **States:** loading and empty views are explicit. Partial/retained data stays
  labeled and actions are disabled. Connection, errors, and diagnostics are visible.

**Verification limits:** the prior implementation handoff reports Swift build and
existing contract tests passing, and a live fixture inspection of sidebar, compact
rows, toolbar, and automatic detail loading. A macOS screen-recording permission
prompt interrupted further visual QA: there is no screenshot certification.
Narrow-window, dark-mode, and tab interaction visual checks remain manual.
Independent source review verified fixes for failed-action recovery, native key
translation, timeline ordering, and stale detail cleanup. The final release build
passes. No web CSS detector applies to this native UI.

Message-card verification uses offscreen NSHostingView captures at 620 pt light
and 340 pt dark with the existing Unicode/thread fixture. Those captures verify
the renderer's layout, not full-window interactions. Presenter tests cover full
thread content/order/state, single messages, status reports, and event payloads.

The module shell was exercised against the running API: menu-bar launch created
native Inbox/Tasks/Bugs tabs; Open in New Window created a separate Dashboard
window. Live capture confirmed the native three-column Tasks layout after
replacing nested split panes. The toolbar launcher opens its searchable native
popover. Brain/Dashboard snapshots were also inspected through NSHostingView.
Twenty-one tests cover contracts, module registration/document identity, and
collection refresh races. Actual drag gestures and system “always tab” preference
are not automated checks.

The subsequent tab-child layout replaces NavigationSplitView's window-level
integration with standard HSplitView panes and content-level controls. Live
Tasks and populated Inbox captures confirm the tab strip spans above the whole
module, with launcher/search/actions beneath it and dividers confined to the
pane area. All 21 tests and the release app build pass for this layout.

## Do's and Don'ts

- **Do** preserve native controls, semantic type/color, and independent window state.
- **Do** map template semantics to macOS surfaces and expose unsupported diagnostics.
- **Do** keep preview focus separate from frozen action selection.
- **Don't** rebuild browser toolbar rows or paint a custom title bar.
- **Don't** introduce custom fonts or replace native tabs with presentation toggles.
- **Don't** describe unverified screenshots or pending checks as certified results.
