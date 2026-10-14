# Coleo Workbench for macOS

## Purpose

Help Coleo operators scan project activity, read full content, and act on exact
selected items. Independent modules provide Inbox (`inbox-triage`), Tasks, Bugs,
Brain controls/status, and Dashboard summaries.

## Product commitments

- A normal native macOS SwiftUI window with Finder-like sidebars and native
  AppKit tabs. Each window/tab owns its query, selection, detail, and live session.
- A shared file-backed module catalog powers the Modules menu and searchable
  native tab-plus popover. Modules are application domains, not aliases for Inbox facets.
  Launches create independent documents; tabs can detach into draggable windows.
- A template-file-driven workbench semantic interface: the server resolves the
  named view for `client=native`; declared controls, bindings, fields, and renderers
  determine content and availability. The native host determines placement.
- The existing workflow is browse/filter/search, preview, independently select
  exact members, and mark selection read. Grid, cards, and timeline are collection
  presentations; native tabs are separate workspaces.
- Frozen member IDs and thread revisions keep new replies out of prior selections.
  Partial or retained stale data is labeled and disables actions. HTTP snapshots
  are authoritative; WebSocket events invalidate them.
- Full thread/message/event/record content is readable as selectable native text,
  with lightweight Markdown formatting and literal fenced code.

## Scope and constraints

The client uses Coleo's HTTP/WebSocket API and shared contracts; it has no direct
SQLite, Maildir, JetStream, or TypeScript runtime dependency. Settings configure
the API connection. This is a local-development, unsigned app; its API key is
currently stored in UserDefaults. Timeline is a timestamp-ordered native list.
Tasks and Bugs currently support paged browsing, status/search filters, and
inspection; their editing workflows remain web features. Brain provides Start/
Stop and health information; Dashboard combines Brain/task/bug summaries.
Non-Inbox modules refresh with periodic HTTP snapshots. New native renderer
types require code; JSON catalogs register launch recipes for supported renderers.
Authored Inbox query filters and a general template editor are not implemented.

Source: `README.md` and `Sources/ColeoInboxMac/`; visual rules and verification
limits are recorded in `DESIGN.md`.
