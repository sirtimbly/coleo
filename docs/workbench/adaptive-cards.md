# Adaptive Cards in the Workbench

Adaptive Cards are a presentation and lightweight interaction boundary for
Coleo's Inbox, semantic event streams, singleton details, and docked panels.
They do not replace the task, bug, mail, Arm, event, or layout data models.

## Architecture

Every rendered card is a `CardEnvelope`. The envelope selects an immutable
host-owned template version, supplies JSON data, identifies the underlying
resource, and records the target surface. The web host expands the template and
renders Adaptive Cards schema 1.5 with Coleo's host configuration.

Templates cannot select arbitrary URLs, HTTP methods, or service calls.
`Action.Execute` verbs are dispatched through an allowlist. The server
re-authorizes every mutation against the referenced domain resource and treats
all card input as untrusted.

The initial catalog contains:

- `workbench.event@1` for Inbox and semantic Arm/event streams
- `workbench.message@1` for message summaries
- `workbench.resource-detail@1` for singleton detail panels
- `workbench.resource-editor@1` for allowlisted scalar edits

Raw Arm logs, diffs, threaded discussions, charts, tabular sheets, and plan
editors remain specialized Workbench projections.

## Rendering flow

1. A presenter converts a domain value or event into a `CardEnvelope`.
2. The host resolves the exact template ID and version from its trusted catalog.
3. The renderer lazily loads the Adaptive Cards runtime and expands the template.
4. The host intercepts actions and creates a `CardActionRequest`.
5. Navigation actions are handled by the Golden Layout route host. Mutating
   actions are sent to `/api/workbench/cards/actions`.
6. The response can return a replacement envelope or a host navigation target.

Unsupported template or schema versions render a readable fallback instead of
attempting best-effort execution.

## Security and compatibility

- The supported schema is pinned to 1.5.
- Template versions are append-only once released.
- External URLs are blocked by default; host navigation uses route data, not
  template-provided URLs.
- Inputs and action payloads are size-limited and validated on the server.
- Card content must not include secrets. Existing API redaction remains in
  force before presentation.
- The web client dynamically imports the renderer so list and sheet routes do
  not load it until a card surface is opened.

## Rollout

1. Contracts, catalog, host renderer, and Golden Layout card route.
2. Durable `workbench_attention` endpoints and Inbox state.
3. Inbox event/message cards and semantic Arm activity cards.
4. Singleton task/bug detail and edit cards.
5. Unified attention views, browser pop-outs, catalog tooling, accessibility,
   performance, and compatibility tests.
