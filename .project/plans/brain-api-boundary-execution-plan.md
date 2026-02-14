# Brain/API Boundary Refactor - Execution Plan

## Context

The current system allows the Brain and API server to perform overlapping integration work (NATS/JetStream and harness/OpenCode access). This violates separation of concerns and makes runtime behavior harder to reason about and test.

## Goal

Enforce a clean architecture:
- Brain is an API client plus inference engine.
- API server is the only remote integration boundary for Brain.
- ArmAgent owns harness/OpenCode integration.
- NATS JetStream is the canonical arm event/message source, accessed by Brain via API contracts.

## Scope

In scope:
- Brain direct NATS and JetStream dependency removal.
- API bridge from arm-to-brain NATS topic into Brain message queue.
- Brain event read/write paths via API endpoints.
- Documentation and tests for each phase.

Out of scope (follow-up):
- Full ArmAgent command surface expansion for every arm introspection endpoint.
- Long-term stream retention and replay policy tuning.

## Status (2026-02-14)

- ✅ Phase 1 largely complete: API bridge for `coleo.brain.messages`, API-only brain inbox consumption, lease-based processing.
- ✅ Phase 2 largely complete: Brain event I/O routed through API surfaces.
- ✅ Phase 3 complete: `/messages` and `/todos` now flow through ArmAgent/HarnessManager abstractions; arm event SSE is JetStream-backed.
- 🚧 Phase 4 in progress: dead-letter replay tooling added, legacy `queue/brain/*` and file-fallback assumptions removed, remaining work is broader failure-mode testing and final fallback/API-contract cleanup.

## Phased Work

### Phase 1 - Brain ingress via API queue (Now)

Tasks:
- Add API NATS subscription bridge for `coleo.brain.messages` -> `messages` queue.
- Remove Brain startup/shutdown NATS connection logic.
- Remove Brain file queue fallback and consume API queue as single ingress path.

Validation:
- Run targeted API/Brain tests.
- Verify Brain can still process queued arm messages end-to-end.

### Phase 2 - Brain event I/O through API

Tasks:
- Replace Brain direct JetStream logging/reads with API routes.
- Add API internal event publish endpoint for non-activity subjects (`task`, `brain`, `system` events).
- Keep event schema typed and authenticated behind API.

Validation:
- Run Brain event-processing tests and API route tests.
- Verify idle/stuck detection still receives recent activity signals.

### Phase 3 - ArmAgent ownership for distributed harness access

Tasks:
- Remove API direct distributed harness/OpenCode reads (`/messages`, `/todos`, `/events` proxies).
- Add ArmAgent command handlers for required data fetches and typed responses.
- Keep API as orchestrator and contract surface only.

Validation:
- Distributed arm integration tests (spawn/prompt/messages/events/todos).
- Recovery tests across API restart and agent reconnect.

### Phase 4 - Hardening and cleanup

Tasks:
- Remove remaining legacy paths and dead code.
- Add failure-mode tests (network partition, NATS restart, API restart).
- Update architecture docs and operational runbooks.

Validation:
- Full `bun test` pass.
- Manual smoke run with `bun run server` + `bun run brain`.

## Testing Cadence

During implementation:
1. Run targeted suite after each code slice.
2. Run affected package tests before moving to next phase.
3. Run broader regression suite at phase boundaries.

Target commands:
- `bun test src/brain/__tests__/brain-templates-and-nats.test.ts`
- `bun test src/brain/__tests__/idle-prompt-guards.test.ts`
- `bun test src/api/__tests__/activity-transcript.test.ts`
- `bun test` (phase boundary)
