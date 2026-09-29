# ADR-026: Evaluation Data Contracts

## Status

Accepted

## Date

2026-09-22

## Context

Phase 2 requires every evaluation run to carry enough metadata for
replay. Two mature implementations exist: the classification bakeoff
(`src/scripts/classification-bakeoff.ts`) with sha256 fingerprints,
full metadata, snapshot-before-inference, exclusive writes, and
redaction; and swarm persistence (`brain_swarm_evaluations`,
`brain_swarm_actions`, `brain_swarm_recommendations`) with durable
run identity, snapshots, receipts, and context reductions. This
record unifies them into one required contract. It extends ADR-023
(boundaries) without changing it.

## Decision

Every evaluation run — bakeoff, swarm evaluation, or future harness —
records the following, keyed by a durable run ID:

| Field | Rule |
|---|---|
| `run_id` | UUID; primary key wherever persisted |
| `contract_version` | This ADR's version (`eval-contract-v1`); bump on schema change |
| `created_at`, `status` | ISO timestamps; `completed` / `failed` / `cancelled` with failure detail |
| `fixtures` | Corpus name + version (e.g. `synthetic-v1`) and sha256 over the exact case set |
| `labels` | Snapshot of ground-truth labels **before** inference; never edited post-hoc |
| `prompts` | Full prompt text (or template name + content hash) snapshotted before the run |
| `model` | Provider, model name **and served-model response field**, endpoint origin, parameters (temperature, retries, timeouts) |
| `metrics` | Metric definitions + versions; per-case attempts with elapsed, usage, and redacted logs |
| `reports` | Summary artifact referencing `run_id`; exclusive (`wx`) writes, never overwrite |
| `recommendations` | Advisory only; each tied to its evaluation ID with disposition lifecycle |
| `provenance` | Parent run, code/config version, input snapshot reference, environment (host, SDK versions), budget |

Reproduction rule: fingerprint (or equivalent hash) MUST cover
fixtures + prompts + requests; reruns compare fingerprints before
comparing outcomes. Secrets are redacted before persistence; runs fail
closed without credentials. Resource budgets (context, timeouts,
concurrency, cost caps) are recorded, not assumed. Retention for
evaluation tables is still undecided — explicitly future work, not
implicit permission to prune.

Swarm-side gap to close: persist the prompt template version/hash per
evaluation (templates are content-hash-checked at write time but the
version is not stored on the row).

## Consequences

- New evaluation harnesses must emit this contract or be rejected at
  review; partial metadata (model name without served-model, prompts
  by reference only) is a defect.
- Phase 6+ consumers may read evaluations for calibration and
  bakeoff comparison only; application to tasks/plans/leases still
  requires explicit API-mediated actions per ADR-023.

## Related Records

- ADR-023 (boundaries), ADR-016 (sources of truth), ADR-017 (outputs)
- `src/scripts/classification-bakeoff.ts` (reference implementation)
- Swarm: `src/brain/swarm/*`, `src/db/swarm-actions.ts`,
  migrations 070/071
