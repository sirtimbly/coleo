---
title: Workbench across clients
description: Illustrated system boundaries, portable resource views, live Inbox flows, and the direction toward organization-specific orchestration.
---

# Workbench across clients

Coleo separates project authority from the interface used to operate it. Web,
Python CLI, Textual TUI, and native macOS SwiftUI clients connect to the same API.
The server owns application rules and persistence; clients present resources and
submit actions. This allows a terminal workflow, a native desktop workspace, and
the browser workbench to coexist without making one client the other's backend.

These illustrations reconcile the documentation at branch snapshot `8b0c2e4`
(`codex/workbench-resource-view-foundation`, reviewed October 17, 2026). The branch's
documentation changes were compared with merge base `acfb53d` against the locally
available `origin/master`. This is a documented architecture snapshot, not a new
runtime verification or a claim that the branch has been released.

**Reading the figures:** teal identifies documented shared boundaries; blue
identifies data/client contracts; coral identifies live hints or actions; amber
with explicit labels identifies tradeoffs, selected follow-ups, or proposals.
Dashed amber shapes and arrows identify planned or illustrative work. Every SVG
has a title, description, and source key, and can be edited as ordinary vector
art. Open the original image to read small labels at full size.

## 1. Four clients and one project control plane

[![Four independently usable clients connect through HTTP to an API boundary. Brain uses the API, NATS connects Arm Hosts, and server-owned stores remain behind the boundary.](/illustrations/workbench/01-system-boundaries.svg)](/illustrations/workbench/01-system-boundaries.svg)

Clients connect by server URL. The browser's separately installed web host serves
assets and proxies API, upload, and WebSocket traffic. The API process does not
serve browser assets. Brain coordinates work through API procedures; the API owns
NATS/JetStream integration, and Arm Hosts manage local harnesses and coding-agent
processes. The project workspace belongs to the execution environment, not the
remote client's current directory. Components can share a host or run separately.

“Complete client” means independently usable within its supported scope. It does
not mean every client currently implements every operation. TUI and native Tasks
and Bugs support browsing and inspection; their editing workflows remain in the
web client. The Python CLI additionally supports API-based CSV/editor workflows,
task maintenance, and other domain command families. [S1, S5, S6, S8]

The map focuses on client, coordination, storage, and execution boundaries.
Model-provider calls, Qdrant, email gateways, and detailed deployment routing are
omitted. It does not propose a new service or deployment topology.

## 2. Portable meaning and native presentation

[![A named Inbox definition carries identity, query, commands, hierarchy, fields, and composition. The API resolves capabilities and bindings for web, CLI, TUI, and native adapters.](/illustrations/workbench/02-portable-view-semantics.svg)](/illustrations/workbench/02-portable-view-semantics.svg)

The portable unit is semantic: resource identity, normalized queries, field
selection, registered commands, exact targets, hierarchy, and presentation intent.
Two toolbar tiers and optional metadata describe purposes that can become flags,
keys, menus, sidebars, or native controls. They do not require two physical rows
in every client. Missing capabilities have declared fallbacks or diagnostics.
Server authorization remains authoritative regardless of layout or key bindings.

The working proof is the builtin `inbox-triage` view, resolved through
`GET /api/workbench/named-views/inbox-triage?client=web|cli|tui|native` (choose one
client value). **Only Inbox currently uses this named-view mechanism.** Other
modules use domain APIs and coded screens. The five responsibilities at the bottom
of the figure are the accepted ownership model; their complete extraction is
staged. Shared TypeScript helpers are useful where compatible, while Python and
Swift use JSON contracts and conformance fixtures without a TypeScript runtime.
[S1, S3, S5, S6, S7]

## 3. Snapshot, command, and recovery flows

[![Inbox sequence: resolve a view, request an HTTP page, read selected sources, return hierarchy and freshness, refresh on WebSocket hints, send exact revision-checked actions, and recover through HTTP after authenticated reconnect.](/illustrations/workbench/03-snapshot-command-recovery.svg)](/illustrations/workbench/03-snapshot-command-recovery.svg)

HTTP snapshots answer what is currently known. Authenticated WebSocket broadcasts
tell live Inbox clients when to ask again. Ordered refresh lanes coalesce bursts,
retain one pending refresh, and reject obsolete query generations. Reconnect
reauthenticates and reloads without requiring a window-focus event. The one-shot
CLI follows the snapshot/action paths and exits without a socket. Non-Inbox
Textual/native modules use periodic HTTP snapshots. [S4, S5, S6]

