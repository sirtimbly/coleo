# ADR-013: General-Purpose Arm Governance

## Status

Accepted

## Date

2026-09-22

## Context

ADR-009 establishes arms as general-purpose executors whose behavior is driven
by task classification and the supplied context bundle. Earlier design material,
including the reputation portions of ADR-006 and the governance model, describes
persistent arm reputation and domain-related influence. Those mechanisms would
make an arm's identity a reusable rank and create implicit specialization.

Phase 14 needs a governance model that can assess proposals, reviews, and risky
actions without reintroducing arm-global reputation or domain routing.

## Decision

Arm identity is operational only: it may identify an active process, its
harness, availability, lease, and current task. It must not carry a persistent
domain, expertise, ownership area, or reputation that changes task assignment,
review selection, proposal influence, conflict resolution, survival, or cloning.

Task classification, context, policy, and current eligibility determine whether
an arm can perform work. If more than one eligible arm is available, the Brain
may use deterministic non-specializing scheduling such as capacity, lease
availability, or round-robin selection. It must not select or prioritize an arm
by domain, expertise, identity, or historical reputation.

Governance decisions are proposal- and task-scoped. Consensus and escalation use
the proposal's arguments, linked files and diffs, test and validation evidence,
risk and rollback information, task classification, explicit human-provided
weights, and policy-defined thresholds. A signal's effect is derived from that
evidence and policy, not from its author's persistent score.

Historical work outcomes may be retained as time-bounded audit telemetry linked
to a task, pass, proposal, or decision. They are not a reputation score and may
not automatically route future work or weight future governance decisions. A
human may add an explicit, recorded, proposal-specific trust annotation when
needed; it expires with that decision and is reviewable like other evidence.

## Consequences

- ADR-006 is superseded for reputation, reputation-based survival or cloning,
  and assignment or influence effects. Personality and convictions are not
  governed by this decision, but they cannot become a proxy for routing or
  weighted influence.
- Phase 14 must use evidence-backed consensus and human or policy-defined
  review thresholds. Its reputation hooks remain disabled unless a later ADR
  explicitly changes this decision.
- Legacy `domain`, `expertise`, and `reputation` fields may remain temporarily
  for migration compatibility, but are non-authoritative and must not be read
  by assignment, watcher selection, proposal weighting, or conflict resolution.
  Their removal or neutralization requires a migration and regression coverage.
- The legacy domain-prioritized watcher selection and any reputation-weighted
  governance behavior must be removed before Phase 14 governance is enabled.
- Acceptance coverage must demonstrate that any eligible arm can receive every
  task classification and that changing legacy domain or reputation data cannot
  alter assignment, review selection, consensus, or conflict outcomes.

## Related Decisions

- ADR-006: Arm Personality and Convictions (partially superseded)
- ADR-009: Arms Are Not Specialized - Context-Based Task Classification
- Phase 14: Governance in `.project/plan.md`
