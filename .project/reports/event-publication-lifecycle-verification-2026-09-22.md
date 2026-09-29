# Event Publication + Lifecycle Verification (2026-09-22)

Task: `phase1co-0cc5b9`.

## Verdict: VERIFIED

### Chain (all links API-boundary conformant)

1. **Harness → NATS (owner: harness layer).** `HarnessManager.emitEvent`
   (`src/harness/manager.ts:97`) and `ArmAgent` via
   `natsClient.publishArmEvent` (`src/nats/client.ts:285`) publish to
   `coleo.events.arm.{armId}.{event}` with truncated payloads and
   best-effort failure logging. Harness-owned JetStream access is
   correct per the boundary plan.
2. **NATS → API (owner: API server).** The command-projector bridge
   (`src/api/brain-message-bridge.ts`) validates command envelopes,
   projects to pending DB messages, deduplicates by envelope id, and
   dead-letters with operator requeue
   (`POST /api/brain/internal/messages/*`, typed 400s).
3. **API → Brain (owner: Brain as API client).** Brain consumes via
   authenticated queue/inbox/event routes and publishes via `POST
   /api/events/internal/publish` (commit `d9db755`; enforced by
   `api-boundary.test.ts`). No Brain→NATS/harness calls remain.
4. **API → UI.** SSE streams, event window/recent/telemetry routes,
   and WebSocket updates (verified separately).

### Evidence

- bridge + internal-messages + runtime-flows suites: **27/27 pass**
  (projection, dedup, queue validation, dead-letter requeue).
- Brain boundary regression test: pass (no runtime NATS imports).

No code changes required.
