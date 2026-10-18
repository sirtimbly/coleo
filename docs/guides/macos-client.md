---
title: Native macOS Client
description: How the Coleo macOS workbench loads configuration, updates data, manages native tabs, and maps API contracts to SwiftUI screens.
---

# Native macOS Client

Coleo Workbench is a compiled SwiftUI application with runtime configuration and
live server data. It provides Inbox, Tasks, Bugs, Brain, and Dashboard modules in
native macOS tabs and windows.

**The app does not watch source files for changes.** Swift code requires a rebuild;
module catalogs can be reloaded explicitly; operational data updates through the
Coleo API.

## Build and run

Requires macOS 14 or later and a Swift toolchain with the macOS SDK. Run these
commands from the repository root:

```bash
# Run directly through Swift Package Manager
swift run --package-path clients/macos ColeoInboxMac

# Build the local-development app bundle
bash clients/macos/scripts/make-app.sh
open clients/macos/.build/ColeoInbox.app

# Run Swift tests
swift test --package-path clients/macos

# Exercise the optimized code shipped in the app bundle, including refresh races
swift test -c release --package-path clients/macos
```

The bundle script builds a release executable, copies the module catalog into
the app's resources, writes `Info.plist`, and ad-hoc signs the result. Rebuilding
does not update an already-running process: quit and relaunch to use new code.
This is a local-development build, not a notarized distribution.

The client connects to an existing Coleo server; it does not start one. Set the
API URL and key in Settings, or use `COLEO_API_URL` and `COLEO_API_KEY` when
launching the executable. Environment variables take precedence over saved
settings. The default URL is `http://127.0.0.1:8080`.

## What loads when?

| Input | Loading behavior | Applying changes |
| --- | --- | --- |
| Swift screens and behavior | Compiled into the executable | Rebuild and relaunch |
| Starter `modules.json` | Packaged during build; copied to Application Support only on first setup | Supplies initial defaults, not runtime overrides |
| Active external module catalog | Read at every startup and on explicit catalog reload | Edit the file, then choose **Modules → Reload Module Catalog**; no rebuild |
| Inbox named-view definition | Fetched over HTTP when an Inbox document initializes | Open a new Inbox document or reconnect after the server has loaded the new definition |
| Inbox data | Initial HTTP snapshot; WebSocket events trigger subsequent HTTP refreshes | Updates while running; manual refresh is also available |
| Tasks, Bugs, Brain, Dashboard data | Initial HTTP requests, 15-second polling, and manual refresh | Updates while running |

**⌘R refreshes operational data.** It does not reload the module catalog or fetch
a new Inbox view definition. There is no automatic catalog file watcher or
general template hot reload.

## Two configuration layers

### Module catalog: what can be launched

The first-run starter catalog lives in the source tree at:

```text
clients/macos/Sources/ColeoInboxMac/Resources/modules.json
```

On first setup, `WorkbenchWorkspace` copies that starter to the default external
location if no catalog exists there:

```text
~/Library/Application Support/Coleo/modules.json
```

The external file is the authoritative catalog, read at startup. Its contents
replace the launcher list completely; no bundled entries are merged back in.
Removing an entry therefore removes it from the launcher after reload.

**Modules → Choose Module Catalog…** validates and activates a JSON file in place,
then remembers its path for subsequent launches. It does not copy the chosen
file. You can select the source-tree JSON above to edit that file directly during
development, or keep a separate catalog anywhere accessible to the app.

**Reload Module Catalog** explicitly rereads the active file. **Show Module
Catalog in Finder** reveals which file is active. No app rebuild is needed for
catalog edits. Failed reloads report the path and error while retaining the last
valid launcher list. A successful reload clears the error. There is no automatic
file watcher.

For example, this adds another launcher entry backed by the existing Tasks
renderer:

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

Supported renderers are `messaging`, `tasks`, `bugs`, `brain`, and `dashboard`.
Messaging entries additionally require `namedView`; optional `facet`, `mailbox`,
`brainCategory`, and `presentation` values select the initial messaging view.
The catalog does not currently define arbitrary task/bug filters or API endpoints.

Each open document stores a snapshot of its module recipe. Reloading the catalog
changes subsequent launches, rather than changing the meaning of existing tabs.

### Inbox definition: what the messaging screen exposes

Inbox requests the server's `inbox-triage` named view with `client=native`:

```text
GET /api/workbench/named-views/inbox-triage?client=native
```

The resolved definition supplies query defaults, presentations, fields, controls,
and interaction bindings. SwiftUI maps these semantics onto native UI components.
The template does not contain executable Swift or arbitrary window-layout code.

On the server, `server/src/workbench/named-resource-views.ts` imports
`examples/inbox-triage.json` into its registry. It does not reread that file for
each request. A change needs the server to reload/restart or rebuild, depending
on its execution mode, before a new client bootstrap can see it.

**Only Inbox currently uses this named-view mechanism.** Tasks, Bugs, Brain, and
Dashboard have Swift-coded screens using their domain APIs. Their catalog entries
choose an implementation; they do not define the screen's fields and layout.

## Data and document lifecycle

```text
Module catalog → launch recipe → document UUID → document-owned session
                                                    ↓
                                               Coleo HTTP API
                                                    ↓
                                              Native SwiftUI UI
```

- **Independent state:** each tab/window owns its query, selection, pagination,
  and detail state. Multiple copies of a module can coexist.
