# ADR-022: Status-Report Foundations

## Status

Accepted

## Date

2026-09-22

## Context

Phase 0 (`Phase 0: Planning, Architecture, and Execution Preconditions` in
`.project/plan.md`) requires status-report foundations to be staged before
task lifecycle work is assigned: the minimum report schema, the durable
storage boundary, routing ownership, and malformed-report handling. Full
reporting, Maildir migration, dashboard work, and human-facing aggregation
remain Phase 7 deliverables and are intentionally out of scope here.

The pieces already exist but were never bound by a single recorded contract:

- `status_reports` table (migration `021_status_reports` in
  `src/db/migrations/schema-02.ts`, registered in
  `src/db/migration-catalog.ts`) and the `StatusReport` type in
  `src/types/index.ts`.
- Authenticated API routes in `src/api/routes/status-reports.ts`, mounted at
  `/api/status-reports` behind `createAuthMiddleware`
  (`src/api/server.ts`).
- The arm-facing `submit_status_report` MCP tool
  (`src/mcp/tools/task-tools.ts`), which validates input with Zod and sends a
  `status_report` message to the Brain over NATS; the Brain persists the
  report through the authenticated API (`src/brain/brain.ts`,
  `src/brain/brain-task-client.ts`) and reads reports back through
  `/api/status-reports` for task determination.
- Prior records constrain the boundaries: ADR-012 (API-owned SQLite),
  ADR-014 (branch-centered lifecycle, original task as the durable anchor),
  ADR-015 (Brain API boundary), ADR-016 (source-of-truth boundaries), and
  ADR-018 (assignment and approval gates).

Open dependency: durable pass/branch storage does not exist yet (ADR-018
records that no durable lease/pass storage exists; Phase 6 will add it).
Status reports therefore cannot yet attach to a pass or branch record, and
this record must not invent a competing local contract for that linkage.

## Decision

### 1. Minimum report schema

A status report is a record from one arm about one original task. The
minimum canonical schema (SQLite column in parentheses) is:

- `id` (`id`): server-generated unique report ID.
- `taskId` (`task_id`): the original task this report belongs to; enforced
  by foreign key to `tasks(id)` with `ON DELETE CASCADE`. Per ADR-014, the
  original task is the sole lifecycle anchor; reports never reference
  generated child or review tasks.
- `armId` (`arm_id`): the reporting arm.
- `status` (`status`): one of `on_track`, `blocked`, `issues_found`,
  `needs_review`, `completed_with_issues`.
- `summary` (`summary`): non-empty human-readable progress or outcome text.
- `issues` (`issues`), `blockers` (`blockers`), `filesChanged`
  (`files_changed`): optional JSON string arrays.
- `nextSteps` (`next_steps`): optional free text.
- `testsStatus` (`tests_status`): optional `passing`, `failing`,
  or `not_run`.
- `createdAt` (`created_at`): submission timestamp.

Optional context not stored in the canonical row (screenshot paths,
screenshots) may travel with the report message but is not required for the
lifecycle contract.

Branch and pass linkage (`branch`, `pass_id`) is a named dependency on
Phase 6 durable lifecycle storage (ADR-014, ADR-018) and will be added by
that work as a schema extension; no local approximation is created now.

### 2. Durable storage boundary

- The SQLite `status_reports` table is the authoritative, queryable store
  for status reports, per ADR-016 §3. Vector indexes (Qdrant status-history)
  and dashboard projections are derived read models, never authoritative.
- Maildir remains the interoperable communication store (ADR-002, ADR-016
  §2). The Phase 7 Maildir migration may deliver report copies to humans
  through Maildir but does not move report authority out of SQLite.
- NATS/JetStream is transport and short-retention event delivery only
  (ADR-016 §4). A `status_report` message on NATS is a delivery vehicle;
  the durable record exists only after the API write to SQLite succeeds.

### 3. Routing ownership

- The API server owns all writes to and reads of `status_reports` through
  the authenticated `/api/status-reports` routes (ADR-012, ADR-016 §5).
- The canonical arm path is: arm → `submit_status_report` MCP tool (Zod
  validation at the tool boundary) → `status_report` message to the Brain →
  Brain persists via `POST /api/status-reports`. The Brain consumes reports
  exclusively through the API for task determination, escalation, and
  aggregation.
- Direct clients (CLI, external integrations) with API credentials may
  `POST /api/status-reports` directly; the same validation applies.
- The known MCP direct-SQLite access (`src/mcp/api-db.ts` and related
  runtime files) remains only the ADR-012/ADR-016 migration-bridge exception
  for reads where no API route yet exists. It must not be extended to new
  status-report write handlers, and new report flows must be API-backed.

### 4. Malformed-report handling

- Malformed submissions are explicit validation failures at the API
  boundary: HTTP 400 with a field-level error message, produced before any
  database write. They are never persisted, never partially written, and
  never mutate task, arm, or lease state.
- Required fields (`taskId`, `armId`, `status`, `summary`) must be present
  and well-typed; `status` and `testsStatus` must match their canonical
  enums; `issues`, `blockers`, and `filesChanged` must be string arrays. The
  database CHECK and FOREIGN KEY constraints remain as a last-resort
  integrity backstop, not as the primary validation mechanism.
- A rejected report has no lifecycle effect: no silent requeue, no task
  state transition, and no completion transition. The reporting arm must
  resubmit a corrected report.
- When Phase 6 pass storage lands, lifecycle work will route rejected or
  incomplete report submissions into an explicit clarification/verification
  pass on the original task (ADR-014); until then, the 400 response plus the
  arm-visible error text is the entire malformed-report contract.

## Consequences

- Lifecycle phases (assignment gating, review/verification passes, output
  verification) can rely on: reports being keyed to the original task,
  SQLite/API as the only authoritative record, and malformed submissions
  being unable to change any state.
- Adding `branch`/`pass_id` linkage later requires a schema extension
  migration owned by the Phase 6 durable-lifecycle-storage work, which must
  update this record.
- New status-report producers must integrate through the API (or the MCP
  tool → Brain → API path); direct SQLite writes from `src/mcp/**` or
  `src/brain/**` runtime code are violations of ADR-012/ADR-016.
- The Phase 7 deliverables (Maildir report migration, human-facing
  aggregation, dashboard surfaces) build on this boundary and must not
  redefine it.

## Related Records

- `.project/plan.md` Phase 0 ("Stage status-report foundations before
  lifecycle implementation") and Phase 7 (full reporting deliverables)
- ADR-002 (Maildir), ADR-012 (API-owned SQLite), ADR-014 (branch-centered
  lifecycle), ADR-015 (Brain API boundary), ADR-016 (source-of-truth
  boundaries), ADR-018 (assignment and approval gates)
- `src/db/migrations/schema-02.ts` (migration 021),
  `src/db/migration-catalog.ts`
- `src/api/routes/status-reports.ts`, `src/api/__tests__/status-reports.test.ts`
- `src/mcp/tools/task-tools.ts` (`submit_status_report`),
  `src/brain/brain.ts` (status-report processing),
  `src/brain/brain-task-client.ts`
- `src/types/index.ts` (`StatusReport`)
