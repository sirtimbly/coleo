# Coleo Workbench — native macOS client (SwiftUI)

Native multi-document client with Inbox, Tasks, Bugs, Brain, and Dashboard modules.
The Inbox uses the same shared contracts as the Python Rich/Textual client (`clients/python/`). It talks
only to the Coleo HTTP/WebSocket API: no SQLite, Maildir, JetStream, or
TypeScript runtime dependency.

The server resolves the view for `client=native` (added beside `web`/`cli`/`tui`
in `server/src/workbench/interaction-definition.ts`). The app builds its
toolbar, presentations, fields, metadata panel, and keyboard shortcuts from
that resolved definition — the same dynamic recipe the Textual TUI uses —
instead of hard-coding the Inbox layout:

- **Native shell** — a resizable SwiftUI `HSplitView` presents a sidebar,
  collection, and reading pane. Semantic template slots map to macOS surfaces:
  the module name becomes the window title; facets and query counts live in the sidebar;
  search/actions live in each tab's content control bar; sort, presentation, and
  metadata are in View Options. Browser toolbar row geometry is not imposed on
  the desktop window. Mailbox/Brain-category filters come from the resolved
  interaction bindings and appear for their relevant facet. Unknown controls
  remain visible as diagnostics in View Options.
- **Windows and tabs** — ⌘N creates a new window for the active module;
  ⌘T opens another copy in a native AppKit tab. Each owns its query, selection,
  detail, and refresh session. macOS supplies tab switching, dragging, and window merging.
  The sidebar can be hidden with the standard toolbar control/View menu.
- **Presentations** — `grid`, `cards`, and `timeline` renderers with the
  definition's declared fields. Native capabilities resolve the real
  `collection.cards` / `messaging.timeline` implementations rather than the
  TUI's list fallback.
- **Hierarchy** — reply trees flatten with fold/unfold; folding preserves
  selection. Focus (list selection) is distinct from checkbox selection.
- **Selection/actions** — exact member IDs frozen with their thread revision;
  new replies are never silently added; `mark-read` is revision-checked,
  reports skipped sent-only context, never auto-retries, and refreshes after.
- **Live updates** — HTTP snapshots are authoritative. The WebSocket client
  authenticates, subscribes, pings every 20s, and treats broadcasts as
  invalidation hints only (coalesced; obsolete generations rejected).
  Socket-only reconnect reauthenticates and reloads. Partial/failed refreshes
  keep labeled retained data and disable actions.
- **Detail** — selecting a row opens its reference independently of listing
  filters; stale detail responses cannot overwrite a newer selection. Native
  cards adapt the web AdaptiveCards creator strip, subject/body hierarchy,
  fact sets, and expandable technical footer. Threads render one card per full
  message, preserving sender, recipients, timestamp, and per-message state.
  Events and status reports use the same shell with summary, status facts,
  issues, blockers, and next steps. Content supports selectable Markdown and
  literal fenced code; Copy Text and Technical Details are local card actions.
  This is a SwiftUI presentation adapter, not a general AdaptiveCards runtime.

## Modules and launcher

Use **Modules** in the menu bar or the native tab bar's **+** button.
The searchable popover offers **New Tab / New Window**.
Drag a tab out into a separate window; **Window → Merge All Windows** brings
compatible workbench windows together. Opening a module repeatedly creates
independent documents rather than replacing the active one.

| Module | Native implementation |
|---|---|
| Inbox | Existing template-driven messaging UI, including all its facets |
| Tasks | `/api/tasks` table, status filters, search, pagination, full task detail |
| Bugs | `/api/bugs` table, status filters, search, pagination, full bug detail |
| Brain | `/api/brain/status`, planning/model health, Start and Stop controls |
| Dashboard | Brain status plus task/bug statistics and native Swift Charts |

Tasks/Bugs currently provide browsing and inspection; create/edit workflows
remain in the web client. Non-Inbox modules refresh every 15 seconds and on ⌘R.
Source failures preserve and label previous snapshots. Search submits with Return.