- **Native tabs:** AppKit owns tab dragging, detaching, merging, and window
  grouping. The native **+** action opens the module picker through
  `newWindowForTab(_:)`; the **Modules** menu provides another entry point.
- **Content below tabs:** module actions and search sit above a native
  `HSplitView`. The sidebar and pane dividers stay within the document content.
- **Inbox live updates:** authenticated WebSocket events invalidate data. HTTP
  snapshots remain authoritative; events are not applied as a second data model.
- **Domain polling:** Tasks/Bugs reload the requested pages and selected detail;
  Brain/Dashboard fetch status and statistics. Dashboard sources load concurrently
  and report failures independently.
- **Request isolation:** generation counters and detail request IDs prevent old
  responses from overwriting newer query or selection state.
- **Lifetime:** closing a window stops its session's live work. Switching tabs
  does not intentionally stop the hidden document's session, so more open
  documents can mean more subscriptions or polling requests.

The client reads no Coleo database, Maildir, or project task files directly. It
has no persistent offline data cache; loaded records are held in memory. Retained
data after a failed refresh is labeled as stale rather than presented as fresh.

## Code map

All paths below are relative to `clients/macos/`.

| File or directory | Responsibility |
| --- | --- |
| `Package.swift` | SwiftPM targets and bundled resources; no third-party Swift package dependencies |
| `Sources/ColeoInboxCore/` | API contracts, models, selection rules, detail presentation, catalog validation, keyboard matching |
| `Sources/ColeoInboxMac/ColeoInboxApp.swift` | Application entry, document scenes, module routing, Settings |
| `Sources/ColeoInboxMac/WorkbenchWorkspace.swift` | Catalog loading, launch coordination, native window lifecycle bridge |
| `Sources/ColeoInboxMac/ModuleTitlebar.swift` | Native tab-plus action and module popover |
| `Sources/ColeoInboxMac/ModuleLauncher.swift` | Modules menu and searchable picker |
| `Sources/ColeoInboxMac/InboxSession.swift` | Inbox state, HTTP refresh, WebSocket connection, settings access |
| `Sources/ColeoInboxMac/ContentView.swift` | Template-driven Inbox controls, collections, and detail pane |
| `Sources/ColeoInboxMac/ResourceModuleSession.swift` | Domain collection paging, overview requests, polling, Brain actions |
| `Sources/ColeoInboxMac/ResourceModule.swift` | Tasks/Bugs tables, filters, search, and detail UI |
| `Sources/ColeoInboxMac/ModuleOverview.swift` | Brain health and Dashboard summaries using Swift Charts |
| `Sources/ColeoInboxMac/WorkbenchKeyboard.swift` | Active-document menu shortcuts and collection-scoped key handling |
| `Sources/ColeoInboxMac/ModuleColumnDefaults.swift` | Initial split-pane widths, leaving subsequent resizing to the user |
| `Tests/` | Contract, selection, API encoding, module, keyboard-routing, and session-race tests |
| `scripts/make-app.sh` | Local release app-bundle packaging |

The UI uses SwiftUI, AppKit, and Swift Charts—not an embedded browser. Core
contracts are separated from UI/session code so they can be tested independently.
Some internal names still say “Inbox” because that was the first module; the
executable and bundle remain `ColeoInboxMac` and `ColeoInbox.app`.

### Release-mode regression coverage

Run tests in release mode when changing async session code. A concurrent
refresh/cancellation stress test reproduced an optimized-build `SIGBUS` in the
Brain/Dashboard task group's tuple-return path with Swift 6.3.3. Its results now
use a concrete `Sendable` struct. The regression test exercises real URLSession
completion and JSON decoding through a local URLProtocol fixture, rather than
mocking the transport interface. The fixed test passes in release mode and with
AddressSanitizer; a compiler/runtime defect is suspected, not independently proven.

## Extending the client

### Add another entry using an existing renderer

Add a recipe to the external catalog and reload it. No client rebuild is needed.
This creates a new launcher entry, not a new renderer implementation.

### Change supported Inbox semantics

Update the server's named definition and reload the server. Open a new Inbox
document to fetch it. Existing native adapters can render supported controls and
presentations; a new widget or operation still needs native implementation.

### Add a genuinely new module type

1. Define its API contracts and validation in `ColeoInboxCore`.
2. Implement its session and SwiftUI screen in `ColeoInboxMac`.
3. Register the renderer in `ModuleCatalog` validation and the module host's
   routing in `ColeoInboxApp.swift`.
4. Add an entry to your active catalog and, for new installations, the starter
   catalog; add tests and documentation.
5. Rebuild and relaunch the app.

Catalogs are declarative launch recipes, not executable plugins. The current
architecture supports adding renderers, but does not load arbitrary UI code from
JSON files.

## Current boundaries

- Tasks and Bugs support browsing, search/status filters, pagination, and full
  detail inspection. Their create/edit workflows remain in the web client.
- Brain supports status inspection and explicit Start/Stop actions. Dashboard
  summarizes Brain, task, and bug APIs.
- Settings store the API URL and key in UserDefaults for this development build;
  Keychain storage is not implemented.
- Document recipes support SwiftUI restoration identity, but full restoration of
  query, selection, and loaded data across launches is not implemented.
- Keyboard behavior combines native menu commands with template-defined Inbox
  bindings. Unit tests cover routing rules; they do not replace physical-key,
  focus, and multiwindow testing.

For implementation-specific design notes, see `clients/macos/DESIGN.md` and
`clients/macos/README.md` in the repository.
