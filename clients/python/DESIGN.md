# Textual workbench design

## Document ownership

The top-level `WorkbenchApp` owns Textual `Tabs` and a `ContentSwitcher`.
Each tab mounts an independent Inbox or domain pane. Search, actions, navigation,
collection, detail, and status belong to that pane below the tab strip. Repeated
modules are independent documents. Switching tabs preserves state; closing a tab
removes its widgets and owned asynchronous work.

The tab-bar **+**, Ctrl+O, and command palette open modules. The picker uses an
Input and OptionList, supporting both typed filtering and arrow-key selection.
Textual owns focus routing, modal screens, terminal lifecycle, and tab navigation.

## Space and interaction

- Sidebar: 18 cells initially, with OptionList navigation and labeled filters.
- Collection: 64 cells for tables, 34 for lists/timelines; reserve 28 for detail.
- One-cell dividers support dragging and focused Left/Right adjustments.
- User widths survive refresh and tab changes. Changing presentation width class
  chooses a new appropriate default.
- Below 100 columns, detail replaces the collection. Escape returns; navigation
  is initially hidden and accessible through Sidebar.
- Message/record details use readable cards, Markdown bodies, and Collapsible
  technical data. Full source records remain available for inspection.
- Theme tokens supply colors, surfaces, borders, and focus indications.

Inbox retains its server-authored named-view definitions and operation bindings.
Tasks, Bugs, Brain, and Dashboard use their own domain APIs. CLI output remains
Rich-based and supports the same domain data contracts.

## References reviewed

- [Textual widget gallery](https://textual.textualize.io/widget_gallery/)
- [Layout](https://textual.textualize.io/guide/layout/) and
  [designing a layout](https://textual.textualize.io/how-to/design-a-layout/)
- [Themes](https://textual.textualize.io/guide/design/)
- [Tabs](https://textual.textualize.io/widgets/tabs/),
  [TabbedContent](https://textual.textualize.io/widgets/tabbed_content/), and
  [ContentSwitcher](https://textual.textualize.io/widgets/content_switcher/)
- [OptionList](https://textual.textualize.io/widgets/option_list/) and
  [Collapsible](https://textual.textualize.io/widgets/collapsible/)
- [Workers](https://textual.textualize.io/guide/workers/),
  [screens](https://textual.textualize.io/guide/screens/),
  [input](https://textual.textualize.io/guide/input/), and
  [command palette](https://textual.textualize.io/guide/command_palette/)
- Community guidance: `hyperb1iss/hyperskills` (`tui-design`) and
  `johnlarkin1/claude-code-extensions` (`textual`), checked against the installed
  Textual APIs rather than installed as runtime dependencies.

## Verification

The owned integration runner passed **82 tests** after this redesign, including
wide/narrow layout, independent duplicate tabs, picker navigation, divider keys,
Inbox selection isolation, cancellation on close, HTTP/WebSocket contracts, and
real PTY terminal restoration. Mouse-drag behavior and visual typography have not
been independently verified through an interactive terminal recording.
