# ADR-026: Swarm Inbox and Snapshot Consistency

## Status

Accepted

## Date

2026-09-22

## Context

Phase 2 requires that swarm snapshots and the inbox projection built from
them are always identifiable and cannot be mistaken for live authoritative
state. A swarm snapshot is a point-in-time evidence bundle consumed by the
evaluation model; the inbox is a human-facing projection of
recommendations. If either lacks identity (what produced it, when, over
which data, with which model) or is treated as current state, evaluation
output can silently drive decisions on stale or partial grounds — the
failure mode ADR-023 §10 (metric/threshold discipline) and ADR-016 §1
(evidence vs. authority) exist to prevent.

Existing behavior (verified 2026-09-22):

- `SwarmSnapshot.window` carries the data window (`since`, `until`,
  `pollIntervalMs`, `windowPolls`), and `coverage` carries completeness
  plus notes (`src/api/swarm-snapshot.ts`,
  `src/brain/swarm/types.ts`). Entities carry a per-entity version
  (`updated_at`).
- Evaluations persist durably in `brain_swarm_evaluations` (migration 070:
  `id`, `created_at`, `mode`, full `snapshot` JSON, `result` JSON — the
  result includes the model ID). Recommendations (migration 071) reference
  `evaluation_id`; action receipts dedup against the recommendation key;
  the inbox projection (`src/api/swarm-inbox.ts`) derives mode and window
  via `JOIN` from those tables, not from a separate cache.
- Package version is available at runtime (`VERSION` in `src/version.ts`);
  repository revision (git HEAD) is not captured anywhere in the snapshot
  path.
- Gaps: the snapshot envelope has no explicit `capturedAt` (only the
  evaluation row's `created_at` after posting implies it); no source
  revision is recorded; staleness and non-authoritative labeling rules are
  undocumented.

Related records: ADR-016 (source-of-truth boundaries), ADR-018 (assignment
and approval gates), ADR-023 (evaluation and experiment boundaries),
ADR-025 (recommendation application gates), migrations 070/071.

## Decision

### 1. Snapshot identity contract

Every swarm snapshot is identified by an envelope with five mandatory
facets, persisted with the evaluation row:

1. **Evaluation run id** — the durable run identity (`randomUUID` assigned
   at persistence). It is the single key linking snapshot → recommendations
   → receipts → inbox. (Implemented: `brain_swarm_evaluations.id`,
   `brain_swarm_recommendations.evaluation_id`.)
2. **Data window** — `since`/`until`/`pollIntervalMs`/`windowPolls`.
   Semantics: the half-open lookback bounds over which events and entity
   updates were collected. (Implemented in `snapshot.window`.)
3. **Captured-at timestamp** — when the snapshot was collected, distinct
   from `window.until`. Interim: the evaluation row's `created_at` serves
   as capture time. Required addition: an explicit `capturedAt` on the
   snapshot envelope, added additively to the snapshot schema.
4. **Model configuration** — model id, provider/endpoint, and served model
   id when the provider supplies one; captured at evaluation time, never
   backfilled. (Implemented: `result.model`; provider/endpoint capture to
   be added alongside `capturedAt`.)
5. **Source revision** — package `VERSION` plus repository revision (git
   HEAD short hash when the runtime can read it) and a brain-config
   fingerprint. Currently not captured; required addition. When a facet is
   unavailable the envelope records an explicit `"unknown"`, never omits
   the field — an unidentified snapshot must be visibly unidentified.

**Coverage is part of identity**: `coverage.complete` and `coverage.notes`
must travel with the snapshot into every consumer. An incomplete snapshot
(ingestion bound hit, event store unavailable) displayed without its
coverage notes is a consistency violation.

### 2. Single source of consistency

The persisted evaluation row is the single authoritative copy of a
snapshot. Recommendations, action receipts, and the inbox projection are
derived views over `brain_swarm_evaluations`, `brain_swarm_recommendations`,
and `brain_swarm_actions` (the existing JOIN in `swarm-inbox.ts` is the
reference pattern). No consumer may keep a separate cached snapshot copy;
inbox and detail views regenerate from the tables so disposition, receipt
status, and window always agree with the audit trail.

### 3. Snapshots are never live state

- A snapshot is point-in-time evidence (ADR-016 §1, ADR-023 §2). Live
  arm/task/bug state exists only in the API-owned database; a snapshot must
  never be written back to, merged into, or treated as a substitute for
  that state.
- **Staleness is defined**: entity content in a snapshot is stale when the
  entity's current `updated_at` is later than `window.until`. Any surface
  rendering snapshot or inbox content must display the data window
  (`since`–`until`) and capture identity (evaluation id / captured-at),
  and must mark content stale when displayed outside its window without a
  fresh evaluation.
- Recommendation application (ADR-025 §3) revalidates against live state at
  apply time precisely because snapshot-time state is advisory; nothing in
  this record weakens that rule.

### 4. Provenance chain integrity

The provenance chain is: snapshot → evaluation envelope → recommendation →
receipt/action → inbox projection. Each link references the previous
(`recommendations.evaluation_id`; `actions.dedup_key` = recommendation id;
inbox JOINs both). When a link is missing (orphaned recommendation, action
receipt without an evaluation), consumers must render the record as
"provenance incomplete" — displayed with an explicit warning, never
silently presented as a normal recommendation.

### 5. Additive schema evolution

The required additions (`capturedAt`, provider/endpoint capture,
source-revision fields on the envelope) are additive: existing persisted
snapshots remain valid, and consumers treat absent facets as `"unknown"`.
No migration of historical evaluation rows is required to adopt this
record.

## Consequences

- Implementation follow-ups (tracked separately, not part of this record):
  add `capturedAt` + provider/endpoint + source revision to the snapshot
  envelope and evaluation persistence; render window/capture identity and
  coverage notes on inbox cards and any snapshot detail view; add a
  provenance-completeness check to the inbox query.
- Consumers of swarm data (UI, Brain, reports) must key off the evaluation
  id and treat `window` + `capturedAt` + coverage as mandatory display or
  filtering metadata.
- Tests for the follow-up work should assert: envelope fields persist and
  round-trip; `"unknown"` is explicit when a facet is unavailable;
  incomplete coverage renders with notes; orphaned recommendations render
  as provenance-incomplete; stale content is marked outside its window.
- This record does not change evaluation, application, or execution
  semantics; it constrains identity, consistency, and display only.

## Related Records

- `.project/plan.md` Phase 2 ("Define swarm inbox and snapshot
  consistency")
- ADR-016 (source-of-truth boundaries), ADR-018 (assignment and approval
  gates), ADR-023 (evaluation and experiment boundaries), ADR-025
  (recommendation application gates)
- `src/brain/swarm/types.ts`, `src/api/swarm-snapshot.ts`,
  `src/api/swarm-inbox.ts`, `src/api/routes/brain-swarm.ts`
- `src/db/migrations/swarm-evaluations.ts` (070),
  `src/db/migrations/swarm-recommendations.ts` (071)
