# Coleo Project Status

> Canonical human-facing status record. Updated per task completion; dated
> `status-*.md` snapshots are historical. See `.project/plan.md` for the
> authoritative plan. Inventory evidence (filenames, diffs, artifacts) is
> not completion proof — see ADR-016/017/018.

## Current Phase

**Phase 0: Planning, Architecture, and Execution Preconditions** (in
progress). Planning-gate work only: no feature implementation may be
assigned until Phase 0 preconditions are met.

## Verified Capabilities

- **Type safety:** `bun run typecheck` (`tsc --noEmit`) passes —
  verified 2026-09-22 on a dirty workspace (134 modified/untracked paths).
- **Runtime stack present:** Bun, Hono REST API, React 19/Vite workbench,
  SQLite (WAL + migrations), NATS transport, header API-key auth —
  implementation modules inspected; see `.project/reports/runtime-stack-validation-2026-09-22.md`
  (commit `30d0449`) for the detailed validation.
- **Architecture decisions current:** ADR-001 through ADR-018 accepted,
  including ADR-004 workbench revision (HeroUI v3), ADR-014
  branch-centered lifecycle, ADR-015 Brain API boundary, ADR-016
  source-of-truth boundaries, ADR-017 task-file/output tracking, ADR-018
  assignment/approval gates.
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
- Decisions: `.project/decisions/001`–`018`
- Acceptance: `.project/acceptance/phase-1.md`
- Architecture: `docs/architecture/overview.md`, `docs/architecture/brain-api-boundary.md`
- Migration plans: `.project/jetstream-migration-plan.md`,
  `.project/plans/brain-api-boundary-execution-plan.md`
- Validation report: `.project/reports/runtime-stack-validation-2026-09-22.md`

## Validation Evidence

| Check | Result | Date |
|---|---|---|
| `bun run typecheck` | pass (no errors) | 2026-09-22 |
| Runtime-stack validation (report + focused WS auth tests) | pass | 2026-09-22 |
| Unit / integration / e2e / web build | not run in this pass | — |

## Workspace Baseline

- HEAD at last update: `87c99cd` (plus `HEAD` may have moved; re-check with
  `git log` before attributing outputs).
- Workspace dirty at last update (134 paths, 2026-09-22): task outputs must
  be attributed against a per-task `git status --porcelain` baseline per
  ADR-017, not inferred from the dirty tree.
