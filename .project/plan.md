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
3. **Mail Client ↔ Email Server** – A future IMAP/SMTP gateway will expose the Maildir inbox/outbox so humans can use any email client. Until then, humans interact via Maildir-backed tools and the Observatory’s Mail UI.

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

### Enhancements (Non-Blocking)

These are useful Observatory improvements that build on Phase 1 but do not retroactively block calling the phase "complete":

- **Project Plan Viewer** in the web Observatory:
  - File/folder tree of `.project/` and key docs on the left (e.g., `README.md`, `plan.md`, `requirements.md`, `status.md`, `decisions/`, `acceptance/`, `plans/`, `tasks/`).
  - Markdown rendering panel on the right for the selected file.
  - Edit mode to modify plan documents directly in the browser.
  - Visible "Last Updated" timestamp for each rendered file, derived from git commit metadata or filesystem mtime.
  - Clear indication of which files changed most recently so humans can quickly find the latest updates.

- **Mail and Message Interface** enhancements:
  - Show sent messages from users to the brain or arms (currently only shows inbox).
  - Threaded conversation view with arm responses.

- **Task List enhancements**:
  - Show past completed tasks
  - Show current in-progress task
  - Show next scheduled/upcoming task
  - Timeline view with recent activity

- **Arm Viewer Page** (central arm detail view):
  - Accessible by clicking on any arm anywhere in the UI
  - Shows live arm status and activity
  - Displays history of all arms that have closed/finished in this project
  - For dead arms: retains only the last 100 activity items (not full history)
  - Color-coded arms with unique randomly-assigned colors

- **Arm Activity & Efficiency Visualization** (NEW):
  - **Activity Bar Graph** (30-minute window, minute-by-minute):
    - Stacked/grouped bars showing events per minute
    - Event types with distinct colors/dots:
      - File writes (blue)
      - Thinking/reasoning (yellow)
      - Tool calls (green)
      - Completed tasks (purple, prominent)
    - Gaps left for inactive minutes to show efficiency patterns
    - Tasks "pile up" vertically within each minute bar
    - Shows at-a-glance how active and efficient the arm is being
  - **Context Length Line Graph** (below activity graph):
    - Higher resolution than activity graph (e.g., every 10-15 seconds)
    - Shows context token usage over time
    - Visual indicator when approaching compression threshold (80%)
    - Warning zone shading near context limits
  - **Cost/Money Usage Line Graph** (below context graph):
    - Shows cumulative cost in dollars over the 30-minute window
    - Data sourced from OpenCode API:
      - Model pricing: `GET /provider` → `Provider.models[].cost` (input/output/cache rates per token)
      - Per-message cost: `AssistantMessage.cost` (calculated cost per response)
      - Token usage: `AssistantMessage.tokens` (input, output, reasoning, cache read/write)
    - Graph features:
      - Running total line showing spend over time
      - Optional: stacked area showing input vs output vs cache costs
      - Cost rate indicator ($/hour based on recent activity)
      - Budget threshold line if configured
    - Helps users understand:
      - Which arms are expensive vs cheap
      - Cost spikes during complex reasoning
      - ROI of different model choices
  - **Two display modes**:
    - **Full view** (Arms list page): Complete 30-minute graphs with legends
    - **Compressed view** (Arm Viewer page): Sparkline-style mini graphs
  - **Data sources**:
    - Generated from SSE event stream data
    - Frontend polls for graph data (aggregated metrics endpoint)
    - Live events still come via WebSocket for real-time list updates
  - **API endpoints needed**:
    - `GET /api/arms/:id/metrics` - Aggregated activity data for graphs
    - `GET /api/arms/:id/context-history` - Context length over time
    - `GET /api/arms/:id/cost-history` - Cost data over time (from OpenCode `/provider` and message events)

- **Arm Spawning from Web UI**:
  - Form to spawn new arms directly from the browser
  - Name input auto-populates with generated names
  - Button to regenerate new name if user doesn't like it
  - Provider and model selection dropdowns with cost estimates and budget warnings
  - Real-time feedback on spawn status

- **Model Recommendations & Budget Tracking**:
  - Show cost estimates per model (GPT-4.1 vs Claude-3.5) based on expected token usage
  - Include budget warnings for high-cost models when spawning arms

