# Implementation Phases

This document outlines the phased approach to building Coleo's full architecture.

## Timeline Overview

| Phase | Focus | Duration | Status |
|-------|-------|----------|--------|
| Phase 0 | Core Infrastructure | Complete | Done |
| Phase 1 | Observatory Foundation | 2 weeks | In progress |
| Phase 2 | Task Classification & Context | 2 weeks | In progress |
| Phase 3 | Governance | 2 weeks | Planned |
| Phase 4 | Garden Visualization | 2 weeks | Planned |
| Phase 5 | Notifications & Deployment | 2 weeks | Planned |
| Phase 6 | Polish & Production | 2 weeks | Planned |

---

## Phase 0: Core Infrastructure (Complete)

**What's already built:**

- [x] Brain polling loop (`src/brain/brain.ts`)
- [x] Maildir communication (`src/mail/maildir.ts`)
- [x] MCP server with basic tools (`src/mcp/server.ts`)
- [x] Arm spawner (`src/arm/spawner.ts`)
- [x] CLI commands (`src/cli/index.ts`)
- [x] Docker + Gitea setup
- [x] Type definitions (`src/types/index.ts`)

---

## Phase 1: Observatory Foundation

**Goal:** Get the web UI and API server running with basic functionality.

### Tasks

- [x] **1.1** Set up Hono API server
  - Create `src/api/server.ts`
  - Basic middleware (auth, logging, error handling)
  - Health check endpoint

- [x] **1.2** Database implementation
  - Create `src/db/index.ts`
  - SQLite implementation with WAL mode
  - Initial migrations
  - Seed data for development

- [x] **1.3** Core API endpoints
  - `/api/status` - System overview
  - `/api/brain` - Brain state and control
  - `/api/arms` - CRUD for arms
  - `/api/config` - Configuration

- [x] **1.4** WebSocket handler
  - Create `src/api/websocket.ts`
  - Channel subscription system
  - Event broadcasting (arms, activity, brain)

- [x] **1.5** React UI shell
  - React project in `src/web/`
  - Basic layout (sidebar, header, content)
  - Dashboard view with system status
  - Arm list view

- [x] **1.6** Integration
  - Brain connects to Observatory via `/api/brain/notify`
  - Real-time status updates via WebSocket
  - Brain broadcasts: started, stopped, poll events

### Deliverable

A working web UI at `http://localhost:3001` showing:
- System status
- List of arms
- Basic arm spawning/killing

---

## Phase 2: Task Classification & Context

**Goal:** Give arms classification-driven behavior, context budgets, and ownership capabilities.

### Tasks

- [ ] **2.1** Task classification and templates
  - Define task classification keys and default patterns (e.g. architect:project-management, development:default, qa:default, documentation:default)
  - Create task configuration templates (in code) and align arm profile configuration templates (`templates/arms/*.toml`) with them
  - Update task assignment and arm spawning to respect classifications and templates
  - Keep a single default starter profile (`templates/arms/default.toml`) and treat additional profiles as optional user-defined copies

- [ ] **2.2** Context budget tracking
  - Implement `ContextBudget` type
  - Token estimation for files
  - Auto-pruning logic

- [ ] **2.3** Ownership claims
  - Create `claims` table
  - Claim request/grant logic
  - Conflict detection

- [ ] **2.4** API endpoints
  - `/api/arms/:id/context`
  - `/api/arms/:id/claims`
  - `/api/garden/claims`
  - `/api/garden/conflicts`

- [ ] **2.5** UI updates
  - Context utilization gauges
  - Ownership visualization
  - Conflict alerts

- [ ] **2.6** MCP tools update
  - `claim_file` tool for arms
  - `release_claim` tool
  - `handoff_request` tool

- [ ] **2.7** Architectural Guidance System
  - Create `architectural_decisions` table (migration)
  - Implement MCP tools:
    - `get_storage_guidance` - Where to store data
    - `get_architectural_decision` - Query decisions
    - `check_architectural_alignment` - Validate changes
  - Create Architect arm domain profile
  - Add proposal review hook for Architect

- [ ] **2.8** Documentation Watcher
  - Create file watcher service for `docs/` directory
  - Track document versions and changes via hash
  - Notify brain when documentation changes
  - Implement MCP tools:
    - `get_documentation` - Fetch current doc content
    - `check_documentation_changes` - Detect updates since last read
    - `find_relevant_docs` - Find docs relevant to current task
    - `update_documentation` - Write updated doc content
  - Arms auto-reload relevant docs on change
  - Brain re-prioritizes tasks when plans/requirements change

- [ ] **2.9** Email-to-Documentation Workflow
  - Parse user emails for documentation update intent
  - Create `doc_update` tasks classified as `documentation`
  - Route documentation-classified tasks to appropriate arms based on recent work and preferences (not fixed docs-only identities)
  - Notify human when docs are updated
  - Broadcast updates to other arms so they can reassess their work against the new documentation

### Deliverable

Tasks with explicit classifications, and arms that claim files and respect context limits while executing those tasks.

---

## Phase 3: Governance

**Goal:** Implement the proposal/persuasion system for arm collaboration.

### Tasks

- [ ] **3.1** Proposal system
  - Create `proposals` table
  - Proposal creation and lifecycle
  - Argument and signal tracking

- [ ] **3.2** Consensus calculation
  - Weighted signal aggregation
  - Reputation-based multipliers
  - Auto-resolution logic

