# Octopai Project Plan

## Vision

Build an AI agent orchestrator that coordinates multiple specialized AI agents ("arms") working on a shared codebase, with human oversight and communication via email.

## Guiding Principles

1. **Transparency** - All project state is in plain text files, version controlled
2. **Human-centric** - Humans are kept informed and in control
3. **Graceful degradation** - System works even if parts fail
4. **Pluggable** - Support any terminal-based AI agent via harnesses
5. **Observable** - 3D Garden visualization shows what's happening

---

## Communication Modes (New Requirement)

To keep humans, the brain, and arms aligned we now standardize three primary communication paths:

1. **CLI ↔ API Server** – The `octopai` CLI becomes a thin client that authenticates against the Hono REST API for every management action (spawn, list, kill, status). Local-only code paths are considered legacy fallbacks.
2. **Web UI ↔ API Server** – The React/Vite Observatory consumes the same authenticated REST and WebSocket endpoints, mirroring CLI capabilities with dashboards and controls.
3. **Mail Client ↔ Email Server** – A dedicated IMAP/SMTP gateway exposes the Maildir inbox/outbox so humans can use any email client. The gateway synchronizes threads with a coordination arm that mirrors conversations between the brain and worker arms.

---

## Phase 0: Core Infrastructure ✅ Complete

**Goal**: Basic brain/arm lifecycle and communication

### Deliverables
- [x] Brain polling loop (`src/brain/brain.ts`)
- [x] Maildir reader/writer (`src/mail/maildir.ts`)
- [x] MCP server with tools (`src/mcp/server.ts`)
- [x] Tentacle/arm spawner with headless mode (`src/tentacle/spawner.ts`)
- [x] CLI commands (`src/cli/index.ts`)
- [x] Docker + Gitea setup
- [x] Type definitions

### Acceptance Criteria
See [acceptance/phase-0.md](./acceptance/phase-0.md)

---

## Phase 1: Observatory Foundation 🔜 Next

**Goal**: Web UI and API for human observation and control

### Deliverables
- [ ] Hono API server with REST endpoints
- [ ] SQLite database with schema
- [ ] WebSocket for real-time updates
- [ ] React shell with routing
- [ ] Basic dashboard view
- [ ] Arm list and status view
- [ ] CLI proxy layer (spawn/list/kill/status) routed through the API
- [ ] Mail API surface (list/read/send) exposing Maildir metadata for downstream gateways

### Key Decisions Needed
- API authentication approach (see decisions/)
- React component library choice
- State management approach

### Estimated Duration
2-3 weeks

### Acceptance Criteria
See [acceptance/phase-1.md](./acceptance/phase-1.md)

---

## Phase 1.5: Email Gateway (New)

**Goal**: Operate an IMAP/SMTP bridge that keeps human email threads synchronized with the brain and working arms.

### Deliverables
- [ ] IMAP server backed by Maildir with authentication
- [ ] SMTP submission endpoint that routes inbound mail into the brain queue
- [ ] Coordinator arm (mail dispatcher) that mirrors relevant replies to working arms
- [ ] Health checks and observability for email transport

### Dependencies
- Phase 1

### Estimated Duration
1 week

---

## Phase 2: Arm Specialization

**Goal**: Arms have domains, context budgets, and file ownership

### Deliverables
- [ ] Domain configuration and patterns
- [ ] Context budget tracking and enforcement
- [ ] File claim system
- [ ] Thrashing detection (lazy claims)
- [ ] Handoff protocol between arms

### Estimated Duration
2 weeks

---

## Phase 3: Governance

**Goal**: Arms debate and reach consensus

### Deliverables
- [ ] Proposal system
- [ ] Arguments and signals
- [ ] Consensus calculation
- [ ] Reputation tracking
- [ ] Creative override flow
- [ ] Emergency stop (andon cord)

### Estimated Duration
2-3 weeks

---

## Phase 4: Garden Visualization

**Goal**: 3D visualization of workspace

### Deliverables
- [ ] React Three Fiber integration
- [ ] Radial coordinate system
- [ ] Real-time file activity display
- [ ] Ownership coloring
- [ ] Conflict zone highlighting
- [ ] Interactive navigation

### Estimated Duration
2 weeks

---

## Phase 5: Notifications & Deployment

**Goal**: Push notifications and deployment flow

### Deliverables
- [ ] Browser push notifications
- [ ] Deployment proposal flow
- [ ] Blue/green deployment support
- [ ] Rollback with pause
- [ ] Monitoring integration hooks

### Estimated Duration
2 weeks

---

## Phase 6: Agent Harnesses

**Goal**: Support multiple AI agents via pluggable harnesses

### Deliverables
- [ ] Harness interface and registry
- [ ] PTY session management
- [ ] OpenCode harness
- [ ] Claude Code harness
- [ ] Aider harness
- [ ] Harness test suite

### Estimated Duration
3 weeks

---

## Phase 7: Polish & Production

**Goal**: Production-ready system

### Deliverables
- [ ] PostgreSQL support
- [ ] Comprehensive test suite
- [ ] Performance optimization
- [ ] Security hardening
- [ ] Docker Swarm support
- [ ] User documentation

### Estimated Duration
2-3 weeks

---

## Milestones

| Milestone | Target | Description |
|-----------|--------|-------------|
| M1: Observable | End of Phase 1 | Can see arm activity in web UI |
| M2: Coordinated | End of Phase 3 | Arms negotiate and reach consensus |
| M3: Visual | End of Phase 4 | 3D Garden shows workspace state |
| M4: Multi-Agent | End of Phase 6 | Multiple agent types supported |
| M5: Production | End of Phase 7 | Ready for real use |

---

## Open Questions

See [decisions/](./decisions/) for resolved questions and [../docs/architecture/questions.md](../docs/architecture/questions.md) for open questions.

---

## Changelog

| Date | Change |
|------|--------|
| 2024-01-15 | Added PM arm documentation and .project structure |
| 2024-01-15 | Added agent harnesses documentation |
| 2024-01-15 | Comprehensive docs update (governance, security, deployment, etc.) |
| 2024-01-10 | Initial project setup, Phase 0 complete |
