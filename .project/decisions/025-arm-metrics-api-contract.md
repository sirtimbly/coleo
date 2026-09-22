# ADR-025: Arm-Metrics API Contract

## Status

Accepted

## Date

2026-09-22

## Context

The plan cancelled `Add arm metrics endpoints` (server-side
graph/sparkline aggregation) and requires this task to name the
approved replacement, its auth/windows/retention/polling/cache/failure
semantics, and to verify the cancelled contract was not reintroduced.
Verified 2026-09-22 against `src/api/routes/arms.ts`,
`src/api/arm-metrics.ts`, `src/web/src/lib/api.ts`, the chart
components, and the route/metrics tests.

## Decision

The approved replacement is summary + bounded-sample reads with
client-side graph aggregation — not server-aggregated graphs:

| Route | Contract |
|---|---|
| `POST /api/arms/:id/metrics` | Ingest token/cost/task deltas; snapshots `arm_metric_history` only on change; 404 unknown arm |
| `GET /api/arms/:id/metrics` | Point-in-time summary (status, context used/budget/utilization, totals, timestamp); 404 unknown arm |
| `GET /api/arms/:id/context-history?windowMs` | Raw samples from `arm_metric_history`; window clamped 1 min–24 h (default 30 min); single-point fallback during migrations; 404 unknown arm |
| `GET /api/arms/:id/cost-history?windowMs` | Per-message cumulative samples from `arm_message_metrics`; same window rules; `"current"` fallback; 404 unknown arm |

- **Auth:** global `/api/*` middleware (`X-Coleo-API-Key` /
  `X-API-Key` / `?api_key`; only `/api/health` public).
- **Aggregation windows:** server returns raw bounded samples;
  minute-bucketing and sparklines are built client-side (charts poll
  every 12 s over a 30-min window).
- **Retention:** `arm_metric_history` pruned to 7 days on write.
  `arm_message_metrics` upserts by `(arm_id, message_id)` with no time
  prune (running totals accumulate; dead-arm views retain recent
  items per the Arm Viewer task) — revisit if unbounded growth shows
  in practice.
- **Polling/cache:** UI polls (12 s charts); `localStorage` sample
  cache (240 max); React Query `retry: false` — no silent retries.
- **Failure:** 404 unknown arm; 503 store-unavailable on event-backed
  paths; UI renders error/empty states, never stale data as current
  (dashboard e2e). Rolling-migration fallbacks return the current
  reading rather than failing.

## Cancelled contract check

No route provides server-side full-graph/sparkline aggregation for
arms — the cancelled shape was not reintroduced. `GET
/api/events/*/metrics|telemetry` minute buckets are a separate
approved activity surface, not arm metrics. Any future
server-aggregated arm endpoint requires amending this record.

## Related Records

- Plan Phase 2 (cancelled arm-metrics item; this task is its resolution)
- `src/api/arm-metrics.ts`, `src/api/routes/arms.ts`
- Tests: `arms-metrics-routes.test.ts`, `arm-metrics.test.ts`