- **Message Queue Visualization**:
  - Add API endpoint for queue metrics (depth, processing times)
  - UI shows real-time queue status with graphs

### Estimated Duration

2–3 weeks (completed in early 2026, with ongoing non-blocking enhancements)

### Acceptance Criteria

See [acceptance/phase-1.md](./acceptance/phase-1.md)

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

## Phase 2.1: Progressive Planning ✅ Complete

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

- [x] Brain re-evaluates plan on task completion
- [x] Brain reads status reports to adjust task assignment
- [x] "Verify & polish" task classification
- [x] Plan document format specification
- [x] History tracking for completed tasks (via status_reports table)
- [x] Status report parsing and influence on tasking
- [x] Assign primary + watcher arms automatically when tasks are claimed
- [x] Consensus update API so arms can submit approvals/rejections and reach quorum
- [x] Discovery-based dependency reporting (`report_dependency` tool) to capture relationships surfaced during execution

### Dependency Graph Enhancements

- [x] Parse `### Dependencies` sections directly from plan phases
- [x] Auto-link plan dependencies to matching tasks and mark new work as blocked when prerequisites are unfinished
- [x] Spawn "Update plan dependencies" architect tasks when unresolved prerequisites are discovered

### Dependencies

- Phase 2 (context bundles)

### Estimated Duration

2 weeks

---

## Phase 2.2: Documentation Updates ✅ Complete (In Progress)

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

- [x] Documentation update task classification (completed - added to brain task determination)
- [x] Implement brain logic to trigger doc updates on phase completion (implemented in checkPhaseCompletionDocUpdate)
- [x] Add last_doc_update timestamp tracking to database (implemented via doc_updates table)
- [x] Create documentation update task template with file change review logic (implemented in buildDocUpdateDescription)
- [x] Implement "Future Work" note template for incomplete features (included in task descriptions)
- [x] Add periodic doc update scheduling (every N polls) (implemented in checkDocUpdateTrigger)
- [x] Test doc update triggers with sample tasks (comprehensive tests in doc-tracker.test.ts)

### Dependencies

- Phase 2: Task Classification & Context (completed - provides task classification and context bundle infrastructure)
- Phase 2.1: Progressive Planning (provides progressive task determination)

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

## Phase 2.4: Bug Tracking & Resolution (New)

**Goal**: Handle bug reports from arms and humans with priority escalation and resolution tracking.

### Problem

Arms may encounter errors or bugs during execution, or humans may report issues that block progress. These need to be tracked, prioritized, and resolved to prevent work stoppages.

### Bug Sources

- **Arm-reported bugs**: Errors encountered during task execution (compilation failures, test failures, runtime errors)
- **Human-reported bugs**: Issues sent via email or UI that affect system operation
- **System-detected bugs**: Failures in infrastructure (database errors, communication issues)

### Priority Rules

Brain applies priority based on impact:

| Priority | Criteria | Response |
|----------|----------|----------|
| **Critical** | Blocks all work, system down | Immediate pause, human alert |
| **High** | Blocks current task, affects multiple arms | Escalate to next available arm |
| **Medium** | Blocks current task but isolated | Reassign task to different arm |
| **Low** | Non-blocking, cosmetic | Log for later resolution |

### Deliverables

- [ ] Bug report message types (arm_reported, human_reported, system_detected)
- [ ] Bug tracking table with status, priority, assignee, blockers
- [ ] Brain priority rules for bug handling
- [ ] Escalation logic when bugs block tasks
- [ ] Bug resolution workflow (investigation → fix → verification)
- [ ] Human notifications for critical/blocking bugs
- [ ] API endpoints for bug management
- [ ] UI for bug tracking and status

### Brain Rules for Bug Handling

```
When bug reported:
  IF critical → pause all work, alert human immediately
  IF high → find alternative arm, escalate priority
  IF medium → reassign task, log for resolution
  IF low → continue work, track for later

During task assignment:
  IF task depends on unresolved bug → block task, notify human

When bug resolved:
  IF was blocking → resume blocked tasks
  Update task history with resolution details
```

### Dependencies

- Phase 2.1 (Progressive Planning - for blocking logic)
- Phase 2.5 (Status Reports - bug reports as status)

### Estimated Duration

