# Phase 0 Runtime Stack Validation - 2026-09-22

## Scope

Validated the runtime and primary application stack required by Phase 0 against the
accepted decisions and the current source tree. This is code and configuration
evidence only; it does not validate deployment or full service startup.

## Confirmed Stack

| Concern | Evidence | Result |
| --- | --- | --- |
| Bun runtime | `package.json` pins `bun@1.3.6`; the environment reports Bun `1.3.14`; `src/api/server.ts` uses `Bun.serve`. | Conforms to ADR-001. |
| Hono API | `package.json` declares `hono`; `src/api/server.ts` constructs `Hono<ServerContext>` and mounts authenticated routes. | Confirmed. |
| React and Vite UI | `src/web/package.json` declares React and Vite; `src/web/vite.config.ts` uses the React plugin; `src/web/src/App.tsx` composes the routed application. | Confirmed. |
| SQLite state | `src/db/index.ts` uses `bun:sqlite`, WAL mode, foreign keys, and the migration catalog. | Conforms to ADR-001. |
| NATS messaging | `package.json` declares `nats`; `src/nats/server.ts` manages configured connections; `docker-compose.yml` supplies NATS with JetStream enabled. | Confirmed. |
| API-key authentication | `src/api/middleware/auth.ts` checks `X-API-Key`; `src/api/server.ts` applies it to `/api/*` except the public health endpoint and applies matching WebSocket authentication. | Functionally conforms to ADR-003. |
| shadcn-inspired UI patterns | Locally owned components such as `src/web/src/components/Card.tsx`, the `cn()` helper, Tailwind, and CSS variables remain in use. | Pattern conforms to ADR-004. |

## Validation

- `bun run typecheck` passed.
- `bun test ./src/api/__tests__/websocket-proxy-auth.test.ts` passed: 2 tests, 0 failures.

## Required Decision Follow-up

The following discrepancies mean this validation is not an unqualified architectural
conformance sign-off:

1. ADR-003 documents `OCTOPAI_API_KEY`, but `src/network-config.ts` supports
   `COLEO_API_KEY` and `COLEO_API_TOKEN`. Update the ADR to the current public
   configuration name, or explicitly restore the documented alias.
2. ADR-004 states that the shadcn-inspired approach avoids an external component
   library dependency. The active web workspace declares and imports
   `@heroui/react` and `@heroui/styles`. The current local component and Tailwind
   patterns preserve the visual approach, but a human architectural decision is
   needed to either approve HeroUI as an exception or migrate it out.

Until those decisions are resolved, this Phase 0 item is evidenced but should remain
open rather than being treated as fully conformant.
