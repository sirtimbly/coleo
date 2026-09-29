# ADR-021: Rollback and Migration Safety

## Status

Accepted

## Date

2026-09-22

## Context

Schema, event, deployment, and persistence changes can destroy state
that cannot be reconstructed. The migration runner
(`src/db/migration-runner.ts`) is forward-only: sha256 checksums per
migration, `DATABASE_COMPATIBILITY_EPOCH` gating, and
`DatabaseCompatibilityError` telling operators to "restore a compatible
backup" — there are no down-migrations. The Cloudflare split topology
(`docs/guides/cloudflare-split-runtime.md`) establishes the recovery
baseline: Qdrant snapshots to R2 every five minutes and on graceful
shutdown (`control/qdrant/latest.snapshot`), restore on empty-disk
start, JetStream store upload on graceful shutdown, and durable
consumers acknowledging only after the corresponding write succeeds
(ack-after-upsert, so failed events remain available for redelivery).
Phase 11 event migration is approved but pending; dual-write does not
yet exist. This record sets the safety expectations all such changes
must meet.

## Decision

### 1. Backup before destructive change

Every schema, persistence, event-store, or deployment change is preceded
by a restorable backup recording: what was backed up, version/epoch,
location, retention, integrity verification, owner, and the tested
restore procedure. `DatabaseCompatibilityError` ("restore a compatible
backup") is only actionable if such backups exist and restore has been
drilled. No destructive migration merges without a recorded backup.

### 2. Forward-only schema discipline

- Migrations are append-only with unique ordered identifiers; checksums
  must match or startup refuses (never edit applied-migration records).
- Expand/migrate/contract sequencing: additive changes first with
  backward-compatible readers/writers, data backfill, then removal of
  the old shape in a later release. Readers must tolerate both shapes
  during the window.
- Epoch bumps (`DATABASE_COMPATIBILITY_EPOCH`) are breaking releases:
  they require the matching API release to migrate, a restore path for
  older clients, and an explicit abort/rollback decision point before
  the first production write at the new epoch.

### 3. Event changes: dual-write, idempotency, fallback

- Event-store cutovers (including Phase 11 SQLite → JetStream) require
  an approved dual-write or shadow-write period with idempotent
  consumers, correlation/version metadata, reconciliation between the
  two stores, and replay/redelivery verification before cutover.
- Commit-then-acknowledge ordering is mandatory: durable state commits
  before JetStream acknowledgment, so crash recovery redelivers rather
  than loses events (see Phase 0 retry-safety items).
- SQLite remains the fallback queryable store (ADR-016) whenever
  JetStream is unavailable; consumers must degrade to it, not fail.

### 4. Deployments: flags, staging, rollback criteria

- Behavior and event cutovers ship behind feature flags with staged
  rollout; old readers/writers stay available until replay,
  reconciliation, and evaluation-data checks pass.
- Every deployment records health checks, migration-compatibility
  checks, rollback criteria, and the rollback owner. Rollback restores
  the prior release *and* reconciles state written by the rolled-back
  version (partially applied migrations are reconciled forward or
  restored from backup — never left half-applied).
- The MCP direct-SQLite migration bridge (ADR-012/016) is included in
  rollback planning: schema changes must keep bridge queries working or
  migrate the bridge first.

### 5. Evaluation data

Evaluation fixtures, datasets, and bakeoff outputs are versioned and
retained across rollbacks; a rollback never rewrites evaluation history.
Post-rollback, evaluation locks are verified released before new runs.

### 6. Failure recovery validation

Backup/restore, interrupted-migration recovery, consumer redelivery,
empty-disk restore, and provider-outage fallback are validated with the
authoritative commands (ADR-019) in non-production first. Procedures
without a recorded drill are treated as unverified (`.project/status.md`).

## Consequences

- Phase 6/11/23 persistence work must implement dual-write,
  reconciliation, epoch discipline, and rollback criteria per this
  record — not ad-hoc per migration.
- Any change lacking backup, rollback criteria, and verification method
  fails ADR-017 output verification and ADR-018 gates.

## Related Records

- ADR-016/017/018/020, `.project/jetstream-migration-plan.md`
  (Phase 11), `docs/guides/cloudflare-split-runtime.md`,
  `docs/guides/qdrant.md`, `src/db/migration-runner.ts`
