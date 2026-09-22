# ADR-019: Validation and Delivery Commands

## Status

Accepted

## Date

2026-09-22

## Context

Phase 0 requires the authoritative command set to be identified before
feature work is assigned, so ADR-017 output verification can name real
commands with known prerequisites and expected results. The authority is
`package.json` scripts (package manager `bun@1.3.6`, `engines.bun >=1.1.0`)
plus `AGENTS.md`. Verified 2026-09-22 by reading `package.json`,
`src/web/vite.config.ts`, `playwright.config.ts`, `docker-compose.yml`,
`src/network-config.ts`, and `src/config/env.ts`. Only `typecheck` was
re-run in this pass (pass); other results below are command definitions
with prerequisites, not fresh runs.

## Decision

### 1. Installation and builds

| Purpose | Command | Prerequisites / notes | Expected output |
|---|---|---|---|
| Install | `bun run setup` (`bun install --force --frozen-lockfile`) | Bun >= 1.1.0; network for registry | `node_modules` per lockfile; exit 0 |
| Production build | `bun run build` | Install done; ~4 GB RAM for web `tsc -b` | `dist/` (CLI `index.js` + `web/` + brain templates); exit 0 |
| Web build only | `bun run web:build` | Same as above | `src/web/dist/`; exit 0 |

### 2. Static checks

| Purpose | Command | Expected output |
|---|---|---|
| Typecheck (all) | `bun run typecheck` (`tsc --noEmit`) | No output; exit 0. Verified pass 2026-09-22 |
| Shell scripts | `bun run shellcheck` (`shellcheck bin/*.sh`) | No findings; exit 0 |
| Both | `bun run check` | Exit 0 |
| Web lint | `bun run --cwd src/web lint` (`eslint .`) | No errors; exit 0 |

### 3. Tests

| Purpose | Command | Services / env / cleanup | Expected output |
|---|---|---|---|
| Unit | `bun run test:unit` (`bun test` over 18 `__tests__` dirs) | None; process-local fixtures | All pass; exit 0 |
| API/integration spec | `bun run test:integration:spec` (`bun test src/integration/__tests__/`) | Local NATS optional (JetStream-unavailable fallback paths tested); Maildir fixtures under temp `.coleo` dirs, cleaned by tests | All pass |
| Regression quick | `bun run test:integration` (runner `--quick`) | API server + Brain per runner; temp state cleaned by runner | Pass |
| Regression full | `bun run test:e2e` | Same, longer | Pass |
| Browser | `bun run test:e2e:web` (`playwright test`) | Playwright browsers installed; web server auto-started on port 4174 (`preview` in CI, `dev` locally) | All specs pass |
| Smoke (optional infra) | `bun run test:qdrant`, `test:embedding`, `test:distributed-observability` | Qdrant on 6333 / embedding provider / NATS respectively | Pass or explicit skip when infra absent |

Single-file runs (`bun test <path>`) and title filters (`bun test -t
"pattern"`) are for diagnosis, not acceptance. Acceptance runs use the
full commands above from a baselined workspace (ADR-017/018).

### 4. Docs

`bun run docs:dev` (serve), `bun run docs:build` (`vitepress build docs`,
exit 0, output to `docs/.vitepress/dist`), `bun run docs:preview`.

### 5. Migrations and runtime dependencies

- SQLite migrations run automatically at API startup (`initDatabase` in
  `src/db/index.ts`: WAL, `busy_timeout 5000`, `foreign_keys ON`); no
  manual migration command. Downgrade/rollforward expectations belong to
  the rollback-safety task, not to routine validation.
- NATS with JetStream: `bun run nats:install` (pinned binary into
  `.coleo/bin`, honors `COLEO_DIR`/`COLEO_BIN_DIR`, `NATS_VERSION` default
  2.12.3) then `bun run nats:run` (JetStream state under `.coleo/nats`).
  `docker compose up -d` alternatively provides NATS (JetStream, ports
  4222/8222) and Qdrant (6333).
- Cloudflare split topology: `bun run dev:cloudflare-split` (up),
  `bun run test:cloudflare-split` (smoke).

### 6. Environment, ports, and services

- API: `COLEO_API_HOST` (default `0.0.0.0` bind), `COLEO_API_PORT`
  (default 8080), `COLEO_API_URL` override; client host normalization in
  `src/network-config.ts`.
- Auth: `COLEO_API_KEY` or `COLEO_API_TOKEN` (see ADR-003 amendment work).
- NATS: `COLEO_NATS_HOST/PORT/HTTP_PORT/URL` (defaults 127.0.0.1 /
  4222 / 8222).
- Project state: `COLEO_DIR` (default `<project>/.coleo`),
  `COLEO_PROJECT_DIR`; models: `OCTOPAI_PREFERRED_MODELS`.
- Ports in use during validation: API 8080, NATS 4222 + monitor 8222,
  Vite dev 5173, Playwright web server 4174, Qdrant 6333.
- Fixtures/cleanup: integration tests use temp `.coleo` dirs; the
  regression runner owns process startup/shutdown and temp-state cleanup.

### 7. Delivery smoke expectations

A delivery candidate passes, in order: `setup`, `typecheck`,
`shellcheck`, `test:unit`, `test:integration:spec`, `web:build`, and
either `test:integration` or `test:e2e` per the release scope, plus
`test:e2e:web` for UI-affecting changes. Qdrant/embedding smokes run
when that infrastructure is in scope. Any failure stops the delivery;
fixes re-run the full sequence, not just the failed step.

## Consequences

- ADR-017 verification methods (`typecheck`, `lint`, `test`, `build`)
  refer to the commands in §2–3; task records must name the exact command
  and its result.
- `.project/status.md` validation evidence must cite these commands and
  distinguish fresh runs from definitions.
- Adding a new validation command requires updating this record.

## Related Records

- ADR-017 (output verification), ADR-018 (gates), `.project/status.md`
- `package.json`, `AGENTS.md`, `playwright.config.ts`,
  `docker-compose.yml`, `src/network-config.ts`
