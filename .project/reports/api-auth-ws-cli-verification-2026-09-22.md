# Auth/Authz/Error/WS/CLI Verification (2026-09-22)

Task: `phase1co-7e5a42`.

## Verdict: VERIFIED (one known gap, non-blocking)

### Authentication — pass

Server middleware (`src/api/middleware/auth.ts`) accepts
`X-Coleo-API-Key`, `X-API-Key`, or `?api_key`; `/api/health` is
public; `dev-` keys bypass (local dev only). CLI sends `X-API-Key`
on REST (`tasks.ts`) and in-band `{type:"auth",apiKey}` on WebSocket
(`arm.ts`); init generates/persists `COLEO_API_KEY`. Prior
Bearer-header mismatch in `brain-api-client.ts` is fixed (commit
`d9db755`). 401 paths covered across route suites.

### Authorization — pass by Phase 1 design

Single shared key (ADR-003); no per-user/per-resource authz layer.
Human approvals flow through proposals and human-review passes, not
the transport credential. Multi-user authz is explicit future work.

### Error handling — pass

`HttpError` middleware preserves typed 400/401/403/404 JSON, sanitizes
500s, logs only 5xx, and includes stacks in development only.
Status-report validation returns explicit 400s without persistence
(commit `fdfbbff`).

### Logging — partial (known gap)

Server: leveled logger + 5xx console errors. Client: `console.error`
only, no aggregation pipeline (same gap as the resilience report).
Non-blocking for Phase 1; operational telemetry remains server-side.

### WebSocket — pass

Proxy-aware upgrade auth + in-band key auth tested
(`websocket-proxy-auth.test.ts`); client uses exponential-backoff
reconnect with ping and manual reconnect; SSE uses native reconnect;
connection notice is aria-live with grace/escalation timing.

### API-to-CLI integration — pass

CLI resolves `COLEO_API_KEY`/`COLEO_API_TOKEN`, passes `X-API-Key`,
and surfaces API errors without crashing the shell process (verified
surface-failure e2e for unavailable API).

## Evidence

- tasks + bugs suites: 100/100 (incl. 401/404 paths)
- websocket-proxy-auth + status-reports: 8/8
- CLI web + network-context: 4/4
- e2e surface-failure: 4/4; error-boundaries + dashboard: 6/6

No code changes required.
