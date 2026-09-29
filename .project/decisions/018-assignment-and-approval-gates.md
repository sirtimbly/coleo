# ADR-018: Assignment and Approval Gates

## Status

Accepted

## Date

2026-09-22

## Context

The plan's Execution Rules state: no task may be assigned until its
prerequisites, architecture decisions, environment requirements, file
claims, leases, approval gates, and validation inputs are satisfied.
Existing gate fragments are scattered: the `claims` table with MCP
file-claim tools, the file-based evaluation lock
(`acquirePlanEvaluation` in `src/project-setup/evaluation-lock.ts`),
single-use pass leases (ADR-014), the proposal/human-review system
(Phase 14), plan `### Dependencies` parsing, and output verification
(ADR-017). No durable lease/pass storage exists yet — Phase 6 "durable
lifecycle storage" will add passes, leases, branches, and diffs. This
record defines the gate semantics that assignment and later storage work
must enforce.

## Decision

### 1. Readiness is a conjunction

A task (or a ready pass on an existing task, per ADR-014) is assignable
only when all of the following hold:

1. **Dependencies resolved.** Every prerequisite named in the plan's
   `### Dependencies` sections and linked tasks is complete; genuinely
   dependency-blocked tasks with unfinished prerequisites are not assigned.
2. **No conflicting lease.** No active pass/lease exists on the task for
   another arm; completion, review, and merge require a matching active
   pass and single-use lease (ADR-014). Stale-lease rejection must not
   change state.
3. **No conflicting file claim.** No active (`rend_at IS NULL`) `write` or
   `exclusive` claim by another arm covers a `source_file` or `output_file`
   the assignment needs (claims table, `schema-01`; MCP file-claim tools).
   `read` claims never block.
4. **Human approvals satisfied.** Tasks behind a human approval gate
   (proposal consensus requiring human escalation, human-review passes)
   are not assigned or merged until the approval is recorded as a
   structured pass on the original task.
5. **Evaluation locks released.** No active evaluation lock
   (`plan-evaluation.sqlite` ownership with a live PID, or its durable
   successor) covers the work; concurrent or stale evaluation runs must
   not change authoritative state.
6. **Inputs verified.** Referenced acceptance criteria, decisions, and
   plans exist at their declared paths; for follow-up passes, prior
   outputs have passing verification records (ADR-017).

If any gate fails, the item waits. Waiting is explicit scheduler state,
not silent skipping: the reason (which gate, which blocker) is recorded
so the Brain can surface it instead of re-selecting the same item.

### 2. Status-report-created verification and clarification work

A status report that exposes uncertainty — `issues_found`,
`needs_review`, `completed_with_issues`, malformed or ambiguous claims —
creates explicit work rather than directly requeueing, reassigning, or
prompting:

- Findings about the task's own outputs become a pending review or polish
  pass on the original task (ADR-014), gated by the same leases above.
- Questions needing human input become clarification work behind a human
  approval gate; generic email replies are passive comments and do not
  themselves change gates (plan Execution Rules).
- Suspected prerequisite or environment problems become verification work
  that checks the named gate and records evidence, rather than assuming
  the gate is broken.

### 3. What implementation must enforce

Phase 5/6 assignment work must check all six gates atomically at claim,
release, and completion time, reject mismatched lease/pass/task/arm
identity without state change, and use compare-and-set reevaluation so
only genuinely dependency-blocked tasks with all prerequisites complete
and no active pass become ready. Human comments, reports, and child-task
creation must never bypass these gates.

## Consequences

- The Brain's single-next-task calculation may only select items passing
  all six gates; everything else is explicitly waiting with a recorded
  reason.
- Durable pass/lease storage (Phase 6) must preserve these semantics; the
  file-based evaluation lock and claims table remain authoritative until
  their documented successors land.
- Overriding a gate (e.g. emergency human override) is itself a recorded
  approval pass with actor, reason, and timestamp — never a silent bypass.

## Related Records

- ADR-014 (branch-centered lifecycle), ADR-016 (source-of-truth
  boundaries), ADR-017 (task-file/output tracking)
- `.project/plan.md` Execution Rules, Phase 5, Phase 6, Phase 14
- `claims` table (`src/db/migrations/schema-01.ts`),
  `src/project-setup/evaluation-lock.ts`, MCP file-claim tools
