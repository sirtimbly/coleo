# Evaluation-Lock Verification (2026-09-22)

Task: `phase0pl-911f85` — confirm lock acquisition, expiry, ownership,
renewal, stale-lock recovery, cancellation, cleanup, and concurrent-run
behavior before swarm/classification evaluation is used operationally.

## Scope

The operational evaluation lock is `acquirePlanEvaluation` in
`src/project-setup/evaluation-lock.ts` (47 lines). It guards plan
evaluation (prepare/regenerate/sync), backed by SQLite state at
`<coleoDir>/run/plan-evaluation.sqlite`. Offline scripts
(`classification-bakeoff`, `eval-human-history`, `eval-swarm-window`)
are outside its scope and remain non-operational tooling.

## Verified semantics

| Requirement | Verdict | Evidence |
|---|---|---|
| Acquisition | Atomic | Single-row table + `.immediate()` transaction; cross-process test passes |
| Ownership | Token-gated, owner-only release | UUID token, `DELETE WHERE id=1 AND token=?`; release closure idempotent |
| Expiry / renewal | N/A by design | No TTL; PID liveness *is* the expiry mechanism. Correct for short plan-evaluation ops; no renewal API needed |
| Stale-lock recovery | Works | `process.kill(pid,0)` liveness; `ESRCH` steals, `EPERM` denies fail-closed; child-exit test passes |
| Cancellation / cleanup | Released on all paths | All 3 call sites use `try/finally` (2 API routes + `Brain.syncPlanTasks`); contention returns 409 or defers to next poll |
| Concurrent-run | Exactly one holder | Serialization via immediate transaction; contention test passes |

Fresh run 2026-09-22: `bun test
src/project-setup/__tests__/evaluation-lock.test.ts` — **2 pass, 0 fail**.

## Call sites (all gated)

1. `POST /api/project-setup/prepare-plan` — 409 "Another plan evaluation
   is running…" on contention, `finally { release(); }`.
2. `POST /api/project-setup/regenerate-tasks` — same pattern.
3. `Brain.syncPlanTasks()` (`src/brain/brain.ts`) — logs and defers to
   the next poll on contention.

## Known limitation (fail-closed, documented)

PID-reuse race: if a dead holder's PID is recycled by the OS to a live
process, the lock reports busy until that process exits. EPERM liveness
checks (another user's PID) likewise deny acquisition. Neither corrupts
state; both block rather than admit concurrent evaluation. Acceptable
for short-lived plan evaluation; revisit with fencing tokens if the
lock is ever extended to long-running swarm evaluations.

## Conclusion

Evaluation-lock semantics are confirmed for operational plan
evaluation. No code changes required. Swarm/classification bakeoff
scripts must route through a gated entrypoint (this lock or a
successor) before operational use.
