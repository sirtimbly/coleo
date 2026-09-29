# ADR-025: Recommendation Application Gates

## Status

Accepted

## Date

2026-09-22

## Context

Phase 2 (inserted before task-lifecycle and Agentic Brain work) requires that
recommendations — swarm recommendations, evaluation outputs, and any future
model- or experiment-derived proposals — remain advisory until an explicit
authenticated API action applies them. The plan states: swarm
recommendations remain advisory until a later approved integration
explicitly applies them through normal dependency, lease, approval, and
lifecycle gates.

Existing pieces this record binds (verified 2026-09-22):

- Recommendation persistence is API-owned SQLite: `brain_swarm_evaluations`
  (audit rows, migration `070_swarm_evaluations`), `brain_swarm_recommendations`
  (per-recommendation rows with disposition, migration
  `071_swarm_recommendations`), and `brain_swarm_actions` (receipts with
  `UNIQUE(dedup_key)`, atomic transactional reservation, status-guarded
  finish/reconcile). All writes go through authenticated, Zod-validated
  routes under `/api/brain/internal/swarm` (`src/api/routes/brain-swarm.ts`).
- The swarm runner's execute mode currently applies a bounded set of
  operational effects through authenticated API adapters
  (`dispatchSwarmAction` in `src/brain/swarm/runner.ts`) with the
  reservation ledger. This is interim behavior, not the final gate.
- Prior records define the gates this application must pass through:
  ADR-014 (branch-centered lifecycle; original task is the sole anchor;
  passes on the original task), ADR-015 (Brain API boundary), ADR-016
  (source-of-truth boundaries; generated recommendations are evidence, not
  authority), ADR-018 (assignment and approval gates; readiness is a
  conjunction of prerequisites, dependencies, leases, claims, and approval
  gates), and ADR-023 (evaluation boundaries; §11 promotion requires an
  explicit API-mediated action).
- The Phase 14 governance proposals system (`src/api/routes/proposals.ts`,
  argue/signal/resolve/withdraw) provides the consensus layer for
  policy-significant decisions.

Known conflict, recorded as a named dependency rather than resolved here:
`completed_with_issues` status reports still create a `Verify & Polish`
child task, while ADR-014 requires review/polish passes on the original
task. Durable pass/lease storage is also still pending. Until the lifecycle
reconciliation lands, any application that would require conforming
pass state must fail closed instead of creating nonconforming state.

## Decision

### 1. Recommendations are advisory state

Evaluation rows, recommendations, receipts, inbox projections, and every
other recommendation artifact are decision-support evidence (ADR-016 §1,
ADR-023). Creating them, displaying them, projecting them into the inbox,
or re-evaluating them is always side-effect-free with respect to
authoritative state: no recommendation path may create or transition
tasks, passes, leases, bugs, assignments, or approvals as a side effect of
evaluation or projection.

### 2. Application is an explicit authenticated API command

Promoting a recommendation into work happens only through an explicit,
authenticated API apply action (for example
`POST /api/brain/internal/swarm/recommendations/:key/apply`, or the normal
task-creation/pass routes for recommendations that map to new work). The
apply action requires the shared API key (the Phase 1 authentication
boundary), validates its payload with Zod before any mutation, and carries
a client-supplied idempotency key. The decision actor is the authenticated
client identity; per-user authorization does not exist at this boundary
and must be revisited before multi-user deployments.

### 3. Gates are revalidated at application time

The apply action revalidates everything at the moment of application;
evaluation-time state is never trusted:

1. **Recommendation validity**: the recommendation exists; its disposition
   permits application; its evaluation, evidence, and snapshot references
   resolve; the recommendation version and the target entity's current
   version match. Stale or malformed apply requests are rejected (409/400)
   with no persistence.
2. **Prerequisite gates** (ADR-018 §1): declared dependencies complete, no
   unresolved blocking bug, no conflicting active pass or lease, relevant
   file claims respected, and any required human approval gate satisfied.
   Failed prerequisites reject the application and record the failing gate.
