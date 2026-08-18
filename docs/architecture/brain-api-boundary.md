---
title: Brain/API Boundary
description: Understand the clean operational boundary that keeps Brain access typed, authenticated, and independent of transport details.
banner:
  src: /coleo-architecture-brain-api-boundary.png
  alt: A thoughtful octopus brain works inside a quiet observatory while every message capsule from agent submersibles passes through one illuminated hatch in a brass boundary.
  eyebrow: Clean Boundaries
  position: center 51%
---

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

## Current State

1. API subscribes to `coleo.brain.messages` and bridges ingress into the DB-backed inbox queue.
2. Brain consumes queue messages exclusively via API (`/api/brain/internal/messages/*`).
3. Inbox admission is allowlisted and payload-validated at API boundaries.
4. Invalid/unsupported ingress is captured as dead-letter records (`brain.deadletter`).
5. Processing uses lease semantics (`processing` acquisition with stale-lease recovery).
6. API exposes dead-letter inspection/requeue endpoints for controlled replay.
7. Arm message/todo reads are routed through ArmAgent (distributed) or HarnessManager abstractions (local), not route-level OpenCode proxy calls.
8. Arm event SSE endpoint is backed by JetStream query polling, not OpenCode event proxying.

## Remaining Hardening

1. Add contract tests for API event/message schemas across services.
2. Continue consolidating remaining legacy message fallback paths (for example MCP direct SQLite inbox fallback) under the same API/NATS-first contract.
