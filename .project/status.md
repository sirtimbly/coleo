# Coleo Project Status

> Canonical human-facing status record. Updated per task completion; dated
> `status-*.md` snapshots are historical. See `.project/plan.md` for the
> authoritative plan and `.project/execution-dependency-map.md` for phase
> gates. Inventory evidence (filenames, diffs, artifacts) is
> not completion proof — see ADR-016/017/018.

## Current Phase

**Phase 0: Planning, Architecture, and Execution Preconditions** (in
progress). Planning-gate work only: no feature implementation may be
assigned until Phase 0 preconditions are met.

## Assignment Handoff (2026-09-22)

- **Verified baseline:** HEAD `56a19f0`; workspace dirty (149 paths) —
  per-task `git status --porcelain` baselines required (ADR-017).
  `bun run typecheck` passes (fresh 2026-09-22); unit/integration/e2e/
  web-build not yet run in this pass.
- **Phase 0 definitions complete:** ADR-016 (sources of truth), ADR-017
  (task-file/outputs), ADR-018 (gates), ADR-019 (commands), ADR-020
  (isolation), ADR-021 (rollback), ADR-022 (startup contract), ADR-023
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
- **Architecture decisions current:** ADR-001 through ADR-023 accepted,
  including ADR-004 workbench revision (HeroUI v3), ADR-014
  branch-centered lifecycle, ADR-015 Brain API boundary, ADR-016
  source-of-truth boundaries, ADR-017 task-file/output tracking, ADR-018
  assignment/approval gates, ADR-019 validation commands, ADR-020
  isolation/ownership, ADR-021 rollback safety, ADR-022 startup contract,
  ADR-023 evaluation boundaries.
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
- Decisions: `.project/decisions/001`–`023`
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
| Unit / integration / e2e / web build | not run in this pass | — |

## Workspace Baseline

- HEAD at last update: `56a19f0` (plus `HEAD` may have moved; re-check with
  `git log` before attributing outputs).
- Workspace dirty at last update (149 paths, 2026-09-22): task outputs must
  be attributed against a per-task `git status --porcelain` baseline per
  ADR-017, not inferred from the dirty tree.
