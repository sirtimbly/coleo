# Observatory Resilience Verification (2026-09-22)

Task: `phase2ob-7a6ca6` — establish Observatory resilience primitives.

## Verdict: VERIFIED (with one noted gap)

### Error boundaries — pass

`ScreenErrorBoundary` is mounted at every containment level: app root
(`main.tsx`), screen (`App.tsx` with route-keyed reset), Golden Layout
panels (`WorkspaceRoutePanel`), sheets (`ResourceSheet`), Inbox tables,
and per-card (`BoundaryContent` renders third-party callbacks inside
React so their errors reach the boundary). Failed units show try-again /
close-tab actions and never reset siblings.

Evidence: `bunx playwright test error-boundaries` — **3/3 pass**
(crashed-tab isolation + local retry + sibling state; standalone reset
on route change; failed-card containment).

### Connection, startup, retry — pass

- `WorkspaceConnectionNotice`: aria-live, 5s grace before display,
  auto-reconnect messaging, manual Reconnect after 180s; mounted
  workspace and inputs survive rollouts.
- `useWebSocket`: exponential-backoff reconnect (30s cap), reset on
  manual reconnect, 30s ping keepalive, shared transport.
- SSE (`useArmEvents`): connection kept open for native reconnect.
- `WorkspaceStartup` elapsed-time startup state; `HostedSessionNotice`
  and `AppMessageOverlay` for session/message surfaces.

### Loading / empty / error states — pass (pattern)

Pervasive per-page handling: `DenseRowSkeleton` loaders, `isLoading` /
`isError` branches, "No X yet" empty states, stale-data marking
instead of showing old counts as current.

Evidence: `bunx playwright test dashboard.spec` — **3/3 pass**
(failed refresh never shows stale counts; stale Brain state exposed
with drilldowns retained; narrow-screen containment).

### Route recovery — pass

Boundary `resetKey` follows route (App) and record identity (cards);
standalone failures reset on navigation; Golden Layout close-tab
removes only the failed panel.

### Telemetry gap (noted, non-blocking)

Client failures go to `console.error` (boundary `componentDidCatch`)
and surface as UI states; no client error-telemetry aggregation
exists. Server-side logs and API health/staleness signals are the
operational telemetry. Recommend a future error-reporting hook, not a
gate on dependent pages.