Actions use explicit loaded member IDs and thread revisions. Folding a branch
does not change selection; incoming replies remain outside an old selection.
A stale revision requires reload and deliberate reselection. Partial source
failures retain labeled data, rather than proving an empty result, and do not
advance traversal. A multi-file mail operation can partially succeed; action
results and subsequent refresh failures must be reported separately. SQLite,
Maildir, and retained events do not form one cross-store atomic snapshot. [S4, S9]

## 4. Movements, motivations, and tradeoffs

[![Five movements: browser aggregation to API projection; language-bound reuse to wire contracts; mixed commands to separate operator and client tools; shared defaults toward independent panels; application configuration toward planned process blueprints.](/illustrations/workbench/04-refactor-movements.svg)](/illustrations/workbench/04-refactor-movements.svg)

The refactor moves domain meaning toward the service contract while allowing
each interface to use suitable native controls. It reduces duplicated projection
policy and ambiguous command targets, but adds explicit cross-language validation,
fixtures, packaging, and migration work. Python/Rich + Textual was selected for
terminal quality and feature coverage after the bake-off; this was a product and
maintenance choice, not a claim that adding a language is free. [S3, S5, S8, S10]

Independent Textual and native documents are implemented. Complete browser panel
settings independence, per-panel attention, the broader renderer/host extraction,
and full blueprint authoring remain separate plan gates. Preserving imperative
renderers, active edits, undo/history, telemetry semantics, and specialized plan
reconciliation remains part of the design. [S3, S10]

## 5. Organization-specific orchestration

[![A proposed adaptation path takes organization intent through agent-assisted implementation and review into monorepo-specific orchestration. Planned process definitions are validated by an API and interpreted by each client.](/illustrations/workbench/05-organization-specific-orchestration.svg)](/illustrations/workbench/05-organization-specific-orchestration.svg)

**Proposed interpretation of the user's motivation:** agentic programming can make
it practical for an organization to build and maintain its own workflows over
the shared foundation. Agents can help draft definitions, implement needed domain
capabilities and client adapters, and exercise contracts; people still define
the process and review the resulting changes. The monorepo directory names and
adaptation arrows in this figure are illustrative, not a documented product
feature or a measured productivity result.

This interpretation connects two documented ideas: Coleo reduces mechanical
agent handoffs while preserving durable intent and oversight, and the accepted
blueprint direction lets teams distribute coherent views/actions for business
processes and team structures. Proposed blueprint examples include triage, ready
work, active work, and review views. No historical novelty claim is made for the
underlying separation of clients, contracts, and domain services. [S3, S11]

**What exists now:** a builtin named Inbox definition and reloadable external
Python/macOS module catalogs. Catalogs register launch recipes for supported
renderers; they do not define arbitrary screens or load executable plugins.
The builtin named definition is imported into server code, not watched as an
editable runtime source. Catalog reload changes future launches, while existing
documents retain their recipes. [S5, S6, S7]

**What remains planned:** file-authored process blueprints with their own source
authority, validation, versions, migration, and visual/text authoring lifecycle.
Their exact directory and YAML/JSONC notation are undecided. Generated toolbar
preference projections are not that future source of truth. New resource
lifecycles, automation rules, storage schemas, and renderer types still require
separately scoped domain/API/client code. “Arbitrary monorepo” describes the
adaptation vision; the docs do not promise zero-configuration support for every
repository or a general executable workflow engine. [S3, S6]

## Reconciliation of overlapping documentation

| Topic | Reconciled reading |
| --- | --- |
| Repository layout | Current paths are `server/src/`, `clients/web/`, `clients/python/`, and `clients/macos/`; root Python metadata is present. Older `src/` paths and descriptions of a future relocation are historical. |
| Terminal choice and commands | Python/Rich + Textual is selected. The current CLI and component guides supersede earlier bake-off/CLI snapshot examples: migrated Bun domain commands direct users to `coleo-client`. `coleo-server` and `coleo-agent` retain host lifecycle roles. |
| Optional web hosting | Earlier optional API-static-hosting wording is superseded by the API-only hosting correction. The independent web host owns assets and proxying. |
| Brain and NATS | S1's connection-settings prose broadly groups API, Brain, and Arm Hosts as NATS-connected. S2 defines the more precise process boundary: Brain uses API procedures, while API owns NATS/JetStream. The illustration follows S2; deployment-wide configuration is not a direct Brain transport edge. |
| Native client status | Earlier review plans discuss a later native spike. The current macOS guide and client product docs describe a working SwiftUI/AppKit client with explicit bounds. |
| Definition, catalog, blueprint | A resolved Inbox view, a client launch catalog, and a future process blueprint are three distinct mechanisms. Existing catalogs are not evidence that the full blueprint lifecycle has shipped. |
| Shared view vs panel state | Native/Textual tab independence does not prove all browser panel persistence and attention gates are complete. Resource, reusable definition, and panel identities remain distinct. |
| Profile attention findings | The September review is a historical snapshot. The branch head specifically scopes Inbox queries and attention to the active profile; old review findings should not all be treated as current defects. This does not make profiles authentication principals or establish all deferred profile work as complete. |
| Demo vs production | `workbench-report.html` contains fixture-driven HTML adapters. Production Messaging, actual Python clients, and the native app have separate implementation/evidence records. A preview is not evidence of executable client parity. |
| Release readiness | Source implementation and local verification records do not establish that new component release assets or notarized macOS artifacts have been published. |