1 week

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
- [ ] User message confirmation & tracking (processing fate, plan addition, unblocking)

### Dependencies

- Phase 2.1 (Progressive Planning)

### Estimated Duration

1 week
---

## New Tasks from Brain (Jan 2026)

The following tasks were created by the Brain but were not in the plan. They represent work in progress that needs to be completed.

### Priority Tasks

- [ ] **HIGH PRIORITY**: arms can access dev server logs and control restarting dev servers
  - Research existing solutions (MCP servers, etc.)
  - Implement log access capability
  - Implement server restart control
  - Coordinate through Brain for destructive operations

### Coordination Tasks

- [ ] Thrashing detection (lazy claims)
  - Detect when arms are fighting over files
  - Implement lazy claim release protocol
  - Add throttling to prevent rapid re-claims
  
- [ ] Handoff protocol between arms
  - Define protocol for graceful task handoff
  - Include context transfer mechanism
  - Handle edge cases (abandoned tasks, conflicts)

---

## Known Architectural Issues

**IMPORTANT:** The following issues were identified during comprehensive architectural review (January 2026) and should be addressed:

### Critical Issues

1. **SQLite Principle Violations**: 50+ JSON files found storing state that violates the core principle
   - Brain state (`.octopai/state/brain.json`) - coordinator status, poll intervals, active arms
   - Task management (`.octopai/state/tasks.json`) - task queue and status tracking
   - Tool discovery (`.octopai/state/toolbox.json`) - discovered tools from arms
   - Arm tracking (`.octopai/state/seen_arms.json`) - arm ID tracking
   - Message queuing (31+ files in `.octopai/queue/`) - persistent message system
   - Individual arm states (`.octopai/state/arms/`) - per-arm state persistence
   - Shared notes (`.octopai/state/notes/`) - inter-arm communication

2. **Data Consistency Risk**: Dual storage systems (SQLite + JSON files) create data inconsistency potential

### Code Quality Issues

3. **API Convention Violations**: 7 instances of direct error returns instead of `HttpError` middleware
   - `src/api/routes/agents.ts`: 6 violations (lines 45, 50, 64, 69, 75, 79)
   - `src/api/routes/activity.ts`: 1 violation (line 90)

4. **Type Safety Issues**: Extensive unsafe patterns found
   - 39+ instances of unsafe `JSON.parse()` without validation
   - 20+ instances of overused `unknown` types where specific interfaces needed
   - 38+ instances of `Record<string, unknown>` instead of proper interfaces
   - Unsafe type casting with `as unknown as` chains

5. **Code Duplication**: Massive duplication across codebase
   - 50+ instances of database connection duplication
   - 100+ instances of similar error handling patterns
   - 100+ instances of JSON operations duplication
   - Duplicate type definitions across multiple files (OctopaiConfig, ArmConfig, Arm interfaces)
   - Activity logging patterns repeated across files

---

## Phase 2.3: Technical Debt Resolution (New)

**Goal**: Address architectural issues identified in January 2026 review to improve code quality and data consistency.

### Priority 1: SQLite Migration (Critical)

Migrate all JSON-based state to SQLite to maintain single source of truth:

- [x] Migrate brain state from `.octopai/state/brain.json` to `brain_state` table
- [x] Migrate task queue from `.octopai/state/tasks.json` to `tasks` table
- [x] Migrate message queue from `.octopai/queue/` files to `messages` table
- [x] Migrate toolbox from `.octopai/state/toolbox.json` to `tools` table
- [x] Remove seenArmIds - derive from task assignments instead
- [x] Migrate shared notes from `.octopai/state/notes/` to `notes` table
- [ ] Remove JSON file fallbacks after migration verified (file fallbacks kept for safety during transition)

### Future Consideration: NATS JetStream Event Sourcing

Some "current state" data is better modeled as derived state from an event stream (event sourcing pattern). NATS JetStream provides:

- **Streams**: Append-only event logs with configurable retention (time, size, count)
- **Key-Value Store**: Built on streams, good for derived state snapshots
- **Replay**: Can rebuild state from event history

**Candidates for event sourcing (migrate after SQLite cleanup):**

