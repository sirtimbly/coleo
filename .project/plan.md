# Octopai Project Plan

## Vision

Build an AI agent orchestrator that coordinates multiple AI arms working on a shared codebase, with human oversight via email. **Arms are not specialized**—they adapt their behavior based on task classification (architect, development, QA, etc.).

See [requirements.md](./requirements.md) for philosophy, [progressive-planning.md](./progressive-planning.md) for task determination, and [tasks-representation.md](./tasks-representation.md) for UI design.

## Guiding Principles

1. **Arms are general-purpose** - Behavior determined by task classification, not arm identity
2. **Progressive planning** - Tasks determined at runtime from plan documents
3. **Timeline UI** - Show recent activity + next task, not CRUD backlog
4. **Transparency** - All project state in plain text files, version controlled
5. **Human-centric** - Humans provide requirements; arms execute and report

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
- [x] Arm spawner with headless mode
- [x] CLI commands (`src/cli/index.ts`)
- [x] Type definitions
- [x] NATS integration for distributed arms

### Acceptance Criteria

See [acceptance/phase-0.md](./acceptance/phase-0.md)

---

## Phase 1: Observatory Foundation ✅ Complete

**Goal**: Web UI and API for human observation and control

### Deliverables

- [x] Hono API server with REST endpoints
- [x] SQLite database with schema
- [x] WebSocket for real-time updates
- [x] React shell with routing
- [x] Basic dashboard view
- [x] Arm list and status view
- [x] CLI proxy layer through API
- [x] Activity logging

### Key Decisions Made

- API authentication via API key (decisions/003)
- shadcn/ui components (decisions/004)
- Bun runtime (decisions/001)

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
- [ ] **Project Plan Viewer** in the web Observatory:
  - [ ] File/folder tree of `.project/` and key docs on the left (e.g., `README.md`, `plan.md`, `requirements.md`, `status.md`, `decisions/`, `acceptance/`, `plans/`, `tasks/`).
  - [ ] Markdown rendering panel on the right for the selected file.
  - [ ] Visible "Last Updated" timestamp for each rendered file, derived from git commit metadata or filesystem mtime.
  - [ ] Clear indication of which files changed most recently so humans can quickly find the latest updates.

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

## Phase 2: Task Classification & Context ✅ Complete

**Goal**: Implement task classifications (architect, development, QA, documentation) with context bundles for arms.

### Task Classifications

| Classification | Purpose | Output |
|----------------|---------|--------|
| Architect | Requirements → Plans | Plans, tasks |
| Development | Tasks → Code | Code, discoveries |
| QA | Code → Tests | Tests, doc verification |
| Documentation | Code → Feature Docs | Updated feature docs, "future work" notes |

### Deliverables

- [x] Task interface with `context` field (includes discoveries)
- [x] Discovery storage and indexing (SQLite with FTS5)
- [x] `getDiscoveriesForArm()` method in Brain
- [x] Task assignment includes discoveries context
- [ ] Classification-specific prompt templates
- [x] Context bundle builder (requirements, docs, decisions)
- [x] API endpoint for discoveries (`/api/discoveries`)

### Dependencies

- Phase 0 (Brain, MCP, CLI)

### Estimated Duration

1 week (completed as part of Jan 2026 work)

### Acceptance Criteria

- [x] Arms receive discoveries when tasks are assigned
- [x] Discoveries are stored in SQLite with FTS5 search
- [x] API provides discovery listing and search
- [ ] Arms can execute any task classification

---

## Phase 2.1: Progressive Planning (New)

**Goal**: Brain dynamically determines next task based on plan, history, and status reports.

### Progressive Task Determination

See [progressive-planning.md](./progressive-planning.md) for full design.

### Inputs to Task Assignment

| Source | Purpose |
|--------|---------|
| Plan documents | What needs to be done |
| Completed tasks | What's already done |
| Status reports | What issues were found |
| Discoveries | What's been discovered |
| Open tasks | What's in progress |

### Decision Logic

```
For each plan bullet point:
  IF completed AND no issues → skip
  IF completed BUT has issues → assign "verify & polish"
  IF incomplete AND ready → assign development task
  IF blocked → notify human
```

### Deliverables

- [ ] Brain re-evaluates plan on task completion
- [ ] Brain reads status reports to adjust task assignment
- [ ] "Verify & polish" task classification
- [ ] Plan document format specification
- [ ] History tracking for completed tasks
- [ ] Status report parsing and influence on tasking

### Dependencies

- Phase 2 (context bundles)

### Estimated Duration

2 weeks

---

## Phase 2.2: Documentation Updates (New)