This guide resolves the narrative for the figures without rewriting the dated
review evidence or marking unfinished plan gates complete.

## Source key

| Key | Source and contribution |
| --- | --- |
| S1 | [Server and clients](./client-server-separation.md): component responsibilities, selected-server connections, operator targets, API-only web hosting, current repository layout. |
| S2 | [Brain/API boundary](./brain-api-boundary.md): API-mediated Brain procedures, NATS/JetStream ownership, and ArmAgent/harness boundaries. |
| S3 | [Accepted workbench implementation plan](../workbench/review/implementation-plan.md): semantic composition, five responsibilities, independent panels, blueprints, authoring lifecycle, explicit exclusions and staged gates. |
| S4 | [Production Messaging integration](../workbench/review/messaging-production.md): scoped reads, paging, partial sources, refresh ordering, exact actions, reconnect recovery. |
| S5 | [Python client README](https://github.com/sirtimbly/coleo/blob/8b0c2e4581aad15bb3a8748201582e4d397a7d98/clients/python/README.md) and [Textual design](https://github.com/sirtimbly/coleo/blob/8b0c2e4581aad15bb3a8748201582e4d397a7d98/clients/python/DESIGN.md): independent client, modules/catalog, CLI/TUI boundaries, real HTTP/WS protocol, and current coverage. |
| S6 | [macOS client guide](../guides/macos-client.md), [product commitments](https://github.com/sirtimbly/coleo/blob/8b0c2e4581aad15bb3a8748201582e4d397a7d98/clients/macos/PRODUCT.md), and [client README](https://github.com/sirtimbly/coleo/blob/8b0c2e4581aad15bb3a8748201582e4d397a7d98/clients/macos/README.md): native semantics, module/catalog lifecycle, polling, named Inbox support, and feature limits. |
| S7 | [Named Inbox views](../workbench/review/named-inbox-views.md) and [Messaging baseline](../workbench/review/messaging-contract.md): resolved query/definition/interaction contracts and explicitly declared fallback behavior. Current `server/src/workbench/named-resource-views.ts` also confirms the builtin and four client capability mappings. |
| S8 | [Workspace CLI/TUI](../guides/workspace-client.md), [CLI migration reference](../guides/cli.md), and [component installation](../guides/installation.md): canonical commands, independent components, API-only clients, and host-process distinctions. |
| S9 | [Threading contract](../workbench/review/threading-contract.md): source-owned ancestry, root paging, focus/visibility separation, loaded-descendant selection and revision guards. |
| S10 | [September review](../workbench/review/README.md), its four chapters, and [concluded terminal bake-off](../workbench/review/terminal-bake-off.md): motivation, coupling evidence, tradeoffs, and historical status. |
| S11 | [Philosophy](../philosophy.md): durable plans, productive concurrency, oversight, observability, local ownership, and replaceable coding agents. |

Additional branch context reviewed: root and client READMEs, changed deployment,
distributed, Docker and versioning documentation, component CLI/installation plan,
parity and integration reports, packaging documentation, current VitePress
navigation, and the frontend workbench ownership guide. Historical renamed
source-internal guides and macOS icon artwork notes are not architectural
authorities for these illustrations.

## Reuse and placement

The editable originals live at `docs/public/illustrations/workbench/`. Their
opaque light backgrounds keep diagram contrast stable in light and dark docs
themes. Existing project notices and licensing apply.

The system map fits the client/server guide; the semantics and movement figures
fit the workbench overview and implementation plan. The protocol figure fits
the Messaging production guide. The final figure belongs beside the proposed
blueprint section, retaining its interpretation/planned labels. This page keeps
all five together and provides the source key needed to reuse them responsibly.