The catalog is `Sources/ColeoInboxMac/Resources/modules.json`, included in both
SwiftPM builds and the app bundle. **Modules → Load Module Catalog…** validates
and installs a JSON catalog at `~/Library/Application Support/Coleo/modules.json`.
Its entries augment/override bundled IDs; importing another file replaces the
installed catalog. Already open documents retain their launch recipe.

```json
{
  "schemaVersion": 1,
  "modules": [
    {
      "id": "project-tasks",
      "title": "Project tasks",
      "description": "Browse project work",
      "symbol": "checklist",
      "renderer": "tasks"
    }
  ]
}
```

Allowed native renderers: `messaging`, `tasks`, `bugs`, `brain`, `dashboard`.
Messaging recipes additionally require `namedView`; optional initial `facet`,
`mailbox`, `brainCategory`, and `presentation` configure that named view.
Adding a new renderer requires a SwiftUI adapter in the module host; catalogs
are declarative launch recipes, not executable plugins.

## Run

Requires Xcode 16+ / Swift 5.9+ (developed on Swift 6.3, macOS 26, arm64).

```sh
# Fixture server (deterministic, seeded) — from the repository root:
PORT=8091 API_KEY=dev-key bun e2e/support/terminal-bake-off/server.ts &

# Build, test, run:
mise run client:mac:test
COLEO_API_URL=http://127.0.0.1:8091 COLEO_API_KEY=dev-key mise run client:mac:run

# Or directly:
cd clients/macos
swift test
COLEO_API_URL=http://127.0.0.1:8091 swift run ColeoInboxMac
```

Against a real server, use `bun run src/cli/index.ts serve start` (port 8080)
and set `COLEO_API_KEY` if the server requires one. API URL/key can also be set
in the app's Settings (⌘,); environment variables take precedence at launch.

To produce a clickable app bundle:

```sh
mise run client:mac:app   # writes clients/macos/.build/ColeoInbox.app
open clients/macos/.build/ColeoInbox.app
```

Shortcuts are generated from the resolved bindings (help sheet, `?`): j/k or
arrows move and preview, Space selects, Return opens, `/` focuses search, `r` refreshes,
`?` shows help. `mark-read` has no keyboard binding in the named view, so —
like the TUI — it is exposed as a toolbar/menu control, and the help sheet
shows its binding diagnostic.

## Layout

| File | Responsibility (Python analogue) |
|---|---|
| `Sources/ColeoInboxCore/Contracts.swift` | Query normalization + canonical identity, short references (`contracts.py`) |
| `Sources/ColeoInboxCore/Models.swift` | Resolved view, page, hierarchy validation (`contracts.py`) |
| `Sources/ColeoInboxCore/Selection.swift` | Frozen exact member/revision selection (`selection.py`) |
| `Sources/ColeoInboxCore/APIClient.swift` | HTTP/auth, references, actions, row flattening (`api.py`, `snapshot.py`) |
| `Sources/ColeoInboxMac/InboxSession.swift` | Ordered refresh lane, WebSocket lifecycle (`session.py`) |
| `Sources/ColeoInboxMac/ContentView.swift` | Definition-driven toolbar/presentations/detail (`app.py`) |
| `Tests/ColeoInboxCoreTests/` | XCTest against the shared fixtures (incl. server-resolved `native-view.json`) |

Regenerate the native fixture after changing the server resolver:

```sh
bun -e "import {getNamedResourceView} from './server/src/workbench/named-resource-views.ts'; await Bun.write('clients/macos/Tests/ColeoInboxCoreTests/Fixtures/native-view.json', JSON.stringify(getNamedResourceView('inbox-triage','native'),null,2))"
```

## Explicit bounds

- Query `filters` beyond the definition's are rejected, not dropped (the
  definition ships none; Python parity for authored filters is future work).
- The API key is kept in UserDefaults in this development build; move it to
  the Keychain before distribution. The bundle built by `client:mac:app` is
  unsigned and intended for local development.
- Timeline is a native timestamp-ordered list using the real
  `messaging.timeline` renderer ID, not a custom-drawn rail yet.
