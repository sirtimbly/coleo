# Brain/API Architecture Validation (2026-09-22)

Task: `phase1co-be5896` — validate `docs/architecture/brain-api-boundary.md`.

## Verdict: VALIDATED (two hardening leftovers, non-blocking)

Every normative claim verified against the post-cleanup tree:

- **Decisions 1–5:** Brain is API-only (regression-tested, commit
  `d9db755`); ArmAgent owns harness/OpenCode traffic; API is the
  typed/authenticated boundary (`X-Coleo-API-Key`/`X-API-Key`).
- **Process lists:** Brain allow/deny holds (API calls, inference,
  `.coleo` reads, logs only); API may use NATS/JetStream and
  persistence; distributed arm reads route through `ArmClient`, local
  reads through `HarnessManager` — no route-level OpenCode proxies
  (verified in `GET /:id/messages`; todos/activity follow the same
  pattern).
- **Messaging model:** canonical JetStream streams; Brain reads via
  API routes; single logical ingress (`/api/brain/internal/messages/*`)
  with allowlisted admission, dead-letter capture, and lease semantics
  with stale recovery.
- **Current State 1–8:** all confirmed (bridge projector, API-only
  consumption, admission validation, dead-letter + requeue endpoints,
  ArmAgent/HarnessManager routing, JetStream-backed SSE).

## Hardening leftovers

1. Contract tests for event/message schemas: partially covered
   (envelope validation + bridge suites); a cross-service schema
   matrix is still future work.
2. MCP direct-SQLite inbox fallback consolidation: open — the
   documented ADR-012 migration-bridge exception.

No doc or code changes required.
