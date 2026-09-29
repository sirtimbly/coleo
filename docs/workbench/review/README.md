# Workbench architecture review — September 2026

**Direction selected on 2026-09-29; implementation plan ready for review.**
Start with [the implementation plan](./implementation-plan.md). It records Tim's
decisions and supersedes the alternatives and original ordering below. The
reviewed source snapshot remains `2882047` (2026-09-26). No runtime behavior has
changed; current-implementation ADRs remain current until implementation lands.

Coleo has useful tools on a crowded bench. The strongest abstraction is already
working: a resource can appear in several views without making its renderer
the owner of the resource. Stable identities, targeted Inbox details, API-owned
persistence, and preserved renderer instances are worth keeping.

The weak abstraction is the claim that the shared folders form an independent
workbench. They currently mix tools, Coleo policy, and application wiring. More
generics or a plugin SDK would make that confusion expensive. For a lean team,
the next investment should be reliable state ownership, followed by small
boundaries proven by a second consumer.

## Four decisions, now resolved

| Category | Selected direction | Priority |
| --- | --- | --- |
| **The bench** | Generic resource collections, vendor-free sheet models, semantic panel/control slots, visual and text toolbar editing | Incremental contracts and adapters, followed by editor/schema work |
| **The signal desk** | One Messaging collection endpoint with reliable refresh/recovery; unseen-change dots belong to individual views | Messaging first |
| **The notebook** | Independent panel settings with a simple save/server-refresh flow; full schema migrations with the toolbar work | Profiles and simultaneous-edit conflicts deferred |
| **The panel host** | All identified coupling seams are improvement targets; retain imperative instances, remove classic-only code | Stage behind behavior checks |

The selected order starts with Messaging, then panel independence and simple
settings persistence, renderer boundaries, and the toolbar editor/DSL. CLI
snapshots and a live TUI prove the shared contracts; SwiftUI/Perry remain later
native-client options. There is no durable settings-draft system in this plan.

Hand-authored process templates are now also a first-class goal. The plan's
proposed **workbench blueprints** define coherent resource views and actions
across clients, with authored files separate from independent panel settings.

## Reading the evidence

- [The bench: tools and product recipes](./bench.md).
- [The signal desk: live updates and recovery](./signal-desk.md).
- [The notebook: profile ownership and save consistency](./notebook.md).
- [The panel host: lifecycle and coupling inventory](./panel-host.md).

Findings distinguish observed code from failure scenarios inferred from it.
Priorities describe user impact: P1 is potential lost state or incorrect profile
ownership; P2 is stale data, unnecessary work, or maintenance friction; P3 is
optional extraction. Timing scenarios need focused browser tests before fixes
are called verified. Existing passing tests do not establish their absence.

## The narrative to keep

Use the existing **workbench** metaphor for the frontend. The **bench** provides
surfaces; **product recipes** describe task, bug, mail, and Arm workflows; the
**signal desk** announces changes; the **notebook** remembers the user's view;
the **panel host** places those views. These names describe responsibilities,
not a mandate to rename every file.

Keep Brain and Arms in the product vocabulary. Carrying those names into a
reusable table or preference writer would make another product inherit an
orchestrator it does not need. Prefer concrete implementation names such as
`TaskSheet`, `ViewPreferences`, `ResourceChange`, and `WorkspaceRoute` over a
new hierarchy of abstract managers, engines, or universal resources.

## Scope and delivery

Inspected the two workbench READMEs, ADR-004/012, shared sheets/cards, profile and
toolbar state, route and Golden Layout composition, representative domain
pages, WebSocket transport, workbench API routes, and NATS event/command paths.
This is not a full backend reliability, accessibility, or security audit.

The fresh branch starts at the user's current snapshot. Because that snapshot
contains unpublished commits, the draft PR targets a separate baseline branch
at `2882047`; it must not include those commits as review changes or publish
changes onto the user's existing branch. Retarget after the parent work lands.

The original four commits recorded the documentation/implementation mismatch
without refactoring it. The subsequent plan records the selected direction and
bounded follow-up commits with acceptance checks. Historical chapter
recommendations are evidence, not competing implementation instructions.
Implementation remains follow-up work; acceptance of these documents does not
claim that any runtime fixes are complete.

## Verification at the reviewed snapshot

The focused baseline passed: **27 tests, 0 failures, 117 assertions** across
the resource-sheet model, socket reconnect, task-query cache, refresh gate,
and workbench API foundation suites. The sheet model includes 1k/10k/50k gates;
these measure pure projection work, not browser rendering performance.

```sh
bun test src/web/__tests__/resource-sheet-model.test.ts \
  src/web/__tests__/websocket-reconnect.test.ts \
  src/web/__tests__/task-query-cache.test.ts \
  src/web/__tests__/refresh-gate.test.ts \
  src/api/__tests__/workbench-foundation.test.ts
```

No production code changed. Browser race reproductions, bundle profiling,
full type/lint suites, and end-to-end validation were not run for this
documentation review. Each proposed fix lists the checks needed before it can
be called complete. Tests ran in the isolated worktree using the existing
checkout's installed dependencies; the lockfile was not changed.

Two disposable API probes additionally confirmed that stale view writes can
erase prior changes and that an unsupported bundle schema version is accepted;
the notebook chapter gives the reproduction sequence. The probes used a
temporary database and did not touch project data.

`bun run docs:build` passed. All 42 local links in this review resolved to
existing files, and `git diff --check` passed. The documentation build ignores
dead links globally, so the separate link check is material evidence.
