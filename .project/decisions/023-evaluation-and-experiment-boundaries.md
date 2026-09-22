# ADR-023: Evaluation and Experiment Boundaries

## Status

Accepted

## Date

2026-09-22

## Context

Phase 0 (`Phase 0: Planning, Architecture, and Execution Preconditions` in
`.project/plan.md`) requires evaluation and experiment boundaries to be
defined before lifecycle and governance work consumes evaluation output.
Existing evaluation-related filenames — swarm evaluation, classification
bake-off, historical classification, evaluation lock, Brain Swarm controls,
swarm routes, swarm snapshots, swarm inbox, swarm migrations — are inventory
evidence only and were not proof of defined controls.

The plan's Execution Rules already state that generated artifacts,
evaluation fixtures, swarm recommendations, bake-off reports, historical
classifications, and checkboxes are evidence and decision-support data: they
do not assign work, override lifecycle gates, or mutate authoritative state.
What was missing was a single recorded contract covering fixture provenance,
dataset versioning, model/provider configuration, determinism, redaction,
cost limits, output retention, reproducibility, human-label handling,
comparison metrics, and the mutation rule.

Prior records constrain the surrounding architecture: ADR-012 (API-owned
SQLite), ADR-015 (Brain API boundary), ADR-016 (source-of-truth boundaries,
including that no store becomes authoritative without an explicit decision),
and ADR-018 (assignment and approval gates).

Existing implementations this record binds (verified 2026-09-22):

- `src/scripts/classification-bakeoff.ts` with
  `src/scripts/classification-bakeoff/` — an offline, read-only comparison of
  the unmodified `ArmOutputProcessor` and `MailProcessor` against JEV
  (TypeSafe). It uses only synthetic fixtures, refuses to run without both
  provider credentials, snapshots labels and prompts before inference, writes
  exclusive (`wx`) run artifacts, redacts API keys before persistence, and
  takes no action on results.
- `src/brain/swarm/` (`evaluator.ts`, `runner.ts`, `budget.ts`, `types.ts`,
  `prompts.ts`) with `src/api/routes/brain-swarm.ts` (mounted under
  `/api/brain/internal/swarm`, behind the global authenticated
  `/api/*` middleware) — the Brain Swarm evaluation stage. The runner calls
  the API with an API key; every proposal is Zod-validated at the route;
  execution goes through an atomic SQLite reservation in
  `brain_swarm_actions`; evaluation receipts and snapshots persist to
  `brain_swarm_evaluations` (migration `070_swarm_evaluations`); shadow mode
  is proposals-only and per-action modes can force proposal-only regardless
  of the global mode.
- `src/project-setup/evaluation-lock.ts` — a PID-aware single-use lock
  (`run/plan-evaluation.sqlite`) preventing concurrent plan rewrites by the
  API and Brain. It is a concurrency guard only.

Known limitations, recorded rather than silently assumed away:

- LLM inference is not deterministic. Seeds and fixed fixtures control
  inputs, not outputs; repeated runs measure stability, they do not
  reproduce predictions.
- The classification corpus (`synthetic-v1`) is author-labeled and small.
  It is not a production sample or independently adjudicated benchmark.
- The evaluation lock is file/SQLite-based and does not provide
  authoritative lifecycle state; durable passes/leases remain future work
  (ADR-018).

## Decision

### 1. Evaluations are a separate, read-only experiment surface

Evaluation and experiment tooling runs against fixed fixtures or snapshots
and is read-only with respect to authoritative state: tasks, plans, leases,
branches, approvals, bugs, and assignments. Evaluation output is an artifact
or report. It never mutates authoritative state on its own; any promotion or
state change requires an explicit, authenticated API-mediated action (per
ADR-012/ADR-015/ADR-016 §5). Offline experiments (the classification
bake-off) take no action at all, even when output resembles an approval or
completion. Online evaluation stages (Brain Swarm) may act only through
authenticated API routes with validation, atomic reservations, and a durable
ledger — never through direct SQLite, filesystem, NATS, or JetStream access.

### 2. Fixture provenance and dataset versioning

- Every fixture carries: a stable case ID, provenance (author, origin, and
  whether it is synthetic or sampled), a human-authored label with rationale,
  and the corpus version it belongs to. The current corpus is
  `synthetic-v1` (`src/scripts/classification-bakeoff/fixtures.ts`), 20
  arm-output cases and 24 human-to-brain cases, all author-labeled synthetic
  challenge cases.
- Corpus changes are versioned: a changed corpus gets a new corpus label,
  and results record the corpus label and a SHA-256 fingerprint of the exact
  scenarios, prompts, and requests, computed before inference
  (`inputs.json` in each bake-off run).
- Fixed evaluation sets are immutable per run: labels and queries are
  snapshotted before any model call, and existing run directories are never
  overwritten (exclusive `wx` writes).

### 3. Model and provider configuration

Every run records the resolved provider, model ID, endpoint origin, SDK
version, timeout, retry policy, and concurrency, plus served model IDs when
providers supply them. Model aliases are treated as unstable; conclusions
attach to captured served IDs. Missing credentials fail the run before
inference (fail-closed), never silently degrade to heuristic-only output.

### 4. Determinism and seeds

Inputs are made deterministic: fixed fixtures, unchanged production prompt
templates, frozen task/arm context, and fixed run parameters (repeats,
concurrency, timeouts). LLM outputs are not deterministic; no seed claim is
made for provider inference. Repeated runs measure label stability and
latency variance; they do not increase the number of independent examples
and must not be reported as independent evidence.