| Current State | Event Stream | Derived Query |
|---------------|--------------|---------------|
| `seenArmIds` (has arm received tasks?) | `task_assigned` events | "Any task_assigned events for this arm?" |
| Arm heartbeats/last seen | `heartbeat` events | "Most recent heartbeat for arm X" |
| Task state transitions | `task_claimed`, `task_completed`, etc. | "Current status = last event type" |
| Message delivery status | `message_sent`, `message_acked` | "Was message X acknowledged?" |

**Benefits:**
- Full audit trail of state changes
- Current state is computed, not stored (no sync bugs)
- Time-series queries ("what was happening at time T?")
- Natural fit for distributed systems

**Implementation notes:**
- NATS JetStream already integrated for arm communication
- Start with task state transitions as first candidate
- Keep SQLite for complex queries, use JetStream for event log
- Current state can be cached in SQLite, rebuilt from stream on startup

**Migration Plan:** See [jetstream-migration-plan.md](./jetstream-migration-plan.md) for comprehensive implementation details, including question event formats for brain decision handling.

### Question Event Handling (New)

Arms can emit `question.asked` events when they need decisions that require human input. The brain must detect these events and either handle them autonomously or escalate to humans. See the JetStream migration plan for the complete event schema and handling requirements.

**Not candidates for event sourcing (keep in SQLite/files):**
- Maildir messages (standard format, interoperable)
- MCP configs (external tool requirement)
- Plan documents (human-editable, version controlled)
- Configuration (TOML, human-editable)

### Future Consideration: Task File References

Tasks should reference git-tracked files as dependencies and outputs. This creates durable artifacts that outlive any specific orchestration tool.

**File categories to track:**

| Directory | Purpose | Relation to Task |
|-----------|---------|------------------|
| `.project/acceptance/` | Acceptance criteria per phase | Input dependency |
| `.project/decisions/` | Architectural decisions (ADRs) | Input/output |
| `.project/tasks/` | Task definitions and context | Input dependency |
| Source files | Implementation artifacts | Output |

**Database schema addition:**

```sql
-- Task file references (links tasks to git-tracked files)
CREATE TABLE task_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('dependency', 'output', 'context')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  UNIQUE(task_id, file_path)
);

CREATE INDEX idx_task_files_task ON task_files(task_id);
CREATE INDEX idx_task_files_path ON task_files(file_path);
```

**Benefits:**
- **Tool-agnostic**: Any AI agent can read `.project/` files without Octopai
- **Git-tracked**: Decisions and acceptance criteria persist in version control
- **Queryable**: SQLite tracks which tasks read/wrote which files
- **Audit trail**: Know why a decision was made and which task created it

**Implementation notes:**
- Arms report file dependencies when claiming tasks
- Arms report output files when completing tasks
- Brain can verify outputs exist before marking task complete
- UI can show file graph for any task

### Future Consideration: Status Reports in Maildir

Status reports (currently `.project/status-*.md`) are communication artifacts between arms and humans. They should be stored in Maildir format:

**Current state (to migrate):**
- `.project/status-2026-01-16-*.md` files in project root
- Not queryable, not integrated with mail UI

**Target state:**
- Status reports written as Maildir messages to `~/.octopai/mail/brain/cur/`
- Headers: `X-Octopai-Type: status-report`, `X-Octopai-Task: <task-id>`
- Body: Markdown content (same as current files)
- Queryable via mail UI and API
- Human can reply to status reports

**Benefits:**
- Unified communication channel (all brain→human messages in one place)
- Status reports appear in Observatory mail UI
- Human can reply with feedback or corrections
- Consistent with Maildir-as-communication-channel philosophy

### Priority 2: Code Consolidation (High)

Create shared utilities to reduce duplication:

- [ ] Create `src/db/utils.ts` for database connection patterns
- [ ] Create `src/utils/json.ts` for safe JSON operations with Zod validation
- [ ] Create `src/utils/errors.ts` for standardized error handling
- [ ] Consolidate duplicate type definitions in `src/types/index.ts`
- [ ] Create `src/utils/activity.ts` for activity logging helpers

### Priority 3: API & Type Fixes (Medium)

Fix API convention violations and type safety:

