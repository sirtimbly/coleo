# Coleo Project Status

> Canonical human-facing status record. Updated per task completion; dated
> `status-*.md` snapshots are historical. See `.project/plan.md` for the
> authoritative plan and `.project/execution-dependency-map.md` for phase
> gates. Inventory evidence (filenames, diffs, artifacts) is
> not completion proof — see ADR-016/017/018.

## Current Phase

**Phase 1: Core Infrastructure and API Boundary** (in progress;
Phase 0 planning-gate definitions ADR-016–025 are complete).
Foundation verification only: behavior must be inspected and tested,
not inferred from filenames.

## Phase 1 Boundary Evidence (2026-09-22)

- **Topology (tested):** API startup migrates SQLite (checksums/epochs,
  fail-closed) and reconciles orphans; Brain is API-only (no NATS/
  harness/SQLite runtime imports — regression-tested); ArmAgent/
  harness publishes arm events to JetStream; API command-projector
  validates/dedups/dead-letters; UI consumes SSE/event routes.
  Reports: migrations, event-lifecycle, failure-path-state.
- **Startup paths:** explicit `coleoDir` resolution (env > ancestor
  discovery > fresh dir); onboarding constraints; entrypoint order
  repo → init → API → web → brain → agent (ADR-024).
- **Auth:** `X-Coleo-API-Key` / `X-API-Key` / `?api_key`; health
  public; single shared key by design; WS upgrade + in-band key auth.
- **Command evidence:** db 46/46; onboarding+init+config+setup 45/45;
  bridge+internal-messages+runtime-flows 27/27; cleanup+spawn+claim
  28/28; tasks+bugs 100/100; ws-auth+status-reports 8/8; CLI 4/4;
  prepare-repository 12/12; swarm suites 29/29; e2e failure-matrix
  4/4, error-boundaries 3/3, dashboard 3/3, arm-activity 1/1;
  typecheck clean.
- **Known limitations:** MCP direct-DB migration bridge; client
  failures console-only (no aggregation); message-metrics rows
  unpruned (7-day prune covers history table); PID-reuse lock race
  (fail-closed); JEV template test + task-preparation fallback test
  fail on local env drift (filed, unrelated).
- **Unresolved gaps:** ADR-003 wording (approved, unapplied);
  deployment target, vector-search, governance, persistence decisions;
  durable pass/lease + task-file storage (Phase 6); Phase 11
  execution.

## Assignment Handoff (2026-09-22)

- **Verified baseline:** HEAD `56a19f0`; workspace dirty (149 paths) —
  per-task `git status --porcelain` baselines required (ADR-017).
  `bun run typecheck` passes (fresh 2026-09-22); unit/integration/e2e/
  web-build not yet run in this pass.
- **Phase 0 definitions complete:** ADR-016 (sources of truth), ADR-017
  (task-file/outputs), ADR-018 (gates), ADR-019 (commands), ADR-020
  (isolation), ADR-021 (rollback), ADR-024 (startup contract), ADR-023
  (evaluation boundaries); dependency map; evaluation-lock verification;
  startup failure-path tests (prepare-repository 12/12).
- **Unresolved decisions:** ADR-003 API-key terminology amendment
  (human-approved, not applied — gates runtime-stack confirmation);
  production deployment target, vector-search/embedding, governance/
  reputation, production persistence sequencing.
- **Blocked phases:** Phase 1+ implementation assignments wait on the
  remaining Phase 0 items below; Phase 10/12/23 wait on the vector
  decision; Phase 11 waits on its execution (plan approved); Phase 14
  waits on the governance decision.
- **Approved commands:** ADR-019 catalog (`setup`, `build`, `typecheck`,
  `shellcheck`, web `lint`, `test:unit`, `test:integration:spec`,
  `test:integration`, `test:e2e`, `test:e2e:web`, `web:build`,
  `docs:build`, `nats:install/run`). Ports: API 8080, NATS 4222/8222,
  web 5173, Playwright 4174, Qdrant 6333.
- **Worktree rules:** arm-owned worktrees, per-task baselines, exclusive
  claims + single-use leases, stash-before-destruction (ADR-020).
- **Evaluation constraints:** offline/read-only bakeoffs, redacted
  artifacts, fail-closed credentials, API-authenticated swarm mutations,
  evaluation-lock contention = blocked gate (ADR-023 + lock report).