### 5. Redaction

Secrets are redacted before persistence: API keys are removed from recorded
requests, responses, and errors (the bake-off's `redact` over both provider
keys). Keys and request headers are never written to run artifacts. Raw
provider outputs are retained locally for inspection but are separated from
shareable summaries (`report.md` aggregates); any future sharing path must
apply the same redaction.

### 6. Cost limits

Runs operate with bounded spend and concurrency: request deadlines
(default 60s), disabled provider retries (failures stay visible), bounded
concurrency (default 3 pairs), bounded context budgets with explicit,
non-silent reduction (`fitSwarmRequest` refuses to silently discard
protected state), and token usage recorded as reported by providers
(documented as usage, not billed-dollar estimates). A run that cannot bound
its cost must not start.

### 7. Output retention

- Offline experiment outputs live under `test-results/` (gitignored) in
  timestamped, non-overwritten directories. They are local evidence, never
  committed, never authoritative.
- Online evaluation audit records (`brain_swarm_evaluations` snapshots and
  results, `brain_swarm_actions` receipts) persist in SQLite as derived
  audit/decision-support state per ADR-016 §3; they are queryable evidence,
  not task state. Any future retention or deletion policy for these records
  must be recorded before implementation.
- Evaluation outputs never replace the authoritative record they evaluate:
  a swarm snapshot does not become arm/task state, and a bake-off report
  does not become a plan input.

### 8. Reproducibility

A run must capture everything needed to re-run the experiment: corpus
version and fingerprint, exact prompts/queries, provider/model
configuration, run parameters, SDK version, and timestamps. The bake-off
writes `inputs.json` before inference for this purpose. Reproducibility is
defined as re-runnable inputs with recorded configuration, not bit-identical
outputs (see §4).

### 9. Human-label handling

Human labels are first-class data: each fixture label records its author (or
pseudonym), timestamp, rationale, and the rubric/template version used.
Labels are snapshotted before inference and are never overwritten silently;
label corrections create a new labeled version with provenance, preserving
the original. Disagreement between annotators is preserved (multiple labels
per case) rather than resolved by last-write-wins. Fixture labels in the
current corpus are single-author; multi-adjudication, if added, must keep
per-adjudicator identity and disagreement visible.

### 10. Comparison metrics

- Metrics are task-appropriate and defined alongside results: primary label
  accuracy with exact secondary checks (follow-up flag, approval polarity,
  task ID where the fixture specifies), plus latency, fallback/error counts,
  confusion counts, and repeat stability for the bake-off; calibrated
  probabilities, evidence grounding, and repeat-suppression behavior for
  swarm evaluations.
- Every report records metric definitions, the baseline being compared
  against, run configuration, and pass/fail thresholds chosen before
  viewing results.
- Confidence from models (e.g. JEV probabilities) is retained for
  inspection but is not used to tune thresholds on the small synthetic set.
- Deployment claims require a separately labeled holdout set; stability
  claims require more than repeated runs of the same fixtures.

### 11. Promotion requires an explicit API-mediated action

Evaluation output — including shadow-mode swarm proposals, bake-off
reports, and any model-generated recommendation — cannot change task
priority or state, plan content, leases, branches, approvals, bug state, or
assignments without an explicit action through the authenticated API
(ADR-012, ADR-015, ADR-016 §5). In the swarm stage this means: proposals
become durable receipts first; execution requires the global execute mode,
a non-disabled per-action mode, fresh state checks, and an atomic
reservation; and the outcome is recorded with succeeded/uncertain/rejected
status. In offline experiments this means: no action of any kind. Gate
enforcement (assignment and approval gates) remains authoritative per
ADR-018; evaluation output is an input to human or Brain decisions, never a
shortcut around gates.

### 12. The evaluation lock is a concurrency guard, not authority

`acquirePlanEvaluation` (evaluation-lock) prevents concurrent plan
rewrites. It grants no lifecycle authority: it does not create leases,
assign work, or make evaluation output actionable, and evaluation flows must
not assume it provides durable pass/lease state (that remains Phase 6
work per ADR-018).

## Consequences

- Evaluation tooling may be built and run freely against fixtures and
  snapshots, provided it stays read-only with respect to authoritative state
  and persists outputs only as versioned artifacts or derived audit records.
- New evaluation surfaces must record the same contract elements (§2–§10)
  or name this record and justify any deviation before running against
  shared infrastructure.
- Promotion flows (e.g. adopting a new classifier, enabling swarm execution
  for a new action) require an explicit decision record and an
  API-mediated change; measured metrics alone are insufficient.
- Retention, redaction-on-share, and cost-budget enforcement for future
  evaluation surfaces must extend this record rather than invent local
  rules.
- Violations of the read-only rule are boundary violations under ADR-012 /
  ADR-016, not merely experimental sloppiness.

## Related Records

- `.project/plan.md` Phase 0 ("Define evaluation and experiment
  boundaries") and Execution Rules (evidence vs. authority)
- ADR-012 (API-owned SQLite), ADR-015 (Brain API boundary), ADR-016
  (source-of-truth boundaries), ADR-018 (assignment and approval gates)
- `src/scripts/classification-bakeoff.ts`,
  `src/scripts/classification-bakeoff/README.md` (corpus, scoring,
  results, retention)
- `src/brain/swarm/` (evaluator, runner, budget, prompts, README),
  `src/api/routes/brain-swarm.ts`,
  `src/db/migrations/swarm-evaluations.ts` (migration 070)
- `src/project-setup/evaluation-lock.ts`