- [ ] Fix `src/api/routes/agents.ts` to use `HttpError` middleware (6 violations)
- [ ] Fix `src/api/routes/activity.ts` to use `HttpError` middleware (1 violation)
- [ ] Add Zod schema validation for all `JSON.parse()` operations
- [ ] Replace `Record<string, unknown>` with specific interfaces
- [ ] Remove unsafe `as unknown as` type casting chains

### Deliverables

- [ ] All state in SQLite (no JSON files for persistent state)
- [ ] Shared utility modules for common patterns
- [ ] All API routes using `HttpError` middleware
- [ ] Type-safe JSON parsing throughout codebase
- [ ] Reduced code duplication by 50%+

### Dependencies

- None (can start immediately)

### Estimated Duration

2 weeks

### Acceptance Criteria

- [ ] `find .octopai -name "*.json" -path "*state*"` returns no results
- [ ] No direct `c.json({ error: ... })` in API routes
- [ ] All `JSON.parse()` calls wrapped with schema validation
- [ ] No duplicate type definitions across files

---



## Phase 2.6: Agentic Brain (New)

**Goal**: Transform Brain from polling loop with hardcoded logic into an agentic AI system.

### Agentic Brain Design

See [brain-agent-plan.md](./brain-agent-plan.md) for full implementation details.

### Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                    Agentic Brain                                           │
├──────────────────────────────────────────────────────────────────────────────┤
│  ┌───────────────┐    ┌───────────────────────┐    ┌─────────────────────┐ │
│  │ Human Input   │──▶ │  Brain Agent          │──▶ │ Arm Actions         │ │
│  │ (Email/       │    │  (LLM + Tools)        │    │ (via MCP/ NATS)    │ │
│  │  Tasks)       │    │                       │    │                     │ │
│  └───────────────┘    └───────────────────────┘    └─────────────────────┘ │
│                           │                                      │         │
│                           ▼                                      │         │
│                  ┌───────────────────────┐                       │         │
│                  │  Tools (SQLite,      │                       │         │
│                  │   File System,       │                       │         │
│                  │   MCP, NATS)         │                       │         │
│                  └───────────────────────┘                       │         │
└──────────────────────────────────────────────────────────────────────────────┘
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
- [ ] Control loop for system alignment with human approval gates
- [ ] Optimize polling frequency and add arm "busy" status to prevent interruptions
- [ ] Vector database integration for searchable arm context history

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

## Phase 2.7: Context Compression (New)

**Goal**: Configure context size limits and automatic task context re-injection after compression to maintain agent focus on brain's directives.

### Problem Statement

OpenCode and similar agent harnesses have built-in context compression that runs automatically when context fills up (typically around 80% of maximum). When compression runs:

1. The most recent messages (often including task instructions) may be summarized or dropped
2. Agents lose visibility into their original objectives
3. Quality degrades as the agent loses track of what it's supposed to do

### Solution: Task Context Re-injection

After any context compression event, the agent should receive:

1. **Reinforced task description** - "You are working on: [task subject]"
2. **Work-in-progress note** - "This is work in progress that you've already started"
3. **Relevant context bundle** - Key discoveries, completed tasks, plan excerpts
4. **Priority indicator** - Critical/High/Normal

### Configuration Options

| Config Key | Description | Default |
|------------|-------------|---------|
| `context_compression_threshold` | % of max context that triggers compaction | 80 |
| `context_hard_limit` | Hard limit % - compaction MUST run if exceeded | 95 |
| `context_reinforce_after_compression` | Enable task re-injection | true |
| `context_wip_prefix` | Text before task description after compression | "This is work in progress that you've already started:" |

### Implementation

#### OpenCode Configuration

When running arms with OpenCode harness, the configuration includes:

```json
{
  "contextCompression": {
    "autoCompact": true,
    "threshold": 80,
    "hardLimit": 95,
    "reinforceAfterCompression": true,
    "wipPrefix": "This is work in progress that you've already started:"
  }
}
```

#### Brain Output for Agent Prompt

The `prompt:context` command already generates this output format:

```
=== OCTOPAI TASK ASSIGNMENT ===
...

## IMPORTANT: Context Compression Notice

This message has been re-injected after context compression.
You were in the middle of working on this task.

Your Task: [task subject]
Priority: [priority]
Classification: [classification]

[Original task description]

## What You've Done So Far
[Completed tasks summary]

## Open Discoveries
[Any discoveries relevant to this task]

## Next Steps
[Guidance based on where you likely left off]

Good luck continuing your work!
===
```