- [ ] **3.3** Reputation system
  - Create `reputation_events` table
  - Reputation event tracking
  - Reputation effects on influence

- [ ] **3.4** Brain intervention
  - Misbehavior detection rules
  - WARN/PAUSE/KILL actions
  - Proposal veto logic

- [ ] **3.5** Creative override
  - Override request flow
  - Risk acknowledgment
  - Brain approval/rejection

- [ ] **3.6** API endpoints
  - `/api/proposals`
  - `/api/proposals/:id/argue`
  - `/api/proposals/:id/signal`
  - `/api/proposals/:id/resolve`

- [ ] **3.7** UI updates
  - Proposal list view
  - Proposal detail with arguments/signals
  - Signal submission UI

- [ ] **3.8** MCP tools
  - `create_proposal` tool
  - `add_argument` tool
  - `signal_proposal` tool
  - `override_proposal` tool

### Deliverable

Arms can propose, debate, and reach consensus on decisions.

---

## Phase 4: Garden Visualization

**Goal:** 3D visualization of the codebase with ownership and activity.

### Tasks

- [ ] **4.1** Coordinate calculation
  - Implement X (stack layer) heuristic
  - Implement Y (coupling) heuristic
  - Implement Z (volatility) heuristic

- [ ] **4.2** Garden topology API
  - `/api/garden` endpoint
  - Real-time updates via WebSocket

- [ ] **4.3** 3D visualization
  - Set up React Three Fiber
  - File node rendering
  - Camera controls (orbit, zoom)

- [ ] **4.4** Ownership coloring
  - Color scheme for arm domains
  - Ownership boundaries
  - Conflict zone highlighting

- [ ] **4.5** Activity overlay
  - Recent touch indicators
  - Activity trails
  - Arm movement animation

- [ ] **4.6** Interactivity
  - Click to select file/node
  - Hover tooltips
  - Filter by arm/domain

### Deliverable

An interactive 3D map of the codebase showing who's working where.

---

## Phase 5: Notifications & Deployment

**Goal:** Browser push notifications and automated deployment with consensus.

### Tasks

- [ ] **5.1** Push notification setup
  - Generate VAPID keys
  - Subscription management
  - Push sender implementation

- [ ] **5.2** Notification triggers
  - Human approval needed
  - Deployment events
  - Security alerts

- [ ] **5.3** Environment configuration
  - Environment tiers
  - Auto-deploy rules
  - Human approval gates

- [ ] **5.4** Deployment flow
  - Deployment request handling
  - Consensus collection
  - Human approval queue

- [ ] **5.5** Rollback mechanics
  - Rollback plan storage
  - Automatic rollback triggers
  - Rollback execution

- [ ] **5.6** API endpoints
  - `/api/notifications/subscribe`
  - `/api/deployments`
  - `/api/approvals`

- [ ] **5.7** UI updates
  - Approval queue view
  - Deployment history
  - Push subscription management

### Deliverable

Full deployment workflow with arm consensus and human approval.

---

## Phase 6: Polish & Production

**Goal:** Production-ready system with proper error handling and docs.

### Tasks

- [ ] **6.1** PostgreSQL implementation
  - Create `src/db/postgres.ts`
  - Connection pooling
  - Transaction handling

- [ ] **6.2** Performance optimization
  - Database query optimization
  - WebSocket connection pooling
  - Asset bundling and caching

- [ ] **6.3** Error handling
  - Graceful degradation
  - Error recovery
  - User-friendly error messages

- [ ] **6.4** Testing
  - Unit tests for core logic
  - Integration tests for API
  - E2E tests for critical flows

- [ ] **6.5** Documentation
  - API documentation
  - Deployment guide
  - Troubleshooting guide

- [ ] **6.6** Monitoring
  - Metrics collection
  - Health dashboards
  - Alerting setup

### Deliverable

Production-ready Coleo deployment.

---

## Quick Wins (Can Do Anytime)

These can be tackled between phases or in parallel:

- [ ] Add more arm domain templates
- [ ] Improve CLI output formatting
- [ ] Add `coleo gitea` wrapper commands
- [ ] Create Docker images for different agents
- [ ] Add dark mode to web UI
- [ ] Improve error messages
- [ ] Add command auto-completion

---

## Dependencies Between Phases

```
Phase 0 ─┬─► Phase 1 ─┬─► Phase 2 ───► Phase 3
         │            │                   │
         │            └─► Phase 4         │
         │                                │
         └────────────────────────────────┴─► Phase 5 ─► Phase 6
```

- Phase 1 (Observatory) can start immediately
- Phase 2 (Task Classification & Context) requires Phase 1 for UI
- Phase 3 (Governance) requires Phase 2 for arm profiles
- Phase 4 (Garden) can run parallel to Phases 2-3
- Phase 5 (Deployment) requires Phase 3 for consensus
- Phase 6 (Polish) is final integration

---

## Success Metrics

| Phase | Success Criteria |
|-------|------------------|
| 1 | Web UI loads, shows arms, can spawn/kill |
| 2 | Tasks have classifications, arms claim files, context tracked, no overflow |
| 3 | Proposals work, consensus calculated, overrides logged |
| 4 | 3D garden renders, ownership visible, interactive |
| 5 | Push notifications work, deployments flow through approval |
| 6 | 99.9% uptime, <100ms API latency, all tests pass |
