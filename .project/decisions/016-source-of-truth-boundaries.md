# ADR-016: Source-of-Truth Boundaries

## Status

Accepted

## Date

2026-09-22

## Context

Phase 0 (`Phase 0: Planning, Architecture, and Execution Preconditions` in
`.project/plan.md`) requires explicit source-of-truth boundaries before any
feature work is assigned. Existing filenames, modified files, generated
artifacts, and tests must not be treated as proof that implementation is
complete. This record confirms the four boundaries named in the plan's
Execution Rules (lines 23-29) and the Phase 0 task
"Define source-of-truth boundaries", and ties each boundary to its
authoritative implementation and governing decision.

Prior records already constrain the pieces: ADR-002 (Maildir), ADR-012
(API-owned SQLite access), ADR-015 (Agentic Brain API boundary), ADR-010
(layered communication), and `.project/jetstream-migration-plan.md` with
Phase 11 (NATS JetStream event sourcing). What was missing was a single
statement of which store is authoritative for what, and what may change a
boundary.

## Decision

### 1. Plan and decision documents remain human-editable and version controlled

- `.project/plan.md` (plus only the sub-plans it explicitly references),
  `.project/decisions/*`, requirements, and acceptance documents are the
  authoritative planning model. They are plain-text Markdown, edited by humans
  (or by arms through reviewed proposals), and tracked in git.
- Verified 2026-09-22: `git ls-files` lists `.project/plan.md` and all
  decisions `001` through `015` as tracked files.
- Generated artifacts, evaluation fixtures, swarm recommendations, bakeoff
  reports, historical classifications, and checkboxes are evidence and
  decision-support data. They do not assign work, override lifecycle gates, or
  mutate authoritative state (plan Execution Rules).

### 2. Maildir remains the interoperable communication store

- Human-agent communication is stored in Maildir format per ADR-002, for
  compatibility with standard email tooling (himalaya, mutt, and similar).
- Implementation: `src/mail/maildir.ts` (with `src/mail/index.ts`), surfaced
  through `/api/mail/*` routes and the Observatory Mail UI; Postmark and
  Cloudflare gateways persist inbound mail into Maildir
  (`src/mail/postmark-gateway.ts`, `src/mail/cloudflare-gateway.ts`).
  A future IMAP/SMTP gateway exposes the same Maildir state; it does not
  replace it.
- No SQLite table or JetStream stream replaces Maildir for interoperable
  communication. Projections and indexes may read from Maildir but must not
  become the canonical mailbox.

### 3. SQLite remains the queryable application-state store

- SQLite (WAL mode, file migrations via `src/db/index.ts` and
  `src/db/migration-catalog.ts`) is the durable, queryable store for tasks,
  arms, discoveries, status reports, claims, and related application state.
- Access boundary: only `src/api/**` (plus `src/db/**` schema/migration
  utilities, tests, and local tooling fixtures) opens SQLite directly, per
  ADR-012. `src/brain/**` runtime must not import `bun:sqlite` or open
  database connections; `src/mcp/**` runtime handlers must use API calls.
  The Brain Agent uses authenticated API routes and API-mediated adapters
  only (ADR-015). The browser workbench likewise uses authenticated API
  routes and never touches SQLite directly.
- Verified 2026-09-22: no `new Database` / `openDatabase` / `initDatabase` /
  `getDatabase` call sites exist in `src/brain/**` runtime code (type-only
  import in `task-regenerator.ts` excepted; tests excluded).
- SQLite ceases to be authoritative for a given boundary only through an
  explicitly approved migration that names that boundary (e.g. a Phase 11
  approval moving a specific event/state slice to JetStream, or a future
  Phase 23 PostgreSQL decision). No such superseding approval exists as of
  this record.

### 4. NATS JetStream is used only according to the approved migration plan

- The approved event/messaging migration plan is
  `.project/jetstream-migration-plan.md`: migrate `arm_events` persistence
  from SQLite toward JetStream streams for event persistence, sourcing, and
  audit, with 7-day stream retention. Corresponding work lives in
  Phase 11 (NATS JetStream Event Sourcing), which is still pending.
- Until a Phase 11 approval names a specific boundary, JetStream is transport
  plus a short-retention event source, not the authoritative state store.
  Connection management lives in `src/nats/server.ts` (`NatsManager` with
  configured transport); durable consumers must acknowledge only after the
  corresponding durable write succeeds (see Phase 0 retry-safety items).
- The Brain Agent must not access NATS/JetStream directly; it consumes events
  through API query/inbox/event routes (ADR-015). The API owns auth,
  validation, schema evolution, and audit for those flows.

### 5. The API is the authenticated integration boundary

- Brain, CLI, Observatory, gateways, and persistence operations integrate
  through the typed, authenticated Hono REST API (and its WebSocket/event
  routes), not through direct storage, transport, harness, or filesystem
  access. This restates ADR-012 and ADR-015 as the enforcement point for all
  four boundaries above.

## Consequences

- New stores, caches, projections, indexes (including Qdrant/vector state),
  and generated files are never authoritative unless an ADR explicitly moves
  a named boundary to them.
- Any proposal to move a boundary must name the affected store, the new
  owner, the migration/dual-write/rollback plan, and the approval gate,
  and must update this record.
- Known exception: `src/mcp/**` runtime (`file-claim-tools.ts`, `utils.ts`,
  `reporting-tools.ts`, `api-db.ts`, `server.ts`) still reaches SQLite via
  `getDatabase` directly. This is permitted only as the ADR-012 migration
  bridge (internal SQL proxy toward domain routes) and must be migrated to
  API-backed access; it must not be extended to new handlers.

## Related Records

- `.project/plan.md` Execution Rules and Phase 0 / Phase 11
- ADR-002 (Maildir), ADR-010 (layered communication), ADR-011 (technology
  selection), ADR-012 (API-owned SQLite), ADR-015 (Brain API boundary)
- `.project/jetstream-migration-plan.md`
- `src/db/index.ts`, `src/nats/server.ts`, `src/mail/maildir.ts`,
  `src/api/routes/mail.ts`
