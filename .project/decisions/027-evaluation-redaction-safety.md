# ADR-027: Evaluation Redaction and Safety Rules

## Status

Accepted

## Date

2026-09-22

## Context

Evaluation fixtures, prompts, and artifacts must never carry secrets,
and evaluation runs must never mutate repositories or trigger external
side effects. Practice exists but scattered: `src/api/swarm-events.ts`
redacts credential-pattern keys, the bakeoff redacts exact credential
values and fails closed without keys, and swarm snapshots note
redaction. This record unifies the rules. It extends ADR-023/026
without changing them.

## Decision

### 1. Secrets and credentials

- Redact **before** fixture/prompt creation, not after: exact
  configured credential values plus key-pattern fields
  (`/api.?key|authorization|password|secret|token$/i`) become
  `[REDACTED]` in persisted artifacts, logs, and error bodies.
- Runs fail closed when required credentials are absent — never fall
  back to heuristic/uncredentialed modes silently.
- Fixtures are scanned for secret patterns at creation; a match aborts
  the run with the offending field named (value never logged).

### 2. Repository mutations prohibited

Evaluation runs are read-only against repositories: no file writes,
no git operations, no migration runs, no config changes. The only
writes an evaluation may perform are its own run artifacts (exclusive
`wx` files) and API-owned evaluation tables through validated
routes. Snapshot inputs before inference so reruns compare
fingerprints, not mutable state.

### 3. External side effects prohibited

No network calls except to the configured model provider endpoints;
no notifications, deployments, messages, or human contact from
evaluation code paths. Swarm effects already flow exclusively through
authenticated adapters with policy gates — evaluation-only modes
must not acquire execution-capable handles at all.

### 4. Prompts

Prompts contain fixture references and rubrics only — never live
credentials, private user content beyond the approved synthetic
corpus, or executable instructions for the surrounding system.
Template changes keep keys stable (existing content-hash checks);
prompt text is snapshotted per run per ADR-026.

### 5. Retention interaction

Redacted artifacts still fall under the undecided evaluation
retention (ADR-026 future work): redaction limits blast radius but
does not grant indefinite persistence. Private source text in swarm
tables remains the motivating case.

## Consequences

- New evaluation harnesses must implement pre-creation scanning,
  fail-closed credentials, read-only repos, and provider-only
  networking, with tests proving each.
- Violations fail the run loudly; silent degradation is itself a
  defect.

## Related Records

- ADR-023 (boundaries), ADR-026 (data contracts)
- `src/api/swarm-events.ts`, `src/scripts/classification-bakeoff.ts`
