# ADR-012: API-Owned SQLite Access Boundary

## Status

Accepted

## Date

2026-02-07

## Context

We observed orchestration-layer code (`src/brain/**`, `src/mcp/**`) directly importing `bun:sqlite` and issuing SQL queries. That created tight coupling between coordination logic and persistence details:

- Brain/MCP behavior depended on local database file access.
- DB schema changes leaked into orchestration code paths.
- Testing and deployment became harder when components were split across processes.
- Authentication and authorization boundaries were bypassed by direct DB reads/writes.

This conflicts with the layered architecture already used elsewhere: the API server is the service boundary for stateful operations and should be the only runtime layer that talks to SQLite.

## Decision

Enforce a strict persistence boundary:

1. `src/api/**` (and DB/migration modules used by API routes) is the only runtime layer that directly accesses SQLite.
2. `src/brain/**` must not import `bun:sqlite` or open database connections directly.
3. `src/mcp/**` runtime handlers must access persistent state via API calls, not direct SQLite access.
4. Brain/MCP code may use API-backed DB adapters/clients to preserve query ergonomics, but those adapters must call API endpoints.
5. Direct SQLite access remains allowed in:
   - `src/db/**` (schema/migrations/transactions/state utilities)
   - `src/api/**` route handlers and server wiring
   - Tests and local tooling where process-local fixtures are required

## Consequences

### Positive

- Clear separation of concerns between orchestration and persistence.
- Single enforcement point for auth, validation, and transaction policy.
- Better deployability when brain/MCP run outside the API host.
- Simpler future backend evolution (API contract stays stable).

### Negative

- Extra network hop for brain/MCP state operations.
- Requires maintaining API endpoints for internal state workflows.
- Local integration tests may need API stubs or explicit fallback modes.

## Implementation Notes

- Prefer dedicated API routes for domain operations.
- Internal SQL proxy endpoints may be used as a migration bridge, but domain routes are preferred long term.
- PR review checklist should reject new direct `bun:sqlite` imports in `src/brain/**` and `src/mcp/**` runtime code.

## Related

- ADR-010: Layered Communication Model
- ADR-011: Production-First Technology Selection
- `AGENTS.md` "Brain/DB separation" convention