- **First eligible task:** `Inspect current workspace changes before
  feature assignment` (Phase 0, plan order), followed by `Record the
  current baseline` (run the ADR-019 delivery sequence, record results).
  `Confirm the runtime stack` follows the ADR-003 amendment.

## Verified Capabilities

- **Type safety:** `bun run typecheck` (`tsc --noEmit`) passes —
  verified 2026-09-22 on a dirty workspace (134 modified/untracked paths).
- **Runtime stack present:** Bun, Hono REST API, React 19/Vite workbench,
  SQLite (WAL + migrations), NATS transport, header API-key auth —
  implementation modules inspected; see `.project/reports/runtime-stack-validation-2026-09-22.md`
  (commit `30d0449`) for the detailed validation.
- **Architecture decisions current:** ADR-001 through ADR-025 accepted,
  including ADR-004 workbench revision (HeroUI v3), ADR-014
  branch-centered lifecycle, ADR-015 Brain API boundary, ADR-016
  source-of-truth boundaries, ADR-017 task-file/output tracking, ADR-018
  assignment/approval gates, ADR-019 validation commands, ADR-020
  isolation/ownership, ADR-021 rollback safety, ADR-024 startup contract,
  ADR-023 evaluation boundaries, ADR-025 arm-metrics contract.
- **Boundaries enforced in code:** no direct SQLite opens in `src/brain`
  runtime; Brain/MCP access persistence via API (ADR-012/015); Maildir
  implementation with `/api/mail/*` surface (ADR-002).

## Known Gaps

- `src/mcp` runtime still opens SQLite directly (`getDatabase`) — permitted
  only as the ADR-012 migration bridge; must move to API-backed access.
- No durable pass/lease storage yet (Phase 6 work); leases/passes are
  definitions, not tables.
- No task-file reference storage yet (Phase 6 work); ADR-017 is the
  contract awaiting implementation.
- JetStream event-sourcing migration approved
  (`.project/jetstream-migration-plan.md`) but Phase 11 execution pending;
  JetStream is transport + short-retention events, not authoritative state.
- ADR-003 still documents `OCTOPAI_API_KEY`; code resolves
  `COLEO_API_KEY`/`COLEO_API_TOKEN` (human approved the terminology update;
  amendment pending).
- Swarm, evaluation, onboarding, migration-catalog, and many UI/API paths
  present in the tree are **unvalidated** — inventory only.

## Blockers

- None blocking Phase 0 planning work. Human/architecture decisions
  outstanding: ADR-003 terminology amendment (approved, not yet applied).

## Links

- Plan: `.project/plan.md`
- Decisions: `.project/decisions/001`–`025`
- Acceptance: `.project/acceptance/phase-1.md`
- Architecture: `docs/architecture/overview.md`, `docs/architecture/brain-api-boundary.md`
- Migration plans: `.project/jetstream-migration-plan.md`,
  `.project/plans/brain-api-boundary-execution-plan.md`
- Validation reports: `.project/reports/runtime-stack-validation-2026-09-22.md`,
  `.project/reports/evaluation-lock-verification-2026-09-22.md`
- Gates: `.project/execution-dependency-map.md`

## Validation Evidence

| Check | Result | Date |
|---|---|---|
| `bun run typecheck` | pass (no errors) | 2026-09-22 |
| Runtime-stack validation (report + focused WS auth tests) | pass | 2026-09-22 |
| Brain/API boundary cleanup + regression tests | pass (CONFORMANT) | 2026-09-22 |
| Contract/failure matrix (api/db/nats/mcp/cli/setup/scripts) | 491 pass, 1 env-dependent fail (filed as bug) | 2026-09-22 |
| e2e (failure-matrix, error-boundaries, dashboard, activity) | 11/11 pass | 2026-09-22 |
| Unit / integration / web build | targeted suites pass; full build not run in this pass | — |

## Workspace Baseline

- HEAD at last update: `74a0cd3` (plus `HEAD` may have moved; re-check with
  `git log` before attributing outputs).
- Workspace dirty at last update (151 paths, 2026-09-22): task outputs must
  be attributed against a per-task `git status --porcelain` baseline per
  ADR-017, not inferred from the dirty tree.
