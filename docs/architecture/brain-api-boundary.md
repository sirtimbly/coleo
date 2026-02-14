# Brain/API Boundary and Arm Event Flow

This document defines the operational boundary between the Brain, API server, and ArmAgent.

## Decision Summary

1. The Brain connects to the API server for all remote procedures.
2. The Brain does not connect directly to NATS or JetStream.
3. Arm events and arm-to-brain messages are persisted through NATS and exposed to the Brain through API endpoints.
4. ArmAgent is the only process that talks to harness/OpenCode APIs.
5. API server is the typed/authenticated boundary for Brain access to task, arm, event, filesystem, and database operations.

## Process Responsibilities

### Brain

Allowed:
- API calls to `coleo` API server.
- Inference calls to OpenAI-compatible model endpoints.
- Local reads from `.coleo/`.
- Local writes to stdout/log files.

Not allowed:
- Direct NATS subscriptions/publications.
- Direct JetStream reads/writes.
- Direct harness/OpenCode API calls.
- Direct SQLite access.

### API Server

Allowed:
- AuthN/AuthZ and request validation.
- Typed route contracts for Brain and UI.
- NATS/JetStream integration.
- Persistence and query interfaces.

Not allowed:
- Direct harness/OpenCode traffic for distributed arms.

### ArmAgent

Allowed:
- Command/control over local harness instances.
- Harness/OpenCode API integration.
- Publishing arm lifecycle/activity events and arm-to-brain messages via NATS.

## Messaging Model

### Canonical event source

- Canonical stream: JetStream event stream(s) for arm activity and control-plane events.
- Brain reads recent events through API endpoints only.
- API owns filtering, shaping, and schema evolution for event consumers.

### Brain ingress channel

- Brain has one incoming logical channel: API queue endpoint(s) for pending Brain messages.
- API bridges NATS arm-to-brain messages into this queue.
- Brain polls the queue and marks message status (`processing`, `completed`, `failed`) through API.

### Why not direct Brain pub/sub?

Direct Brain pub/sub is low-latency, but it creates duplicate transport logic in Brain and API, weakens boundary guarantees, and increases coupling to NATS internals. Keeping Brain behind API preserves typed contracts, auth, and maintainable evolution.

If immediate wake-up behavior is needed, use API-mediated signaling (for example a lightweight notify endpoint or WebSocket trigger), while keeping message payload retrieval through API queue/event endpoints.

## Refactor Phases

1. **Phase 1: Brain ingress boundary**
   - API subscribes to `coleo.brain.messages`.
   - API writes messages into Brain queue table.
   - Brain consumes queue via API only.
2. **Phase 2: Brain event boundary**
   - Replace direct Brain JetStream writes/reads with API routes.
   - Remove Brain direct NATS/JetStream dependencies.
3. **Phase 3: ArmAgent ownership**
   - Remove API direct harness/OpenCode reads for distributed arms.
   - Route distributed arm procedures through ArmAgent command/event contracts.
4. **Phase 4: Hardening**
   - Add replay/recovery tests across process restart/network partition scenarios.
   - Add contract tests for API event/message schemas.