#### For OpenCode MCP Tool

Add a new MCP tool for arms to signal context compression:

```typescript
server.registerTool(
  "report_context_compression",
  {
    description: "Report that context compression occurred",
    inputSchema: {
      compressed_at: z.string().datetime(),
      original_tokens: z.number(),
      compressed_tokens: z.number(),
      retention_summary: z.string(),
    },
  },
  async ({ compressed_at, original_tokens, compressed_tokens, retention_summary }) => {
    // Brain logs this and may re-inject context if configured
    await sendToBrain({
      from: ARM_ID,
      to: "brain",
      type: "context_compression",
      payload: { compressed_at, original_tokens, compressed_tokens, retention_summary },
    });
  }
);
```

### Deliverables

- [ ] Context compression configuration options in brain config
- [ ] Prompt template for re-injection after compression
- [ ] MCP tool for arms to report compression events
- [ ] Brain logic to detect compression and optionally re-inject
- [ ] Documentation for harness-specific configuration
- [ ] Tests for context compression scenarios
- [ ] Tool selection/filtering based on task specialization to prevent context overload
- [ ] Vector database for arm conversation history with configurable retention

### Dependencies

- Phase 2 (Task Classification)
- Phase 2.6 (Agentic Brain - for tool integration)

### Estimated Duration

1 week

---

## Regular Refactoring Cycle

**Goal**: Maintain file sizes small enough for LLM context windows through periodic refactoring.

### Problem Statement

Large files (>400 lines) are difficult for LLMs to process effectively:
- They consume significant context budget
- Arms may not be able to load entire files into context
- Complex files lead to more errors and incomplete understanding

### Trigger Conditions

Brain creates a refactoring task when:

1. **Task completion threshold**: Every 5 completed tasks
2. **File size detected**: Any file >400 lines found during work
3. **Human request**: Human explicitly requests refactoring

### Refactoring Task Classification

| Classification | Purpose | Output |
|----------------|---------|--------|
| **refactoring** | Split large files | Smaller, focused modules |

### Prerequisites (CRITICAL)

Before any refactoring task begins, the arm MUST verify:

1. **Clean git state**: `git status` shows no uncommitted changes to target files
2. **Files committed**: All files to be refactored are checked in
3. **No active claims**: No other arm has claimed the target files

If prerequisites are not met:
- Arm reports blocker to Brain
- Brain either waits or reassigns task
- NO refactoring proceeds with uncommitted changes

### File Size Rules

| Threshold | Action |
|-----------|--------|
| **>400 lines** | Flag for refactoring |
| **>600 lines** | High priority refactoring |
| **>800 lines** | Critical - block new work on file until refactored |

### Brain Implementation

```typescript
// Track task completion count
let completedTaskCount = 0;

async function onTaskCompleted(task: Task) {
  completedTaskCount++;
  
  // Check for refactoring cycle every 5 tasks
  if (completedTaskCount % 5 === 0) {
    const largeFiles = await findLargeFiles(400);
    if (largeFiles.length > 0) {
      await createRefactoringTask(largeFiles);
    }
  }
}

async function findLargeFiles(threshold: number): Promise<string[]> {
  // Use wc -l or similar to find files > threshold lines
  // Exclude: node_modules, .git, build artifacts
}

async function createRefactoringTask(files: string[]) {
  await db.run(`
    INSERT INTO tasks (id, subject, description, classification, priority)
    VALUES (?, ?, ?, 'refactoring', ?)
  `, [
    generateTaskId(),
    `Refactor large files (${files.length} files)`,
    buildRefactoringDescription(files),
    files.some(f => getLineCount(f) > 600) ? 'high' : 'medium'
  ]);
}
```

### Refactoring Task Description Template

