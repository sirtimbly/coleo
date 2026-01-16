# Phase 1: Observatory Foundation – Acceptance Criteria

**Phase Goal**: Web UI and API for human observation and control, with the CLI and Web UI both treating the API as the authoritative interface.

This document is written to support the **progressive planning system** described in `progressive-planning.md`. Each criterion is a clear, checkable condition that architect tasks and the brain can use to decide whether Phase 1 is complete or whether follow-up "verify & polish" work is needed.

## Goal

Humans can reliably observe arm activity and basic system state through the Observatory (web UI) and CLI, both backed by the Hono API server and SQLite database.

## Approach

1. **API Surface for Observatory** – Provide REST and WebSocket endpoints for health, arms, activity, and configuration.
2. **Web UI Shell** – Implement a basic React/Vite shell with routing and a dashboard that consumes the API.
3. **CLI Proxying** – Route key CLI commands through the API instead of local-only operations.
4. **Activity Logging** – Persist arm and system activity in SQLite and expose it via API and WebSocket.

## Dependencies

- Phase 0: Core Infrastructure (brain polling loop, Maildir I/O, MCP server, arm spawner, CLI basics, SQLite migrations)

## Acceptance Criteria

The following criteria should be evaluated by architect tasks based on code, runtime behavior, and status reports. Each criterion can drive one or more tasks in the progressive planning loop.

### 1. API Server & Health

- [ ] `bun run server` starts a Hono-based API server without runtime errors.
- [ ] `GET /api/system/health` (or equivalent health route) returns HTTP 200 with a JSON payload indicating overall "ok" status when the brain and database are reachable.
- [ ] If the database is unreachable, the health endpoint reflects a degraded/unhealthy status and does not crash the server.

### 2. SQLite Persistence

- [ ] Database migrations run automatically on server start (no manual SQL steps required) and create at least the following tables: `arms`, `activity`, `config`, `claims` (names as defined in `src/db`).
- [ ] Creating, updating, or deleting arms through the API is reflected in the `arms` table.
- [ ] Activity records (e.g., arm spawned, arm stopped, brain tick) are written to the `activity` table.

### 3. Arm Listing & Status

- [ ] `GET /api/arms` returns a JSON list of arms with at least: `id`, `name`, `status`, `lastSeenAt` (or equivalent fields defined in `src/api/routes/arms.ts`).
- [ ] When a new arm is spawned via the CLI (through the API), it appears in `/api/arms` within one polling interval.
- [ ] When an arm exits, its status is updated in the API response within one polling interval.

### 4. Activity Timeline

- [ ] `GET /api/activity` returns a chronological list of recent activity entries (arm events, brain events, significant errors).
- [ ] When arms perform actions (spawn, stop, claim, task start/complete), at least one corresponding activity record is created and visible via the API.
- [ ] WebSocket subscribers receive activity events in near-real time when new entries are added.

### 5. WebSocket Connectivity

- [ ] The WebSocket endpoint (e.g., `/ws`) accepts connections from the web UI.
- [ ] After connecting, the client receives at least: system status updates, arm status changes, and activity events without requiring manual polling.
- [ ] If the WebSocket connection drops, the client can reconnect automatically without crashing the UI.

### 6. Web UI Shell & Dashboard

- [ ] A React/Vite-based web app builds successfully (e.g., `cd src/web && bun run build`).
- [ ] The root view (Observatory) displays a basic dashboard that includes:
  - [ ] Overall system status (e.g., brain running/stopped).
  - [ ] A list or table of arms with `name` and `status`.
  - [ ] A recent activity list or timeline sourced from the API/WebSocket.
- [ ] Navigating the UI does not require hard reloads; routing is handled client-side.

### 7. CLI Proxy Through API

- [ ] `octopai arm list` (or equivalent CLI command) obtains its data from the API (`/api/arms`), not directly from the filesystem or database.
- [ ] `octopai arm spawn` uses the API to create a new arm record and trigger spawning (no direct process management bypassing the server in the default path).
- [ ] `octopai status` fetches its information from API endpoints (system/health, arms, activity) rather than local-only logic.
- [ ] If the API is unreachable, the CLI reports a clear error and may use documented fallback behavior, but this is treated as a degraded mode.

### 8. Authentication & Security (Phase-appropriate)

- [ ] API key authentication is implemented as described in ADR-003 (`.project/decisions/003-api-authentication.md`).
- [ ] Requests without a valid API key are rejected with an appropriate HTTP status (401/403) and do not expose sensitive data.
- [ ] The web UI and CLI are able to authenticate using the configured mechanism without hardcoding secrets into source code.

### 9. Progressive Planning Hooks

Although full progressive planning is implemented in later phases, Phase 1 must expose enough surface for the Brain to drive tasks based on plans:

- [ ] There is at least one dedicated Phase 1 plan document under `.project/plans/` (e.g., `phase-1-observatory.md`) that lists the main Observatory-related bullet points described above.
- [ ] Architect tasks can reference this acceptance document and the Phase 1 plan document to compute whether Phase 1 is fully complete or which bullet points still require work.
- [ ] Status reports from arms working on Observatory features include enough detail (what was done, issues, next steps) for the Brain to apply the decision logic from `progressive-planning.md`.

### 10. Human-Facing Status

- [ ] `.project/status.md` contains a **Phase 1** section summarizing:
  - [ ] Current completion state (e.g., "Phase 1: Observatory Foundation – ✅ Complete" or similar).
  - [ ] Any outstanding known gaps against these acceptance criteria.
  - [ ] Links or references to the relevant plan and acceptance files.
- [ ] At least one architect project-management task has updated `status.md` based on API/server verification and/or test runs, not just code inspection.

## Completion Definition

Phase 1: Observatory Foundation is considered **complete** when:

- All mandatory criteria in sections **1–8** are checked off by an architect project-management task (or human reviewer), and
- The **Progressive Planning Hooks** (section 9) and **Human-Facing Status** (section 10) are satisfied enough that:
  - The Brain can determine whether Observatory-related work is done or needs "verify & polish" tasks.
  - Humans can understand the current Observatory capabilities and remaining gaps from `.project/status.md` without reading the entire codebase.