**Goal**: Brain creates documentation update tasks to keep feature docs aligned with code.

### Purpose

As code is written, documentation of features and capabilities can become stale. The Brain periodically assigns tasks to:
- Review code changes since last doc update
- Ensure feature documentation matches actual implementation
- Add "future work" notes for incomplete features

### Scope: What Gets Updated

| Type | Update? | Notes |
|------|---------|-------|
| Feature documentation | ✅ Yes | Must match what code does |
| API documentation | ✅ Yes | Endpoints, parameters, behavior |
| Capability documentation | ✅ Yes | What the system can do |
| Conceptual documentation | ❌ No | Describes ideal state, not implementation |
| Architecture decisions | ❌ No | Describes intent, not current state |

### Trigger Conditions

Brain creates a documentation update task when:

1. **Phase completion**: Near end of a phase
2. **Threshold met**: N files changed since last doc update (configurable, default 10)
3. **Human request**: Human asks for doc review
4. **Periodic**: Every X polls (configurable)

### Task Classification: Documentation

When assigned, this is a **documentation** classification task:

- Arm reviews changed files
- Compares with existing feature docs
- Updates docs to match implementation
- Adds "Future Work" notes for incomplete features

### "Future Work" Notes

For features that exist in docs but not in code:

```markdown
## Feature X

**Status**: Planned for Phase N
**Details**: [description from plan]

_Note: This feature is planned but not yet implemented. See [plan link] for details._
```

For features partially implemented:

```markdown
## Feature X

**Status**: Partial Implementation
**Implemented**: [what's done]
**Pending**: [what's left for future phase]
```

### Deliverables

- [ ] Documentation update task classification
- [ ] Brain triggers doc updates on conditions
- [ ] Arm reviews changed files since last update
- [ ] Feature documentation sync logic
- [ ] "Future work" note template
- [ ] Track last doc update timestamp

### Dependencies

- Phase 2 (context bundles)
- Phase 2.1 (progressive planning for context)

### Estimated Duration

1 week

### Context for Doc Update Task

When Brain assigns a documentation task, it provides:

1. **Files changed** since last doc update (from git/file tracking)
2. **Existing feature docs** that may need updating
3. **Plan document** for "future work" notes
4. **Scope**: Only feature/capability docs, not conceptual docs

### Example Task Assignment

```
Task: Documentation Update
Classification: documentation

Context:
- 15 files changed since last doc update
- Features worked on: OAuth2, User API, Rate Limiting
- Existing docs: docs/features.md

Instructions:
Review the changed files and update docs/features.md to match
what's actually implemented. For any features not yet complete,
add "## Future Work" notes referencing the plan.

Do NOT update conceptual/architecture docs.
```

---

## Phase 2.5: Status Reports (New)

**Goal**: Formalize status reporting from arms to human via Brain.

### Status Report Flow

```
Arm → Status Report → Brain → Aggregates → Human (email)
                       ↓
              Updates task history
              Influences next task
```

### Deliverables

- [ ] Status report message type
- [ ] Status report parsing in Brain
- [ ] Brain aggregates and routes to human
- [ ] Status influences task determination
- [ ] Status dashboard in API

### Dependencies

- Phase 2.1 (Progressive Planning)

### Estimated Duration

1 week

---

## Phase 2.6: Agentic Brain (New)

**Goal**: Transform Brain from polling loop with hardcoded logic into an agentic AI system.

### Agentic Brain Design