```markdown
## Refactoring Task

### Prerequisites (VERIFY FIRST)
- [ ] Run `git status` - confirm target files have no uncommitted changes
- [ ] Confirm files are checked in before making changes
- [ ] Check no other arms have active claims on these files

### Files to Refactor

| File | Lines | Priority |
|------|-------|----------|
{{#each files}}
| `{{path}}` | {{lines}} | {{priority}} |
{{/each}}

### Guidelines

1. **Extract focused modules**: Each file should do one thing well
2. **Preserve exports**: Don't break existing imports
3. **Add barrel files**: Use index.ts for clean re-exports
4. **Test after split**: Run `bun run typecheck` and `bun test`
5. **Commit incrementally**: One logical change per commit

### Example Splits

- Extract types to `types.ts`
- Extract utilities to `utils.ts`
- Extract constants to `constants.ts`
- Split by feature/domain into subdirectories
```

### Deliverables

- [ ] Brain tracks completed task count
- [ ] `findLargeFiles()` utility function
- [ ] Refactoring task classification in brain
- [ ] Prerequisite verification in refactoring task template
- [ ] File size threshold configuration (default 400 lines)
- [ ] High priority escalation for files >600 lines
- [ ] Integration with claims system to prevent conflicts

### Dependencies

- Phase 2.1 (Progressive Planning - for task creation)
- Claims system (for conflict prevention)

### Estimated Duration

1 week

---

## Phase 3: Governance

**Goal**: Arms debate and reach consensus on plans and changes, using proposals, arguments, and signals rather than human-maintained MR workflows.

### Deliverables

- [ ] Proposal system (deploy, claim, refactor, dependency, breaking_change, creative_override)
- [ ] Arguments and signals tied to tasks and classifications (no fixed arm roles)
- [ ] Consensus calculation that uses reputation and task/subject relevance (not static domains)
- [ ] Reputation tracking and enforcement hooks in the Brain
- [ ] Creative override flow with clear rollback plans
- [ ] Emergency stop (andon cord) signals and handling
- [ ] Transition from MR templates to **task configuration templates**, where:
  - Task classification (architect, development, qa, documentation, etc.) selects a configuration template.
  - Templates define defaults for tools, context bundles, safety rules, and governance expectations.
  - Any remaining MR-style templates are removed or updated to reference task configuration templates instead of fixed arm/MR roles.
- [ ] Brain can update plans directly; arm-initiated changes require proposals for consensus

### Estimated Duration

2–3 weeks

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
- [ ] Generate octopus avatars for arms with reuse logic and color/personality traits
- [ ] Brain mascot with personality and animation

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

2–3 weeks

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

## Changelog

| Date | Change |
|------|--------|
| 2026-01-23 | Added Cost/Money Usage Line Graph to Arm Activity Visualization - shows cumulative spend over time using OpenCode API pricing data |
| 2026-01-23 | Added Arm Activity & Efficiency Visualization: 30-min activity bar graph (file writes, thinking, tool calls, tasks) and context length line graph with full/compressed views |
| 2026-01-23 | Added Regular Refactoring Cycle: periodic refactoring every 5 tasks for files >400 lines, with git clean state prerequisites |
| 2026-01-17 | Added Phase 2.4: Bug Tracking & Resolution with priority escalation rules for arm/human-reported bugs |
| 2026-01-17 | Added user feedback enhancements: model recommendations & budget tracking, vector DB for arm history, context compression improvements, status report tracking, governance clarifications, and garden visualization avatars/personality |
| 2026-01-16 | Phase 1 enhancements updated: added Mail/sent messages, Task List (past/current/next), Arm Viewer page (clickable arms, history, color-coded), and Arm Spawning from web UI (generated names, regenerate button) |
| 2026-01-16 | Phase 3 governance updated to use proposals/arguments/signals without MR-specific workflows; plan now calls for migration from MR templates to task configuration templates |
| 2026-01-16 | Phase 1 marked complete; Project Plan Viewer treated as non-blocking enhancement; IMAP/SMTP email gateway deferred to later phases |
| 2026-01-16 | Phase 2.2: Documentation update tasks (keep feature docs aligned with code) |
| 2026-01-16 | Phase 6 focused on opencode-api only; PTY harnesses deferred to Phase 7+ |
| 2026-01-15 | Updated philosophy: Arms are not specialized (ADR-009) |
| 2026-01-15 | Added requirements.md with task classification details |
| 2026-01-15 | Added PM arm documentation and .project structure |
| 2026-01-15 | Added agent harnesses documentation |
| 2026-01-15 | Comprehensive docs update (governance, security, deployment, etc.) |
| 2024-01-10 | Initial project setup, Phase 0 complete |
