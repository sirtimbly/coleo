# ADR-014: Branch-Centered Task Lifecycle

## Status

Accepted

## Date

2026-09-22

## Context

Progressive planning keeps the executable queue focused on one next work item.
Its earlier verification workflow created a separate `Verify & Polish` task when
an implementation reported issues. The authoritative plan now requires the
original task and its branch to retain the complete implementation, review,
polish, human-review, and merge history. Creating ordinary review or polish
children breaks that continuity and allows the original work to appear complete
before its acceptance criteria have been met.

## Decision

The original task and its canonical branch are the durable lifecycle anchor.
Implementation, review, polish, human review, and merge are ordered passes on
that task. A pass records its actor, pass type, branch, base and head commits,
diff reference, evidence, findings, outcome, timestamps, and single-use lease.

The first implementation completion ends that implementation pass; it does not
complete the task when evaluation, review, polish, human approval, or merge is
still required. Findings from a completion report create or update the original
task's pending review or polish pass. They do not create a `Verify & Polish`
child task. Human approval and rejection are likewise recorded as structured
passes on the original task.

Progressive planning still selects exactly one next runnable item. A ready pass
on an existing task is eligible work for that calculation, alongside an
implementation pass for a ready task. The Brain scores the task-plus-pass action
and obeys deterministic dependency, lease, review, approval, and merge gates.

A new linked task is permitted only for genuinely independent follow-up work:
it must have distinct acceptance criteria, can progress independently of the
original branch lifecycle, and records its relationship to the source task or
decision. It must not be used to represent routine verification, review, polish,
or a change that still modifies the original acceptance criteria.

## Consequences

- `completed_with_issues`, `issues_found`, and `needs_review` must preserve the
  original task identity and branch and produce auditable pass state rather than
  an automatically generated child task.
- The existing `createVerificationTask` and re-evaluation equivalents are legacy
  behavior. They must be replaced through the durable-pass migration before
  branch-centered lifecycle enforcement is enabled.
- Existing verification child tasks must be migrated to pass history where their
  purpose was review or polish, retaining their comments, reports, activity,
  evidence, and source-task relationship.
- Completion, reviewer assignment, human approval, and merge logic must require
  a matching active pass and lease. No report, comment, or child-task creation
  may bypass those gates.
- Tests must prove repeated review and polish retain the original task ID and
  branch; a completed-with-issues report creates no child; human review gates
  merge; and only independent follow-up work creates a linked task.

## Related Records

- Branch-Centered Iterative Task Lifecycle in `.project/plan.md`
- Progressive planning in `.project/progressive-planning.md`
- Phase 5 and Phase 6 lifecycle/pass tasks in `.project/plan.md`