See [brain-agent-plan.md](./brain-agent-plan.md) for full implementation details.

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Agentic Brain                                 │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐    ┌─────────────────┐    ┌──────────────┐    │
│  │ Human Input │───▶│  Brain Agent    │───▶│ Arm Actions  │    │
│  │ (Email/     │    │  (LLM + Tools)  │    │ (via MCP/    │    │
│  │  Tasks)     │    │                 │    │  NATS)       │    │
│  └─────────────┘    └─────────────────┘    └──────────────┘    │
│                           │                                      │
│                           ▼                                      │
│                  ┌─────────────────┐                             │
│                  │  Tools (SQLite, │                             │
│                  │   File System,  │                             │
│                  │   MCP, NATS)    │                             │
│                  └─────────────────┘                             │
└─────────────────────────────────────────────────────────────────┘
```

### Framework: LangChain.js

- `createAgent` API for clean agent pattern
- Tool calling with Zod schema validation
- Memory/checkpointer for conversation state
- GPT-4.1 for reasoning, GPT-4.1 Codex for code tasks

### Brain Agent Tools

| Tool | Purpose |
|------|---------|
| `readPlan` | Read plan documents |
| `getTaskHistory` | Query completed/in-progress tasks |
| `getStatusReports` | Parse arm status reports |
| `getDiscoveries` | Query discoveries (FTS5) |
| `determineNextTask` | Core progressive planning |
| `assignTask` | Send task to arm |
| `storeDiscovery` | Save discovery to SQLite |
| `sendToHuman` | Write to Maildir |
| `getArmStatus` | Check arm health, detect stuck loops |

### Deliverables

- [ ] LangChain.js integration
- [ ] BrainAgent class with all tools
- [ ] System prompt for Brain agent
- [ ] Tool implementations (9 tools)
- [ ] Memory/checkpointer for state
- [ ] Fallback to existing logic on errors

### Migration Strategy

1. Create `src/brain/agent/` directory
2. Implement agent and tools
3. Replace functions one at a time:
   - `determineNextTask()` → use agent
   - `handleDiscovery()` → use agent
   - `handleHumanMessage()` → use agent
4. Keep polling loop as orchestrator

### Dependencies

- Phase 2 (Task Classification)
- Phase 2.1 (Progressive Planning)
- Phase 2.5 (Status Reports)

### Estimated Duration

3 weeks

### Acceptance Criteria

- [ ] Agent makes reasonable task determinations
- [ ] Discovers are properly stored and surfaced
- [ ] Human messages get appropriate responses
- [ ] Stuck arms are detected and handled
- [ ] Fallback logic works when LLM unavailable

---

## Phase 3: Governance

**Goal**: Arms debate and reach consensus on plans and changes.

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

## Phase 6: Agent Harnesses ⚠️ Deferred

**Goal**: Support multiple AI agents via pluggable harnesses.

### Current Status: Focus on opencode-api only

**Decision**: PTY-based harnesses are complex and unreliable. We will focus on the `opencode-api` harness which works reliably via HTTP. Other harnesses are deferred to Phase 7+.

### Current Harness: opencode-api ✅

The `opencode-api` harness works reliably:
- HTTP-based communication (no PTY required)
- Simple MCP integration
- No terminal/PTY complications
- Works consistently across environments

### Deferred Harnesses (Phase 7+)

| Harness | Status | Reason |
|---------|--------|--------|
| Claude Code | Deferred | Requires PTY, complex session management |
| Aider | Deferred | Requires PTY, session management issues |
| Custom PTY harness | Deferred | PTY complexity, cross-platform issues |

### What Was Tried

- OpenCode with PTY (native terminal) - Unreliable
- Claude Code with PTY - Complex session handling
- Aider with PTY - Same PTY issues

### What Works

- opencode-api harness via HTTP - Reliable, simple, consistent

### Future Work (Phase 7+)

If PTY issues are resolved:
- [ ] Re-evaluate PTY-based harnesses
- [ ] Implement harness abstraction layer
- [ ] Add PTY session management (if needed)
- [ ] Support for other agents

### Estimated Duration

1 week (opencode-api only, done)
Future: 3+ weeks (if PTY harnesses revisited)

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
- [ ] PTY harness evaluation (if issues resolved)

### Estimated Duration

2-3 weeks

---

## Milestones

| Milestone | Target | Description |
|-----------|--------|-------------|
| M1: Observable | End of Phase 1 | Can see arm activity in web UI |
| M2: Coordinated | End of Phase 3 | Arms negotiate and reach consensus |
| M3: Visual | End of Phase 4 | 3D Garden shows workspace state |
| M4: Agentic | End of Phase 2.6 | Brain uses agentic decision making |
| M5: Production | End of Phase 7 | Ready for real use |

**Note**: M4 "Multi-Agent" (multiple harness types) is removed. We use opencode-api only for reliability.

---

## Open Questions

See [decisions/](./decisions/) for resolved questions and [../docs/architecture/questions.md](../docs/architecture/questions.md) for open questions.

---

## Changelog

| Date | Change |
|------|--------|
| 2026-01-16 | Phase 2.2: Documentation update tasks (keep feature docs aligned with code) |
| 2026-01-16 | Phase 6 focused on opencode-api only; PTY harnesses deferred to Phase 7+ |
| 2026-01-15 | Updated philosophy: Arms are not specialized (ADR-009) |
| 2026-01-15 | Added requirements.md with task classification details |
| 2026-01-15 | Added PM arm documentation and .project structure |
| 2026-01-15 | Added agent harnesses documentation |
| 2026-01-15 | Comprehensive docs update (governance, security, deployment, etc.) |
| 2024-01-10 | Initial project setup, Phase 0 complete |
