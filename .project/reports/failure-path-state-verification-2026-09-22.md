# Failure-Path State Verification (2026-09-22)

Task: `phase1co-079bec` — verify failure paths do not create local
arm/task state that was not durably persisted by the API.

## Verdict: VERIFIED

### Spawn and lifecycle failures stay API-owned

- `POST /api/arms/:id/spawn` creates the DB row (`starting`) before
  any harness work; every subsequent mutation is a DB write, and
  failures throw typed HTTP errors without inventing local state.
  Hung runtimes are killed and marked `stopped`; unrecoverable spawns
  surface 4xx/5xx with the row left in a reconciliable state.
- Brain mutates its in-memory maps only after successful API calls
  (e.g. `patchArmViaApi` precedes `arms.delete`); a failed API call
  throws before local state advances.
- Startup `cleanupOrphanedArms` reconciles crash leftovers: dead PID
  (incl. stuck `starting`) → `stopped` + file claims released; live
  PID preserved for retry; distributed arms preserved (no local PID
  check possible).

### Failure-path test evidence

- arm-cleanup + claim-cleanup + arms-spawn-create: **28/28 pass**.
- prepare-repository: 12/12 (originals untouched, no staging residue).
- onboarding: partial-clone cleanup, fail-closed remote host.
- status-report 400s never persist; bridge dedups redeliveries.

Known boundary (unchanged): `src/mcp` direct-DB writes remain the
documented ADR-012 migration bridge.

No code changes required.
