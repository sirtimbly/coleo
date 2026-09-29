# Onboarding + Workspace Connection Verification (2026-09-22)

Task: `phase1co-0e7059`.

## Verdict: VERIFIED

### Project/workspace selection — pass

- `coleo init` creates an explicit state dir (`cwd/.coleo` or `--dir`)
  with Maildir, config, templates, per-project ports, and API-key
  handling — never touching another checkout (prepare-repository
  guarantees reviewed separately).
- Runtime resolution order (`src/config/env.ts`): `COLEO_DIR` >
  ancestor `.coleo` discovery > fresh project-local dir. No path ever
  silently substitutes a different project's state; worst case is a
  fresh state dir that onboarding then initializes.
- API startup migrates, seeds (only when zero migrations), and
  reconciles orphans within that dir before serving.

### Auth/connection errors — pass

- Onboarding API requires onboarding for non-Git dirs, rejects invalid
  URLs pre-Git, cleans partial clones, routes to remote hosts or fails
  closed when unavailable (7 tests).
- UI: connection notice (aria-live, grace/escalation), explicit
  `Unable to load …` states, shell intact on API failure (e2e
  surface-failure 4/4).

### No stale/local-only fallback — pass

- Missing config → explicit onboarding/required-project flow, not
  silent local state. Migration incompatibility fails closed
  (restore backup). Uninitialized JetStream/API surfaces 503/empty,
  never fabricated data.

## Evidence

- onboarding + init-environment + config + project-setup suites:
  **45/45 pass**.
- prepare-repository 12/12; e2e surface-failure 4/4; resilience
  report (connection/retry states).

No code changes required.
