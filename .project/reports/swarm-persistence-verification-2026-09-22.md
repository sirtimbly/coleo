# Swarm Persistence Verification (2026-09-22)

Task: `phase2-deb93e`.

## Verdict: VERIFIED (one documented non-blocker)

- **Ordering:** `070_swarm_evaluations` creates `brain_swarm_actions`
  (UNIQUE `dedup_key`, status CHECK, scope index) and
  `brain_swarm_evaluations`; `071_swarm_recommendations` adds
  recommendations with FK to evaluations. Referenced tables first —
  correct.
- **Idempotence:** checksum/epoch-gated catalog reruns are no-ops;
  recommendation inserts are `INSERT OR IGNORE` on the action-key id.
- **Transactions:** reservation, evaluation+audit ingest, and finish
  run in immediate transactions; malformed input is rejected before
  any write (route tests assert zero recommendation rows).
- **Retention:** none currently — tables grow unbounded with private
  source text. Documented as future work in the swarm README; not a
  correctness blocker, track for Phase 12/ops.
- **Deduplication:** dedup-key + scope/cooldown/version guards;
  overlapping polls update one stable Inbox entry.
- **Restart recovery:** `executing`/`uncertain` receipts are durable
  rows surfaced by `listSwarmActions`; crashed dispatches block retry
  until operator reconcile; no lock required.

Evidence: `brain-swarm` suite **10/10 pass** (snapshot, coverage,
dedup, reconcile, inbox, malformed, adapters, stale versions).

No code changes required.
