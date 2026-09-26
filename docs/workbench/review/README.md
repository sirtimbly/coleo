# Workbench architecture review — September 2026

**Decision status: proposed; awaiting product direction.** Reviewed snapshot:
`2882047` (2026-09-26). This review records findings and implementation options;
it does not supersede ADR-004 or change runtime behavior.

Coleo has useful tools on a crowded bench. The strongest abstraction is already
working: a resource can appear in several views without making its renderer
the owner of the resource. Stable identities, targeted Inbox details, API-owned
persistence, and preserved renderer instances are worth keeping.

The weak abstraction is the claim that the shared folders form an independent
workbench. They currently mix tools, Coleo policy, and application wiring. More
generics or a plugin SDK would make that confusion expensive. For a lean team,
the next investment should be reliable state ownership, followed by small
boundaries proven by a second consumer.

## Four decisions

| Category | Documented promise versus implementation | Recommended direction | Alternative |
| --- | --- | --- | --- |
| **The bench** | Domain-neutral foundation and feature-supplied projections; shared folders contain task/bug/Arm policy and profile consumers | Distinguish tools from product recipes; move boundaries only as features change | Keep mixed folders and explicitly narrow the portability claim |
| **The signal desk** | Shared projection coordination; one socket exists, but pages also coordinate their own refreshes | One recovery and refresh policy per resource, with snapshot recovery after reconnect | Keep page-owned refreshes and document their explicit recovery obligations |
| **The notebook** | Portable profiles and durable views; ownership, save ordering, and conflict behavior are incomplete | Make profile identity and pending saves explicit; reject stale view writes | Declare attention global and accept last-write-wins preferences as a product limitation |
| **The panel host** | Independent registered view instances; route policy and large imperative lifecycles remain interwoven | Keep the host and adapters; isolate policy and model transitions incrementally | Keep application-specific modules and defer extraction until a second product exists |

These are four choices, not four prerequisites for a rewrite. My recommended
sequence is notebook correctness, signal recovery, then boundary cleanup only
where a feature is already changing. A pivot does not justify building a
framework before another application needs it.

## Reading the evidence

- [The bench: tools and product recipes](./bench.md).

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

The documentation differs from the implementation in the four categories above.
Following the requested decision gate, each category gets a separate
documentation commit. Proposed runtime fixes and all coupling refactors remain
unimplemented until a direction is selected. Each chapter specifies bounded
follow-up commits and acceptance checks rather than treating recommendations
as completed fixes.
