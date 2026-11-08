---
title: Workbench across clients
description: Shared API boundaries, resource views, and live Inbox behavior across Coleo clients.
---

# Workbench across clients

Coleo separates project authority from the interface used to operate it. Web,
Python CLI, Textual TUI, and native macOS clients connect to the same API. The
server owns application rules and persistence; clients present resources and
submit actions.

## Clients and the control plane

[![Clients connect through HTTP to the API; Brain uses API procedures and NATS connects Arm Hosts.](/illustrations/workbench/01-system-boundaries.svg)](/illustrations/workbench/01-system-boundaries.svg)

The separate web host serves browser assets and proxies API, upload, and
WebSocket traffic. The API owns NATS/JetStream integration; Arm Hosts manage
coding-agent processes. The project workspace belongs to the execution
environment, not the remote client's current directory.

Independent clients do not imply identical feature coverage. Textual and native
Tasks/Bugs provide browsing and inspection; their editing workflows remain in
the web client. The Python CLI also provides API-based CSV/editor workflows and
task maintenance. Consult each client guide for supported operations.

## Named views and client catalogs

The builtin `inbox-triage` view is resolved through
`GET /api/workbench/named-views/inbox-triage?client=web`.
Supported client values are `web`, `cli`, `tui`, and `native`.

The definition carries resource identity, queries, field selection, commands,
hierarchy, and presentation intent. **Only Inbox currently uses this named-view
mechanism.** Other modules use domain APIs and coded screens.

Python and macOS module catalogs register launch recipes for supported renderers.
They do not define arbitrary screens or load executable plugins. The builtin
Inbox definition is imported into server code, not watched as an editable file.
Workbench profiles organize preferences and attention state; they do not confer
separate API access rights.

## Snapshots, actions, and recovery

[![Inbox clients load HTTP snapshots, refresh on WebSocket hints, submit revision-checked actions, and reload after reconnect.](/illustrations/workbench/03-snapshot-command-recovery.svg)](/illustrations/workbench/03-snapshot-command-recovery.svg)

HTTP snapshots describe currently known data. Authenticated socket events tell
live Inbox clients when to ask again. The one-shot CLI takes a snapshot and exits;
it does not keep a socket open. Non-Inbox Textual/native modules use periodic HTTP
refreshes.

Inbox actions target explicit loaded members and thread revisions. Incoming
replies do not automatically join an existing selection. Stale revisions require
reload and reselection. A multi-file mail operation can partially succeed;
action results and subsequent refresh failures are separate outcomes.

## Client guides

- [Server and clients](./client-server-separation)
- [Workspace CLI and TUI](../guides/workspace-client)
- [Native macOS client](../guides/macos-client)
- [Component installation](../guides/installation)
- [Brain/API boundary](./brain-api-boundary)