3. **Correct task/pass state** (ADR-014): new work is created on, or as a
   pass of, the original task. Creating review/polish child tasks through
   the apply gate is prohibited. Where the required conforming pass state
   cannot yet be created (durable pass storage pending; the
   `completed_with_issues` child-task conflict), the apply action fails
   closed and records the conflict — it never creates nonconforming
   lifecycle state.
4. **Transactionality**: reservation on the idempotency/dedup key →
   validation → mutation → decision record executes atomically. Concurrent
   applications serialize on the unique key; retries are idempotent and
   return the original outcome rather than duplicating work. A failure
   after reservation leaves an explicit rejected/uncertain decision, never
   silent partial state (the at-most-once discipline of the existing
   swarm ledger applies).

### 4. Immutable decision record

Every application — applied or rejected — persists an immutable decision
containing: actor/auth context, recommendation and evaluation references,
prerequisite validation results, evidence references, resulting task/pass
identifiers when work was created, and the outcome with reason. Decisions
are durable API-owned SQLite rows, auditable alongside the recommendation
disposition (`brain_swarm_recommendations.disposition` records the outcome
in place). Rejected applications remain auditable and do not mutate the
target.

### 5. Interim position on existing swarm execution

The current execute-mode effects (`prompt_arm`, `stop_arm`,
`restart_dev_server`, `preserve_git_work`, `notify_human`,
`comment_task`, `log_discovery`, and bounded `update_task`/`update_bug`
field corrections) are grandfathered interim behavior: they act only on
existing entities through authenticated API adapters with the atomic
reservation ledger, they never create new authoritative work, and every
effect is receipted. Two constraints hold from this record forward:
no NEW direct-execution integrations may be added, and migrating these
interim effects onto the apply gate requires the explicit approved
integration the plan names — evaluation results and new recommendation
sources (bake-off adoption, classification changes, experiment promotion)
must use the apply gate from the start.

### 6. Relationship to governance consensus

The apply gate is the mechanical enforcement point, not a replacement for
consensus. Policy-significant applications — deployment, breaking changes,
model/classifier adoption, governance changes — must additionally route
through the Phase 14 proposal flow (human-approval and quorum gates per
ADR-018) before or as part of application. The apply action records the
governance decision reference; a governance decision alone, without the
apply action, changes nothing operationally.

## Consequences

- Evaluation, snapshot, inbox, and Brain processing paths stay
  side-effect-free; the apply action is the single mutation path from
  recommendation to work.
- Implementation of the apply endpoint must add tests for: missing/invalid
  authentication, malformed and stale recommendations, failed prerequisite
  gates, duplicate and concurrent application, successful task/pass
  creation with evidence linkage, fail-closed behavior on the ADR-014
  conflict, and no-partial-state rollback.
- Until durable pass storage and the lifecycle reconciliation land,
  pass-dependent applications reject with a recorded conflict; this is
  deliberate fail-closed behavior, not a gap to work around.
- New recommendation sources must integrate through the apply gate;
  adding new side-effecting evaluation paths violates ADR-016 §1 and
  ADR-023 §11.

## Related Records

- `.project/plan.md` Phase 2 ("Define recommendation application gates")
- ADR-014 (branch-centered lifecycle), ADR-015 (Brain API boundary),
  ADR-016 (source-of-truth boundaries), ADR-018 (assignment and approval
  gates), ADR-023 (evaluation and experiment boundaries)
- `src/api/routes/brain-swarm.ts`, `src/brain/swarm/runner.ts`,
  `src/api/swarm-inbox.ts`
- `src/db/migrations/swarm-evaluations.ts` (070),
  `src/db/migrations/swarm-recommendations.ts` (071)
- `src/api/routes/proposals.ts` (Phase 14 governance consensus)
