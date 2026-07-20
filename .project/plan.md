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

## Communication Modes

To keep humans, the brain, and arms aligned, standardize three primary communication paths:

1. **CLI ↔ API Server** – The `octopai` CLI becomes a thin client that authenticates against the Hono REST API for every management action (spawn, list, kill, status). Local-only code paths are legacy fallbacks.
2. **Web UI ↔ API Server** – The React/Vite Observatory consumes the same authenticated REST and WebSocket endpoints, mirroring CLI capabilities with dashboards and controls.
3. **Mail Client ↔ Email Server** – A future IMAP/SMTP gateway will expose the Maildir inbox/outbox so humans can use any email client. Until then, humans interact via Maildir-backed tools and the Observatory’s Mail UI.

---

## Active Refactor: Brain/API Boundary

We are executing a boundary cleanup where:

- Brain becomes an API-first orchestrator with no direct NATS/JetStream/harness calls.
- API server becomes the typed/authenticated integration boundary.
- ArmAgent owns harness/OpenCode traffic and publishes arm events/messages through NATS.

Execution details and phased rollout:

- `.project/plans/brain-api-boundary-execution-plan.md`
- `docs/architecture/brain-api-boundary.md`

---

## Completed Foundation

### Phase 0: Core Infrastructure

**Goal**: Basic brain/arm lifecycle and communication.

Phase 0 is complete. Its implemented scope includes:

- Brain polling loop (`src/brain/brain.ts`)
- Maildir reader/writer (`src/mail/maildir.ts`)
- MCP server with tools (`src/mcp/server.ts`)
- Arm spawner with headless mode
- CLI commands (`src/cli/index.ts`)
- Type definitions
- NATS integration for distributed arms

Acceptance criteria are documented in [acceptance/phase-0.md](./acceptance/phase-0.md).

### Phase 1: Observatory Foundation

**Goal**: Web UI and API for human observation and control.

Phase 1 is complete. Its implemented scope includes:

- Hono API server with REST endpoints
- SQLite database with schema
- WebSocket for real-time updates
- React shell with routing
- Basic dashboard view
- Arm list and status view
- CLI proxy layer through API
- Activity logging

Key decisions:

- API authentication via API key (decisions/003)
- shadcn/ui components (decisions/004)
- Bun runtime (decisions/001)

The following Observatory enhancements remain non-blocking and do not retroactively prevent Phase 1 from being considered complete.

---

## Phase 1 Enhancements: Observatory

### Deliverables

- [ ] **Add the Project Plan Viewer.** Provide a file/folder tree of `.project/` and key documents on the left, including `README.md`, `plan.md`, `requirements.md`, `decisions/`, `acceptance/`, and `plans/`. Render the selected Markdown file on the right, allow plan documents to be edited in the browser, show a visible “Last Updated” timestamp derived from git commit metadata or filesystem mtime, and clearly indicate recently changed files.
- [ ] **Enhance the Mail and Message Interface.** Show sent messages from users to the Brain or arms in addition to the current inbox-only view. Provide threaded conversations that include arm responses.
- [ ] **Enhance the Task List.** Display past completed tasks, the current in-progress task, and the next scheduled or upcoming task. Provide a timeline view with recent activity rather than limiting the interface to a CRUD backlog.
- [ ] **Add the Arm Viewer Page.** Make every arm clickable from anywhere in the UI, show live arm status and activity, and display the history of arms that have closed or finished in the project. For dead arms, retain only the last 100 activity items, and assign each arm a unique randomly generated color.
- [ ] **Add the Arm Activity and Efficiency Visualization.** Provide a minute-by-minute activity bar graph over a 30-minute window, using stacked or grouped bars with events per minute and leaving gaps for inactive minutes. Distinguish file writes in blue, thinking/reasoning in yellow, tool calls in green, and completed tasks in prominent purple; allow tasks to pile up vertically within a minute bar so activity and efficiency are visible at a glance.
- [ ] **Add context usage visualization to arm activity.** Place a higher-resolution context-length line graph below the activity graph, using samples such as every 10–15 seconds. Show context token usage over time, indicate the 80% compression threshold, and shade the warning zone near context limits.
- [ ] **Add cost visualization to arm activity.** Place a cost or money-usage line graph below the context graph and show a running total of spend over time. Optionally stack input, output, and cache costs, show a dollars-per-hour cost-rate indicator based on recent activity, and show a budget threshold line when configured.
- [ ] **Source arm cost data from OpenCode.** Use `GET /provider` and `Provider.models[].cost` for model pricing, `AssistantMessage.cost` for per-message cost, and `AssistantMessage.tokens` for input, output, reasoning, and cache read/write usage. The resulting views must help users identify expensive and inexpensive arms, cost spikes during complex reasoning, and the return on investment of different model choices.
- [ ] **Provide responsive graph views and data feeds.** Show complete 30-minute graphs and legends on the Arms list page, and a compressed sparkline-style view on the Arm Viewer page. Generate graph data from the SSE event stream, poll an aggregated metrics endpoint from the frontend, and continue delivering live list updates through WebSocket events.
- [ ] **Add arm metrics endpoints.** Implement `GET /api/arms/:id/metrics`, `GET /api/arms/:id/context-history`, and `GET /api/arms/:id/cost-history`. The endpoints must provide the data required by the full graph, sparkline, context, and cost views.
- [ ] **Add Arm Spawning from the Web UI.** Provide a browser form for spawning arms, auto-populate the name input with generated names, allow names to be regenerated, and provide provider and model dropdowns with cost estimates and budget warnings. Show real-time feedback while spawning.
- [ ] **Add Model Recommendations and Budget Tracking.** Show cost estimates per model, such as GPT-4.1 versus Claude-3.5, based on expected token usage. Warn users about high-cost models when they spawn arms.
- [ ] **Add Message Queue Visualization.** Add an API endpoint that reports queue depth and processing times, then display real-time queue status with graphs.

---

## Phase 1.2: Collaborative Planning and Task Refinement

**Goal**: Enable humans and agents to collaboratively refine plan items into actionable tasks using a high-density interactive UI.

### Deliverables

- [ ] **Add a high-performance multi-tabbed grid view.** Support sorting and filtering large numbers of plan items, tasks, and discoveries. The grid must remain usable for the scale covered by the acceptance criteria.
- [ ] **Add progress visualization.** Show real-time progress tracking, completion status, and sub-task breakdown for plan items and tasks.
- [ ] **Add collaborative discussion UI.** Provide an integrated chat interface for discussing implementation and design for a specific item with an “Architect” agent.
- [ ] **Add the Task Preparation Agent.** Allow the agent to turn a discussion into a detailed task definition containing context, requirements, and acceptance criteria.
- [ ] **Add the Task Handoff Mechanism.** Queue prepared tasks for execution by other arms and bridge the planning and execution workflows.

### Acceptance Criteria

- [ ] Users can sort and filter 100+ items in the grid view without performance degradation.
- [ ] Discussion history is preserved per item.
- [ ] The agent can generate a valid task definition from a discussion.
- [ ] Prepared tasks appear in the “Next Task” preview when ready.
- [ ] Foundational criteria remain covered by [acceptance/phase-1.md](./acceptance/phase-1.md).

---

## Phase 2: Task Classification and Context

**Goal**: Implement task classifications (architect, development, QA, documentation) with context bundles for arms.

### Task Classifications

| Classification | Purpose | Output |
|---|---|---|
| Architect | Requirements → Plans | Plans, tasks |
| Development | Tasks → Code | Code, discoveries |
| QA | Code → Tests | Tests, doc verification |
| Documentation | Code → Feature Docs | Updated feature docs, “future work” notes |

The existing context-bundle, discovery, assignment, and discovery API infrastructure is in place. Remaining work is:

### Deliverables

- [ ] **Implement classification-specific prompt templates.** Create prompts for architect, development, QA, documentation, and the other classifications required by the system. Each template must describe the expected work and output without assigning a permanent specialization to an arm.
- [ ] **Ensure arms can execute every task classification.** Classification must determine behavior and context rather than arm identity. Verify that any eligible arm can receive and complete each classification.

### Dependencies

- Phase 0 (Brain, MCP, CLI)

### Acceptance Criteria

- [ ] Arms can execute any task classification.
- [x] Arms receive discoveries when tasks are assigned.
- [x] Discoveries are stored in SQLite with FTS5 search.
- [x] The API provides discovery listing and search.

---

## Phase 2.1: Progressive Planning

**Goal**: Brain dynamically determines the next task based on the plan, history, and status reports.

> **Planning note (2026-05-26):** Task determination is driven by `.project/plan.md` and the sub-plan files explicitly referenced from it. Other plan fragments, such as `.project/plans/git-worktree-isolation.md`, should only be consulted when the canonical plan links to them. The Brain must not treat standalone plan files as authoritative without that linkage.

See [progressive-planning.md](./progressive-planning.md) for the full design.

### Inputs to Task Assignment

| Source | Purpose |
|---|---|
| Plan documents | What needs to be done |
| Completed tasks | What is already done |
| Status reports | What issues were found |
| Discoveries | What has been discovered |
| Open tasks | What is in progress |

### Decision Logic

For each plan bullet point:

```txt
IF completed AND no issues → skip
IF completed BUT has issues → assign "verify & polish"
IF incomplete AND ready → assign development task
IF blocked → notify human
```

The branch-centered task lifecycle defined later in this plan supersedes the generation of separate review or polish child tasks. “Verify & polish” work must be recorded as a pass on the original task where that lifecycle applies.

### Deliverables

The following progressive-planning infrastructure is complete:

- Brain reevaluates the plan on task completion.
- Brain reads status reports to adjust task assignment.
- “Verify & polish” task classification exists.
- Plan document format is specified.
- Completed-task history is tracked through the `status_reports` table.
- Status reports are parsed and influence tasking.
- Primary and watcher arms are assigned automatically when tasks are claimed.
- Consensus updates can be submitted through the API, allowing arms to submit approvals or rejections and reach quorum.
- The `report_dependency` tool captures discovery-based relationships surfaced during execution.
- `### Dependencies` sections are parsed directly from plan phases.
- Plan dependencies are linked to matching tasks.
- New work is marked blocked when prerequisites are unfinished.
- Architect tasks can be spawned to update plan dependencies when unresolved prerequisites are discovered.

### Dependencies

- Phase 2 (context bundles)

---

## Phase 2.2: Documentation Updates

**Goal**: Brain creates documentation update tasks to keep feature documentation aligned with code.

This phase’s documented implementation is complete. The behavior remains part of the plan and must continue to observe the following scope.

### Purpose

As code is written, feature and capability documentation can become stale. The Brain periodically assigns tasks to:

- Review code changes since the last documentation update.
- Ensure feature documentation matches the actual implementation.
- Add “future work” notes for incomplete features.

### Scope

| Type | Update? | Notes |
|---|---:|---|
| Feature documentation | ✅ Yes | Must match what code does |
| API documentation | ✅ Yes | Endpoints, parameters, behavior |
| Capability documentation | ✅ Yes | What the system can do |
| Conceptual documentation | ❌ No | Describes ideal state, not implementation |
| Architecture decisions | ❌ No | Describes intent, not current state |

### Trigger Conditions

The Brain creates a documentation update task when:

1. A phase is near completion.
2. A configurable number of files changed since the last documentation update; the default is 10.
3. A human requests a documentation review.
4. A configurable periodic interval is reached.

### Documentation Task Behavior

A documentation task is classified as **documentation**:

- The arm reviews changed files.
- The arm compares them with existing feature documentation.
- The arm updates documentation to match implementation.
- The arm adds “Future Work” notes for incomplete features.

Conceptual and architecture documentation must not be updated as part of this task.

### Future Work Templates

For a feature that exists in documentation but not in code:

```markdown
## Feature X

**Status**: Planned for Phase N
**Details**: [description from plan]

_Note: This feature is planned but not yet implemented. See [plan link] for details._
```

For a partially implemented feature:

```markdown
## Feature X

**Status**: Partial Implementation
**Implemented**: [what's done]
**Pending**: [what's left for future phase]
```

### Documentation Task Context

When assigning a documentation task, the Brain provides:

1. Files changed since the last documentation update, from git or file tracking.
2. Existing feature documentation that may need updating.
3. The plan document for “future work” notes.
4. The scope: feature and capability documentation only, not conceptual documentation.

Example:

```txt
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

## Phase 2.3: Technical Debt Resolution

**Goal**: Address architectural issues identified in the January 2026 review to improve code quality and data consistency.

### Known Architectural Issues

#### SQLite Principle Violations

More than 50 JSON files were found storing state, violating the single-source-of-truth principle:

- Brain state: `.octopai/state/brain.json`
- Task management: `.octopai/state/tasks.json`
- Tool discovery: `.octopai/state/toolbox.json`
- Arm tracking: `.octopai/state/seen_arms.json`
- Message queuing: 31+ files in `.octopai/queue/`
- Individual arm states: `.octopai/state/arms/`
- Shared notes: `.octopai/state/notes/`

Dual SQLite and JSON storage creates a risk of data inconsistency.

The following migrations are complete:

- Brain state was migrated to the `brain_state` table.
- The task queue was migrated to the `tasks` table.
- The message queue was migrated to the `messages` table.
- Toolbox state was migrated to the `tools` table.
- `seenArmIds` was removed as a stored state value and is derived from task assignments.
- Shared notes were migrated to the `notes` table.

### Deliverables

- [ ] **Remove JSON file fallbacks after migration verification.** Confirm that the SQLite migrations are complete and that the fallback files are no longer needed before deleting the JSON persistence paths. Keep the fallbacks during the safety transition and do not remove them before verification.
- [ ] **Create shared database utilities.** Add `src/db/utils.ts` to consolidate duplicated database connection and access patterns. Update callers so common connection behavior is implemented in one shared module.
- [ ] **Create safe JSON utilities.** Add `src/utils/json.ts` for JSON operations and use Zod validation for parsed values. Replace unsafe direct parsing throughout the codebase.
- [ ] **Create standardized error utilities.** Add `src/utils/errors.ts` for standardized error handling and middleware integration. Use it to replace duplicated error-handling patterns.
- [ ] **Consolidate duplicate type definitions.** Move shared `OctopaiConfig`, `ArmConfig`, and arm interfaces into `src/types/index.ts`, then remove duplicate definitions while preserving imports and behavior.
- [ ] **Create activity-logging helpers.** Add `src/utils/activity.ts` to consolidate repeated activity-logging patterns across files.
- [ ] **Fix API error handling.** Update all six violations in `src/api/routes/agents.ts` at lines 45, 50, 64, 69, 75, and 79, and the violation in `src/api/routes/activity.ts` at line 90, so routes use `HttpError` middleware rather than direct error responses.
- [ ] **Validate every JSON parse.** Add Zod schema validation around all `JSON.parse()` operations and ensure parsed values have specific, checked types.
- [ ] **Replace overly broad types.** Replace `Record<string, unknown>` with specific interfaces where the data shape is known, reduce inappropriate uses of `unknown`, and remove unsafe `as unknown as` casting chains.
- [ ] **Reduce duplicated implementation patterns.** Consolidate the 50+ duplicated database connection patterns, 100+ duplicated error-handling patterns, and 100+ duplicated JSON-operation patterns through the shared utilities. The target is at least a 50% reduction in code duplication.
- [ ] **Verify the SQLite single-source-of-truth result.** Ensure all persistent state is in SQLite and no JSON files are used for persistent state. Confirm the acceptance checks after migration and fallback removal.

### Remaining Migration Work

File fallbacks are currently retained for safety during transition and must be removed only after migration verification.

### Dependencies

- None; work can start immediately.

### Acceptance Criteria

- [ ] `find .octopai -name "*.json" -path "*state*"` returns no results.
- [ ] No direct `c.json({ error: ... })` calls remain in API routes.
- [ ] Every `JSON.parse()` call is wrapped with schema validation.
- [ ] No duplicate type definitions remain across files.
- [ ] Shared utility modules exist for common patterns.
- [ ] All API routes use `HttpError` middleware.
- [ ] Code duplication is reduced by 50% or more.

---

## Phase 2.4: Status Reports

**Goal**: Formalize status reporting from arms to humans through the Brain.

### Why This Is Next

Status reports are the foundation for human oversight and enable:

- Bug tracking, since bugs are a type of status report.
- Agentic Brain decisions, since the Brain needs status to determine next tasks.
- Human visibility into arm progress.

### Status Report Flow

```txt
Arm → Status Report → Brain → Aggregates → Human (email)
                       ↓
              Updates task history
              Influences next task
```

### Deliverables

- [ ] **Define the status report message type.** Specify the message fields needed to identify the reporting arm, task, status, findings, and supporting information. The type must support the later bug-reporting and task-determination flows.
- [ ] **Implement status report parsing in the Brain.** Parse incoming reports, validate their structure, and store the information needed for task history and later aggregation.
- [ ] **Aggregate and route reports to humans.** Have the Brain combine relevant arm reports and deliver them to humans through the established communication path, including email where appropriate.
- [ ] **Make status influence task determination.** Feed parsed status reports into progressive planning so issues, blockers, and completion information affect the next assignment.
- [ ] **Add a status dashboard in the API.** Expose status-report information through API endpoints so the Observatory can display arm progress and issues.
- [ ] **Add user-message confirmation and tracking.** Track the processing fate of each user message, whether it was added to the plan, and whether it unblocked work.

### Dependencies

- Phase 2.1 (Progressive Planning)

---

## Phase 2.5: Bug Tracking and Resolution

**Goal**: Handle bug reports from arms and humans with priority escalation and resolution tracking.

### Problem

Arms may encounter errors or bugs during task execution, including compilation failures, test failures, and runtime errors. Humans may report issues that block progress. These issues must be tracked, prioritized, and resolved to prevent work stoppages.

### Bug Sources

- **Arm-reported bugs**: Errors encountered during task execution.
- **Human-reported bugs**: Issues sent by email or UI that affect system operation.
- **System-detected bugs**: Infrastructure failures, including database and communication issues.

### Priority Rules

| Priority | Criteria | Response |
|---|---|---|
| **Critical** | Blocks all work; system is down | Immediate pause and human alert |
| **High** | Blocks the current task or affects multiple arms | Escalate to the next available arm |
| **Medium** | Blocks the current task but is isolated | Reassign the task to a different arm |
| **Low** | Non-blocking or cosmetic | Log for later resolution |

### Deliverables

- [ ] **Define bug report message types.** Support `arm_reported`, `human_reported`, and `system_detected` sources, and retain the information needed for priority, assignment, blockers, and resolution.
- [ ] **Add the bug-tracking table.** Store bug status, priority, assignee, and blockers so issues remain queryable throughout investigation, fixing, and verification.
- [ ] **Implement Brain priority rules.** Apply the critical, high, medium, and low responses defined below when a bug is reported.
- [ ] **Implement escalation for blocked tasks.** Escalate high-priority work to the next available arm, reassign isolated medium-priority work, and prevent dependent tasks from running while an unresolved blocking bug remains.
- [ ] **Implement the bug-resolution workflow.** Track the sequence investigation → fix → verification, including the evidence and outcome for each stage.
- [ ] **Notify humans about critical and blocking bugs.** Critical failures must pause all work and alert a human immediately; other blocking bugs must be routed according to their priority.
- [ ] **Add API endpoints for bug management.** Expose bug creation, status, priority, assignment, blockers, and resolution information to clients.
- [ ] **Add UI for bug tracking and status.** Allow humans to inspect and follow bugs, their priority, current assignee, blockers, and resolution state.

### Brain Rules for Bug Handling

```txt
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
- Phase 2.4 (Status Reports - bug reports as status)

---

## Phase 2.6: Agentic Brain

**Goal**: Transform Brain from a polling loop with hardcoded logic into an agentic AI system.

See [brain-agent-plan.md](./brain-agent-plan.md) for full implementation details.

### Architecture

```txt
┌──────────────────────────────────────────────────────────────────────────────┐
│                    Agentic Brain                                             │
├──────────────────────────────────────────────────────────────────────────────┤
│  ┌───────────────┐    ┌───────────────────────┐    ┌─────────────────────┐   │
│  │ Human Input   │──▶ │  Brain Agent          │──▶ │ Arm Actions         │   │
│  │ (Email/       │    │  (LLM + Tools)        │    │ (via MCP/ NATS)    │   │
│  │  Tasks)       │    │                       │    │                     │   │
│  └───────────────┘    └───────────────────────┘    └─────────────────────┘   │
│                           │                                      │            │
│                           ▼                                      │            │
│                  ┌───────────────────────┐                       │            │
│                  │ Tools (SQLite,        │                       │            │
│                  │ File System, MCP,     │                       │            │
│                  │ NATS)                 │                       │            │
│                  └───────────────────────┘                       │            │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Framework

Use LangChain.js with:

- `createAgent` for the agent pattern.
- Tool calling with Zod schema validation.
- Memory/checkpointer support for conversation state.
- GPT-4.1 for reasoning.
- GPT-4.1 Codex for code tasks.

### Brain Agent Tools

| Tool | Purpose |
|---|---|
| `readPlan` | Read plan documents |
| `getTaskHistory` | Query completed and in-progress tasks |
| `getStatusReports` | Parse arm status reports |
| `getDiscoveries` | Query discoveries through FTS5 |
| `determineNextTask` | Perform core progressive planning |
| `assignTask` | Send a task to an arm |
| `storeDiscovery` | Save a discovery to SQLite |
| `sendToHuman` | Write to Maildir |
| `getArmStatus` | Check arm health and detect stuck loops |

### Deliverables

- [ ] **Integrate LangChain.js.** Configure the project to use `createAgent`, Zod-validated tool calling, memory/checkpoint support, GPT-4.1 for reasoning, and GPT-4.1 Codex for code tasks.
- [ ] **Implement the `BrainAgent` class.** Create the agent under the planned Brain agent structure and expose the nine tools listed above through one agent implementation.
- [ ] **Add the Brain agent system prompt.** Define how the agent reads project state, reasons about tasks, respects human approval gates, and communicates decisions.
- [ ] **Implement all nine Brain agent tools.** Provide validated implementations for `readPlan`, `getTaskHistory`, `getStatusReports`, `getDiscoveries`, `determineNextTask`, `assignTask`, `storeDiscovery`, `sendToHuman`, and `getArmStatus`.
- [ ] **Add memory and checkpoint support.** Persist conversation state so the Brain can resume its reasoning context across polling cycles and failures.
- [ ] **Retain fallback logic.** If the LLM or agent framework is unavailable or errors, fall back to the existing deterministic logic without losing task or state updates.
- [ ] **Add the system-alignment control loop.** Let the Brain compare the project state with the plan and take corrective actions, while enforcing human approval gates where required.
- [ ] **Optimize polling and busy-arm handling.** Adjust polling frequency and add arm `busy` status so active arms are not interrupted by new work.
- [ ] **Add vector search for arm context history.** Store searchable arm conversation history so the Brain can retrieve relevant prior context during task decisions.

### Migration Strategy

1. Create `src/brain/agent/`.
2. Implement the agent and tools.
3. Replace functions one at a time:
   - `determineNextTask()` → use the agent.
   - `handleDiscovery()` → use the agent.
   - `handleHumanMessage()` → use the agent.
4. Keep the polling loop as the orchestrator.

### Dependencies

- Phase 2 (Task Classification)
- Phase 2.1 (Progressive Planning)
- Phase 2.5 (Status Reports)

### Acceptance Criteria

- [ ] The agent makes reasonable task determinations.
- [ ] Discoveries are properly stored and surfaced.
- [ ] Human messages receive appropriate responses.
- [ ] Stuck arms are detected and handled.
- [ ] Fallback logic works when the LLM is unavailable.

---

## Phase 2.7: Context Compression

**Goal**: Configure context-size limits and automatically re-inject task context after compression so agents remain focused on Brain directives.

### Problem

OpenCode and similar harnesses automatically compress context when it fills, typically around 80% of maximum. During compression:

1. Recent messages, including task instructions, may be summarized or dropped.
2. Agents lose visibility into their original objectives.
3. Quality degrades as the agent loses track of its work.

### Solution

After context compression, the agent receives:

1. A reinforced task description: “You are working on: [task subject]”.
2. A work-in-progress note: “This is work in progress that you’ve already started”.
3. A relevant context bundle containing discoveries, completed tasks, and plan excerpts.
4. A priority indicator: Critical, High, or Normal.

### Configuration

| Config key | Description | Default |
|---|---|---:|
| `context_compression_threshold` | Percentage of maximum context that triggers compaction | 80 |
| `context_hard_limit` | Hard limit percentage; compaction must run if exceeded | 95 |
| `context_reinforce_after_compression` | Enable task reinjection | `true` |
| `context_wip_prefix` | Text before task description after compression | `"This is work in progress that you've already started:"` |

### OpenCode Configuration

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

### Brain Prompt Output

The `prompt:context` command already defines this format:

```txt
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

### OpenCode MCP Tool

Add a tool for arms to signal context compression:

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

- [ ] **Add Brain context-compression configuration.** Support `context_compression_threshold` with default 80, `context_hard_limit` with default 95, `context_reinforce_after_compression` with default `true`, and the configured `context_wip_prefix`.
- [ ] **Add the reinjection prompt template.** Reproduce the `prompt:context` format with the task subject, priority, classification, original task description, completed-task summary, open discoveries, and next steps. Clearly identify that the message was re-injected after compression.
- [ ] **Add the compression-reporting MCP tool.** Register `report_context_compression` with datetime, original token count, compressed token count, and retention summary fields, then send the event to the Brain with the arm ID.
- [ ] **Detect compression and reinject context.** Have the Brain consume compression events and optionally send the reinforced task context according to configuration.
- [ ] **Document harness-specific configuration.** Explain how the OpenCode configuration maps to the Brain settings and how different harnesses report or handle compression.
- [ ] **Test context-compression scenarios.** Cover threshold and hard-limit behavior, reinjection, disabled reinforcement, event parsing, and retention summaries.
- [ ] **Filter tools by task specialization.** Select and filter available tools based on task classification to prevent context overload while preserving the general-purpose nature of arms.
- [ ] **Add vector-backed arm conversation history.** Store arm conversation history in a vector database and provide configurable retention for that history.

### Dependencies

- Phase 2 (Task Classification)
- Phase 2.6 (Agentic Brain)

---

## Phase 2.8: Global Status History Search

**Goal**: Provide searchable full-text history of arm status messages and completions through vector-database indexing.

### Problem

Arms generate status reports, task completions, discoveries, and progress updates. Once processed, this institutional knowledge is difficult to search. Users and the Brain need:

1. Historical context: “What did we try before that failed?”
2. Pattern recognition: “Which arms tend to get stuck on similar problems?”
3. Knowledge retrieval: “Has anyone solved this type of problem before?”
4. An audit trail: “What happened during that overnight run?”

### Architecture

```txt
Arms ──▶ Status Reports ──▶ NATS JetStream ──▶ Consumer
                                  │                 │
                                  ▼                 ▼
                            Event Stream      Vector DB
                            (audit log)       (embeddings)
                                  │                 │
                                  └────────┬────────┘
                                           ▼
                                    Search API
                                      │    │
                                      ▼    ▼
                                  Users  Brain
```

### Status History Event

```typescript
interface StatusHistoryEvent {
  id: string;
  arm_id: string;
  arm_name: string;
  timestamp: string;
  event_type: 'status_report' | 'task_completed' | 'discovery' | 'bug_reported';

  summary: string;
  full_text: string;

  task_id?: string;
  task_subject?: string;
  classification?: string;
  status?: 'on_track' | 'blocked' | 'issues_found' | 'completed';

  importance: 'routine' | 'notable' | 'critical';
}
```

### Vector Database

Options considered:

| Option | Pros | Cons |
|---|---|---|
| SQLite + sqlite-vss | No external dependencies; single database | Limited scale |
| LanceDB | Embedded, Rust-based, fast | Newer and less mature |
| Chroma | Popular, good Python ecosystem | Requires separate process |
| Qdrant | Production-ready; excellent filtering | Requires a container |

**Recommendation: Qdrant from the start.**

Rationale:

- Production-ready filtered vector search by arm, date, and event type.
- Octopai is already distributed through NATS and the API server.
- A container fits the architecture.
- Qdrant can start with `docker run qdrant/qdrant`.
- This avoids migration costs from starting with a simpler system.
- It is battle-tested for autonomous long-running systems.

### Search Capabilities

| Query | Example | Implementation |
|---|---|---|
| Semantic | “problems with database migrations” | Vector similarity |
| Filtered | “status reports from arm-alpha last week” | Metadata plus vector |
| Exact | “error: SQLITE_BUSY” | Full-text search |
| Hybrid | “authentication issues” with an arm filter | Combined ranking |

### API

```typescript
POST /api/status-history/search
{
  query: string;
  filters?: {
    arm_ids?: string[];
    event_types?: string[];
    from?: string;
    to?: string;
    task_id?: string;
    classification?: string;
  };
  limit?: number;
  include_context?: boolean;
}
```

Response:

```typescript
{
  results: Array<{
    event: StatusHistoryEvent;
    score: number;
    highlights: string[];
  }>;
  total: number;
  query_time_ms: number;
}
```

Additional endpoints:

```txt
GET /api/arms/:id/status-history
  ?from=2026-01-01
  &to=2026-01-23
  &limit=100

GET /api/status-history/stats
  ?period=week
```

### MCP Tool

```typescript
server.registerTool(
  "search_status_history",
  {
    description: "Search historical status reports and completions from all arms",
    inputSchema: {
      query: z.string().describe("Natural language search query"),
      filters: z.object({
        arm_ids: z.array(z.string()).optional(),
        event_types: z.array(
          z.enum(['status_report', 'task_completed', 'discovery', 'bug_reported'])
        ).optional(),
        days_back: z.number().optional().default(30),
      }).optional(),
      limit: z.number().optional().default(10),
    },
  },
  async ({ query, filters, limit }) => {
    const results = await statusHistorySearch.search(query, filters, limit);
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  }
);
```

### Use Cases

| Actor | Use case | Example |
|---|---|---|
| Human | Debug overnight run | “errors or blockers from last night” |
| Human | Find past solution | “how did we fix the rate limiting issue” |
| Brain | Avoid repeated failures | “previous attempts at database migration” |
| Brain | Learn from success | “successful deployments this month” |
| Arm | Context for similar task | “past work on authentication” |

### UI Components

**Status History Search Page**:

- Natural-language search bar.
- Filter sidebar for date range, arms, and event types.
- Results with highlighted matches.
- Expandable cards showing full context.
- Optional timeline view.

**Dashboard Widget**:

- “Recent Notable Events” quick view.
- Link to the full search.

### Retention Policy

| Event type | Retention | Rationale |
|---|---|---|
| Task completions | Forever | Critical audit trail |
| Status reports | 90 days | Useful for debugging |
| Routine heartbeats | 7 days | High volume and low value |
| Critical events | Forever | Important history |

### Deliverables

- [ ] **Add the NATS JetStream status-event consumer.** Consume status reports, completions, discoveries, and bug events from the event stream. Preserve the event data required for audit logging and indexing.
- [ ] **Integrate Qdrant.** Run Qdrant in a Docker container and configure the vector store for filtered searches by arm, date, event type, task, and classification.
- [ ] **Generate embeddings.** Add embedding generation using OpenAI or a local model, and associate embeddings with the complete `StatusHistoryEvent` data.
- [ ] **Add the hybrid search API.** Implement `POST /api/status-history/search`, `GET /api/arms/:id/status-history`, and `GET /api/status-history/stats`. Support semantic, filtered, exact, and combined ranking behavior.
- [ ] **Add the historical-search MCP tool.** Expose natural-language search with arm, event-type, and days-back filters to the Brain and arms.
- [ ] **Add the status history search page.** Provide the natural-language search bar, date/arm/event filters, highlighted results, expandable full context, and optional timeline view.
- [ ] **Add the dashboard notable-events widget.** Show “Recent Notable Events” and link to the complete search page.
- [ ] **Implement retention policy.** Retain task completions and critical events forever, status reports for 90 days, and routine heartbeats for 7 days.
- [ ] **Add a backfill script.** Index existing status reports and completions so the search is useful before new JetStream events accumulate.

### Tracking and Status

Progress is tracked through status-history feature tasks, including:

- `task-1770847399287`
- `task-1770847399288`
- `phase28g-e1f53f`
- Related UI tasks
- `task-1774902988664`
- `task-1774902988665`

These tasks cover Qdrant and collection work, the search page, and ongoing ingestion and API-layer reviews. Until the status-history search tasks close and the consumer and UI deliverables land, this phase remains in progress.

### Dependencies

- Phase 2.4 (Status Reports)
- Phase 2.3 (NATS JetStream integration)
- Phase 2.6 (Agentic Brain)

---

## Phase 2.9: Code Graph and Navigable Context

**Goal**: Provide a navigable and queryable graph of the codebase so the Brain and arms can recall structure, traverse dependencies, and improve task-context payloads.

### Deliverables

- [ ] **Add a Tree-sitter code scanner.** Regularly index the workspace using Tree-sitter and update the index incrementally where possible. The scanner must represent the current code structure as files change.
- [ ] **Store the graph in SQLite.** Represent files, symbols, and definitions as nodes, and imports, calls, references, and containment as edges. Persist the graph so it survives restarts.
- [ ] **Add graph-query API endpoints.** Expose graph nodes, edges, and code-navigation paths through the API. Queries must support the relationships needed by the Brain and arms.
- [ ] **Add the code-navigation MCP tool.** Support find definition, find references, and walking a dependency chain so agents can navigate related code.
- [ ] **Integrate graph context with the Brain.** Use graph links when evaluating task progress and enrich task-context payloads with relevant graph-derived information.

### Acceptance Criteria

- [ ] Graph updates automatically on file changes and are queryable within seconds.
- [ ] Agents can navigate from a file to related symbols and dependencies through MCP.
- [ ] The Brain can attach graph-derived context snippets to task payloads.
- [ ] Graph data is persisted in SQLite and survives restarts.

---

## Phase 3: Governance

**Goal**: Arms debate and reach consensus on plans and changes through proposals, arguments, and signals rather than human-maintained merge-request workflows.

### Deliverables

- [ ] **Add the proposal system.** Support proposals for `deploy`, `claim`, `refactor`, `dependency`, `breaking_change`, and `creative_override`. Each proposal must retain the subject, task relationship, arguments, signals, and outcome.
- [ ] **Tie arguments and signals to tasks and classifications.** Associate governance activity with the relevant task and classification while keeping arms general-purpose rather than assigning fixed roles.
- [ ] **Calculate consensus dynamically.** Use reputation and task or subject relevance instead of static arm domains when determining whether a proposal has consensus.
- [ ] **Add reputation tracking and enforcement hooks.** Store reputation information and allow the Brain to use it when evaluating governance decisions and enforcing outcomes.
- [ ] **Add the creative-override flow.** Allow an override when appropriate, but require a clear rollback plan so the change can be reversed safely.
- [ ] **Add emergency-stop (“andon cord”) handling.** Support signals that pause or stop relevant work and have the Brain process those signals consistently.
- [ ] **Transition to task configuration templates.** Make task classification—architect, development, QA, documentation, and so on—select a configuration template. Templates must define defaults for tools, context bundles, safety rules, and governance expectations; remaining MR-style templates must be removed or updated to reference task configuration templates instead of fixed arm or MR roles.
- [ ] **Allow direct Brain plan updates with proposal-controlled arm changes.** The Brain may update plans directly, while arm-initiated plan changes must use proposals for consensus.
- [ ] **Record governance decisions durably.** Preserve proposals, arguments, signals, consensus calculations, reputation inputs, approvals, rejections, rollback plans, and final outcomes for task history and human oversight.

---

## Phase 4: Garden Visualization

**Goal**: Provide a 3D visualization of the workspace.

### Deliverables

- [ ] **Integrate React Three Fiber.** Add the 3D rendering foundation for the Garden visualization and connect it to workspace state.
- [x] Add a radial coordinate system.
- [ ] **Display real-time file activity.** Reflect file activity in the Garden as workspace events occur.
- [ ] **Add ownership coloring.** Color workspace regions or files according to current ownership.
- [ ] **Highlight conflict zones.** Make areas with conflicting claims or activity visible in the 3D view.
- [x] Add interactive navigation.
- [x] Generate octopus avatars for arms with reuse logic and color/personality traits.
- [x] Add a Brain mascot with personality and animation.

---

## Phase 5: Notifications and Deployment

**Goal**: Add push notifications and deployment flow.

### Deliverables

- [ ] **Add browser push notifications.** Notify users about relevant project, arm, status, bug, governance, and deployment events.
- [ ] **Add the deployment proposal flow.** Route deployment requests through the governance proposal system and preserve the resulting decision.
- [ ] **Add blue/green deployment support.** Provide the two-environment deployment behavior needed to shift traffic safely.
- [ ] **Add rollback with pause.** Pause relevant work when rollback is required and retain the rollback outcome.
- [ ] **Add monitoring integration hooks.** Expose integration points for deployment and runtime monitoring systems.

---

## Phase 6: Agent Harnesses

**Goal**: Support multiple AI agents through pluggable harnesses with restart-resilient lifecycle management.

### Current Status

Implemented harnesses:

- `opencode-api` (HTTP)
- `opencode` (PTY)
- `opencode-tui` (visual terminal plus API)

Lifecycle policy:

- `opencode-api` and `opencode` are daemon-managed and should be launched through `ArmAgent` so sessions survive API restarts.
- `opencode-tui` can remain a local/operator mode where persistence across API restarts is less critical.

### Phase 6.1: Daemon-First Harness Routing

### Deliverables

- [ ] **Add API-restart regression tests.** Verify that an arm survives an API restart, prompts still route to the surviving session, and claims remain valid. The tests must cover the daemon-managed `opencode-api` and `opencode` lifecycle policy.

### Phase 6.2: ACP Integration

**Goal**: Add an ACP adapter layer so Coleo can interoperate with external clients, including Claude Code and Codex CLI, without hard-coding each harness.

### Deliverables

- [ ] **Implement the ACP handshake.** Support `initialize`, version negotiation, and capability negotiation before using an ACP session.
- [ ] **Map core ACP methods to harness actions.** Support `session/new`, `session/load`, `session/prompt`, `session/cancel`, and `session/set-mode`, mapping them to the corresponding harness behavior.
- [ ] **Support ACP authorization callbacks.** Handle authorization for `acp/fs/read-text-file` and `acp/fs/write-text-file` without bypassing the required safety flow.
- [ ] **Add ACP transports incrementally.** Start with ACP `stdio` transport for local adapters, then add Streamable HTTP/SSE for remote agents.
- [ ] **Define `AcpHarnessAdapter`.** Map the interface to Coleo harness primitives: `spawn`, `prompt`, `interrupt`, and `state`.
- [ ] **Support session attach and resume.** Preserve long-running agent sessions and allow external clients to attach to or resume them.
- [ ] **Document ACP compatibility.** Maintain a compatibility matrix for ACP-capable clients and unsupported features.
- [ ] **Add ACP conformance tests.** Use recorded ACP transcripts to verify handshake, methods, authorization, transport, attach, and resume behavior.

### Future Work: Phase 7+

- [ ] Add more harnesses and protocol adapters beyond OpenCode.
- [ ] Improve PTY/TUI session reattachment and persistence.
- [ ] Add placement policies based on capabilities, load, and affinity for multi-agent scheduling.

---

## Phase 7: Polish and Production

**Goal**: Produce a production-ready system.

### Deliverables

- [ ] **Add PostgreSQL support.** Provide the production database option while preserving the required data and query behavior.
- [ ] **Add a comprehensive test suite.** Cover the production system, orchestration behavior, APIs, harnesses, UI integration points, and failure paths.
- [ ] **Optimize performance.** Identify and improve slow orchestration, database, API, search, and UI operations without changing required behavior.
- [ ] **Harden security.** Strengthen authentication, authorization, data handling, tool access, deployment controls, and other production security boundaries.
- [ ] **Add Docker Swarm support.** Provide deployment support for the distributed production environment.
- [ ] **Write user documentation.** Document setup, configuration, communication modes, arm operation, planning, governance, deployment, and troubleshooting.
- [ ] **Evaluate the PTY harness.** Reassess the PTY harness if remaining issues are resolved and record whether it is suitable for production use.

---

## Phase 8: Budget Planning and Burn Rate Estimation

**Goal**: Enable long-running autonomous operation with predictable costs through model cost tracking, burn-rate estimation, and budget forecasting.

### Problem

Users want to run Octopai autonomously for hours, days, or weeks without constant monitoring. They need:

1. Predictable costs before starting a work session.
2. Model flexibility to trade quality against cost.
3. Adaptive pricing that handles model price changes.
4. Cost-aware task distribution across models.

### User Scenarios

| Scenario | Need |
|---|---|
| “Run overnight on this feature” | Estimate eight-hour cost at the current burn rate |
| “I have a $50 budget for this sprint” | Calculate how many hours or tasks that buys |
| “Use GPT-4.1 for architecture, cheaper models for tests” | Route models with cost awareness |
| “Prices changed, recalculate my estimates” | Dynamically reprice without manual updates |

### Model Preference Configuration

```toml
# ~/.octopai/config.toml
[models]
preferred = ["claude-sonnet-4", "gpt-4.1", "grok-code"]
banned = ["gpt-3.5-turbo", "claude-haiku"]

[models.overrides]
architect = ["claude-sonnet-4"]
qa = ["grok-code", "gpt-4.1-mini"]
documentation = ["grok-code"]
```

The preferred list is ordered, with the first model preferred and the last as fallback. Banned models must never receive work.

### Price Tracking Schema

```sql
CREATE TABLE model_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_cost_per_1k REAL NOT NULL,
  output_cost_per_1k REAL NOT NULL,
  cache_read_cost_per_1k REAL,
  cache_write_cost_per_1k REAL,
  effective_from TEXT NOT NULL DEFAULT (datetime('now')),
  effective_to TEXT,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_model_prices_current
  ON model_prices(provider, model, effective_to);
```

The `source` value identifies `opencode_api`, `manual`, or `provider_api`.

### Burn-Rate Model

```typescript
interface BurnRate {
  tokensPerMinute: { input: number; output: number };
  costPerMinute: number;
  costPerHour: number;

  estimatedDailyCost: number;
  estimatedWeeklyCost: number;

  byModel: Record<string, {
    tokensUsed: { input: number; output: number };
    cost: number;
    percentOfTotal: number;
  }>;

  confidence: 'low' | 'medium' | 'high';
  samplePeriodMinutes: number;
}
```

### Budget Forecast

```typescript
interface BudgetForecast {
  budget: number;
  spent: number;
  remaining: number;

  estimatedHoursRemaining: number;
  estimatedTasksRemaining: number;
  depletionTime: Date;

  scenarios: {
    economyMode: {
      hoursRemaining: number;
      qualityImpact: 'minimal' | 'moderate' | 'significant';
    };
    premiumMode: {
      hoursRemaining: number;
    };
  }
}
```

### API Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/budget` | Current budget status and forecast |
| `GET /api/budget/burn-rate` | Real-time burn-rate calculation |
| `GET /api/budget/history` | Historical spend |
| `POST /api/budget/set` | Set budget limits and alerts |
| `GET /api/models/prices` | Current and historical model prices |
| `POST /api/models/prices/refresh` | Fetch latest provider prices |

### UI Components

**Budget Dashboard Widget**:

- Current spend versus budget progress bar.
- Burn-rate indicator in dollars per hour.
- Time remaining at the current rate.
- Model-breakdown pie chart.

**Budget Planning Page**:

- Set a session, daily, or weekly budget.
- Simulate costs with different model mixes.
- Show price-change alerts and impact analysis.
- Show historical cost graphs.

**Model Selector with Costs**:

- Show dollars per 1,000 tokens for each model.
- Estimate task cost from historical averages.
- Warn about budget impact when selecting expensive models.

### Budget Enforcement

```typescript
interface BudgetPolicy {
  dailyLimit?: number;
  sessionLimit?: number;

  warningThreshold: number;

  onWarning: 'notify' | 'downgrade_models' | 'pause_low_priority';
  onLimit: 'pause' | 'stop' | 'notify_only';

  downgradeOrder: string[];
}
```

### Deliverables

- [ ] **Add historical model-price tracking.** Create the `model_prices` table and index, storing provider, model, input/output/cache pricing, effective dates, source, and creation time.
- [ ] **Refresh prices from OpenCode.** Fetch current prices through `GET /provider`, preserve historical records, and identify whether each value came from `opencode_api`, `manual`, or `provider_api`.
- [ ] **Calculate burn rate from recent activity.** Use actual token and cost activity to calculate tokens per minute, cost per minute, cost per hour, daily and weekly estimates, per-model usage, and confidence over a sample period.
- [ ] **Add budget forecasting.** Calculate budget, spent, remaining, estimated hours and tasks remaining, depletion time, and economy and premium scenarios with the specified quality-impact values.
- [ ] **Add model-preference configuration.** Support ordered preferred models, banned models that must never receive work, and classification-specific overrides.
- [ ] **Route tasks by classification and cost.** Select models according to the configured preferences, classification overrides, current prices, and cost-aware task distribution.
- [ ] **Add the budget dashboard widget.** Show current spend versus budget, dollars-per-hour burn rate, time remaining, and a model-breakdown pie chart.
- [ ] **Add the budget-planning page.** Allow session, daily, and weekly budgets; simulate model mixes; show price-change impact; and display historical cost graphs.
- [ ] **Add the cost-aware model selector.** Show dollars per 1,000 tokens, estimate task cost from historical averages, and warn when a selection has a high budget impact.
- [ ] **Add optional budget-enforcement policies.** Support daily and session limits, warning thresholds, notification or model-downgrade behavior, low-priority pausing, pause/stop/notify-only limit behavior, and the configured downgrade order.
- [ ] **Detect price changes and alert users.** Compare refreshed prices with historical values and update estimates when prices change.
- [ ] **Add budget API endpoints.** Implement the budget status, burn-rate, history, budget-setting, current/historical model-price, and price-refresh endpoints listed above.

### Dependencies

- Phase 1 (Observatory)
- Phase 2 (Task Classification)
- OpenCode API integration

### Acceptance Criteria

- [ ] Users can set daily and weekly budgets.
- [ ] Burn rate updates in real time from actual usage.
- [ ] Budget forecasts are within 20% of actual spend.
- [ ] Price changes are detected and estimates are updated.
- [ ] Model preference ordering is respected.
- [ ] Banned models never receive work.
- [ ] The UI clearly shows cost and quality tradeoffs.

---

## Remaining Tasks Created by Brain

These tasks were documented by the Brain and remain in scope.

### Deliverables

- [ ] **Provide arm access to development-server logs and restart control.** Research existing solutions, including MCP servers, then implement log access and development-server restart control. Coordinate destructive operations through the Brain rather than allowing unreviewed direct actions.
- [ ] **Add thrashing detection for lazy claims.** Detect when arms are fighting over files, implement a lazy claim-release protocol, and throttle rapid reclaims so repeated claim competition does not destabilize work.
- [ ] **Add the handoff protocol between arms.** Define graceful task handoff, include context transfer, and handle abandoned tasks and conflicts without losing task state or work history.

---

## Regular Refactoring Cycle

**Goal**: Keep files small enough for LLM context windows through periodic refactoring.

### Problem

Large files over 400 lines:

- Consume significant context budget.
- May not fit completely into an arm’s context.
- Lead to more errors and incomplete understanding.

### Trigger Conditions

The Brain creates a refactoring task when:

1. Five tasks have been completed.
2. Any file over 400 lines is found during work.
3. A human explicitly requests refactoring.

### Refactoring Classification

| Classification | Purpose | Output |
|---|---|---|
| `refactoring` | Split large files | Smaller, focused modules |

### Prerequisites

Before refactoring, the arm must verify:

1. `git status` shows no uncommitted changes to target files.
2. All files to be refactored are checked in.
3. No other arm has claimed the target files.

If prerequisites are not met:

- The arm reports a blocker to the Brain.
- The Brain waits or reassigns the task.
- Refactoring does not proceed with uncommitted changes.

### File Size Rules

| Threshold | Action |
|---|---|
| >400 lines | Flag for refactoring |
| >600 lines | High-priority refactoring |
| >800 lines | Critical; block new work on the file until refactored |

### Brain Implementation

```typescript
let completedTaskCount = 0;

async function onTaskCompleted(task: Task) {
  completedTaskCount++;

  if (completedTaskCount % 5 === 0) {
    const largeFiles = await findLargeFiles(400);
    if (largeFiles.length > 0) {
      await createRefactoringTask(largeFiles);
    }
  }
}

async function findLargeFiles(threshold: number): Promise<string[]> {
  // Use wc -l or similar to find files > threshold lines.
  // Exclude node_modules, .git, and build artifacts.
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

### Refactoring Task Template

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

- [ ] **Track completed-task count in the Brain.** Increment the count when a task completes and evaluate the five-task trigger without losing the count across the relevant Brain lifecycle.
- [ ] **Implement `findLargeFiles()`.** Use `wc -l` or similar to find files over the configured threshold, excluding `node_modules`, `.git`, and build artifacts.
- [ ] **Add the refactoring task classification.** Ensure the Brain can create and assign tasks classified as `refactoring` with the correct purpose and output.
- [ ] **Add prerequisite verification to the template.** Require `git status`, checked-in target files, and confirmation that no other arm has an active claim before refactoring starts.
- [ ] **Add configurable file-size thresholds.** Default the flagging threshold to 400 lines and preserve the >600 high-priority and >800 critical rules.
- [ ] **Escalate oversized files.** Assign high priority to files over 600 lines and block new work on files over 800 lines until refactoring occurs.
- [ ] **Integrate refactoring with claims.** Prevent refactoring from proceeding when another arm has claimed a target file and preserve the prerequisite blocker behavior.

### Dependencies

- Phase 2.1 (Progressive Planning)
- Claims system

---

## Additional Architecture Considerations

### NATS JetStream Event Sourcing

Some current-state data is better modeled as derived state from an event stream. NATS JetStream provides:

- Append-only event logs with configurable time, size, and count retention.
- A key-value store for derived state snapshots.
- Replay to rebuild state from event history.

Potential candidates after SQLite cleanup:

| Current state | Event stream | Derived query |
|---|---|---|
| `seenArmIds` | `task_assigned` events | Whether any task was assigned to an arm |
| Arm heartbeats and last seen | `heartbeat` events | Most recent heartbeat for an arm |
| Task state transitions | `task_claimed`, `task_completed`, and similar events | Current status equals the last event type |
| Message delivery status | `message_sent`, `message_acked` | Whether a message was acknowledged |

Benefits:

- Full audit trail of state changes.
- Current state is computed rather than duplicated.
- Time-series queries.
- Natural fit for distributed systems.

Implementation notes:

- NATS JetStream is already integrated for arm communication.
- Start with task state transitions.
- Keep SQLite for complex queries and JetStream for the event log.
- Cache current state in SQLite and rebuild it from the stream on startup.

See [jetstream-migration-plan.md](./jetstream-migration-plan.md) for the comprehensive migration plan and question-event formats.

### Question Event Handling

Arms can emit `question.asked` events when they need decisions requiring human input. The Brain must detect these events, handle them autonomously when possible, or escalate them to humans. The complete event schema and handling requirements are in the JetStream migration plan.

### Data That Remains in SQLite or Files

The following are not candidates for event sourcing:

- Maildir messages, because Maildir is standard and interoperable.
- MCP configurations, because they are external tool requirements.
- Plan documents, because they are human-editable and version controlled.
- Configuration, because it is human-editable TOML.

### Task File References

Tasks should reference git-tracked files as dependencies and outputs so durable artifacts outlive any orchestration tool.

| Directory | Purpose | Relation to task |
|---|---|---|
| `.project/acceptance/` | Acceptance criteria per phase | Input dependency |
| `.project/decisions/` | Architectural decisions | Input/output |
| `.project/tasks/` | Task definitions and context | Input dependency |
| Source files | Implementation artifacts | Output |

Proposed schema:

```sql
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

Benefits:

- Tool-agnostic access to `.project/` files.
- Git-tracked decisions and acceptance criteria.
- SQLite queries showing which tasks read or wrote files.
- An audit trail showing why a decision was made and which task created it.

Implementation notes:

- Arms report file dependencies when claiming tasks.
- Arms report output files when completing tasks.
- The Brain verifies outputs exist before marking a task complete.
- The UI can show a file graph for each task.

### Status Reports in Maildir

Status reports currently stored as `.project/status-*.md` files should eventually be stored in Maildir format.

Current state:

- `.project/status-2026-01-16-*.md` files are in the project root.
- They are not queryable and are not integrated with the mail UI.

Target state:

- Status reports are written as Maildir messages to `~/.octopai/mail/brain/cur/`.
- Headers include:
  - `X-Octopai-Type: status-report`
  - `X-Octopai-Task: <task-id>`
- The body remains Markdown.
- Reports are queryable through the mail UI and API.
- Humans can reply to status reports.

Benefits:

- A unified communication channel.
- Status reports appear in the Observatory mail UI.
- Humans can reply with feedback or corrections.
- The design remains consistent with Maildir-as-communication-channel philosophy.

---

## Active Design: Branch-Centered Iterative Task Lifecycle

**Date**: July 2026

**Goal**: Make a task the durable unit of work while multiple arms implement, review, polish, approve, and merge changes through recorded passes on the same task and branch.

### Core Decisions

- A task is not complete merely because one arm reports completion.
- The first completion report ends an implementation pass and moves the task into evaluation.
- At least one different arm must inspect the implementation before autonomous completion.
- Implementation, review, polish, and merge are passes on the same task, not generated child review tasks.
- Every pass starts from the task’s intended branch and current code state on that branch.
- Diffs, commits, test evidence, comments, decisions, and pass outcomes remain associated with the original task.
- Human comments are durable context. They do not immediately requeue a task, create a reviewer, or prompt an arm.
- The Brain selects the next task and pass type through its normal planning cycle using deterministic safety rules plus LLM-generated scores.
- The default path should be autonomous: more than half of completed work should be reviewed, approved, and merged without human intervention.

### Pass Types

| Pass | Purpose | Typical outcome |
|---|---|---|
| `implementation` | Implement or continue the requested change | Code, tests, commits, and updated diff |
| `review` | Independently inspect requirements, branch diff, tests, and history | Approve, identify gaps, or modify branch |
| `polish` | Address review findings or improve correctness and quality | Updated code and evidence |
| `human_review` | Record structured human approval when requested | Approve, reject, or request follow-up |
| `merge` | Merge the approved branch and verify it on main | Terminal completion or merge failure |

Each pass records:

- Task
- Arm or human actor
- Pass type
- Branch
- Base and head commits
- Diff reference
- Summary
- Tests
- Findings
- Outcome
- Start time
- Completion time

Review and polish history must remain queryable without creating additional queue items.

### Durable Pass Leasing

Pass assignment uses a durable, single-use lease rather than an advisory reviewer field.

- The API creates an opaque lease ID and expiry for every arm pass.
- A claim transaction verifies task eligibility, arm idleness, and that neither has another active lease.
- The transaction creates the pass, stores the lease, marks the arm busy, and links the active pass to the task atomically.
- The Brain prompts an arm only after the durable claim succeeds.
- If prompting fails, a token-checked release clears only the matching pass and assignment.
- Completing a pass requires the matching lease ID, pass ID, task ID, and arm ID.
- Missing, stale, duplicated, expired, unleased, or wrong-arm responses are rejected without changing task or arm state.
- Pass completion and arm release occur in one transaction.
- Expired leases are reclaimed safely without disturbing newer work.

This replaces the blocked-task reviewer loop and prevents failed persistence from prompting an arm or marking it busy locally. It also prevents stale responses from altering task state.

### Branch and Diff Continuity

- Each code task has a canonical working branch or branch reference.
- Every arm receives the current branch, base commit, head commit, stored diff, acceptance criteria, prior pass summaries, and unresolved findings.
- A reviewing arm checks out the same intended branch and evaluates the current code.
- A reviewer may approve the branch unchanged or modify it directly before completing the pass.
- Each completed pass stores the resulting head commit and diff snapshot.
- A task reaches terminal completion only after a merge pass verifies that the approved head is on main and required checks pass.

### Brain Scoring and Next-Action Selection

The Brain evaluates task-plus-action candidates. Its LLM scoring input includes:

- Task requirements and acceptance criteria.
- Current status, blockers, dependencies, and priority.
- Canonical branch state, commits, stored diffs, and test evidence.
- Implementation, review, polish, human-review, and merge pass history.
- Human and arm comments, including comments added since the previous pass.
- Open findings, bugs, discoveries, and related tasks.
- Model cost, risk, and confidence of prior reviewers.

The Brain produces scores and reasoning for:

- Implement
- Review
- Polish
- Request human review
- Merge
- Wait
- Declare the task irrelevant

Deterministic rules remain authoritative:

- A task with an active lease cannot receive another pass.
- Unresolved dependencies prevent implementation and merge when they are true prerequisites.
- An implementation cannot merge without an independent review pass from a different arm.
- Rejected work cannot merge until a later pass addresses the rejection.
- Merge requires branch, diff, commit, and test evidence.
- Comments alone never trigger an immediate pass or direct prompt.

### Comments and Human Messages

Comments are append-only task context, not queue commands.

- A UI comment does not change task status, recheck time, active lease, or assigned arm.
- An email reply does not directly create a reviewer or prompt an arm.
- The next arm claiming a pass receives all new comments since the previous pass and a summary of earlier relevant discussion.
- The Brain includes comments during its next normal scoring cycle.
- Outgoing task mail stores a durable mapping between message ID, task ID, and any human-review request ID.
- Inbound mail resolves threads through `In-Reply-To` and `References`; Coleo-specific headers are an optimization, not a requirement.
- A generic reply is stored as a comment only.
- An unambiguous response to a pending human-review request is also recorded as a structured `human_review` pass, but does not directly prompt an arm.
- Ambiguous approval language remains a comment for the Brain or next arm to interpret safely.

### Human Review Outcomes

- Human rejection records feedback, leaves the branch and diff intact, and makes the original task eligible for another implementation or polish pass.
- Human approval allows the Brain to schedule a merge pass when deterministic checks are satisfied.
- If a human approves the current work but asks for an additional capability, the Brain completes and merges the current task, then creates a linked follow-up task.
- The follow-up task references the original task, relevant human comments, branch or commit evidence, and the reason it is separate scope.
- If the additional request changes the original acceptance criteria rather than adding follow-up scope, the Brain keeps the original task open and schedules another pass.

### Dependency Completion Safety

Dependency completion is evidence for reevaluation, not permission to reset arbitrary task state.

- Completing a dependency records a dependency event and lets the Brain reevaluate the dependent task during normal scoring.
- Automatic readiness updates apply only when the task is actually dependency-blocked and every required dependency is complete.
- A compare-and-set update verifies expected task state and the absence of an active pass before changing readiness.
- Dependency completion never clears human, bug, environment, file-claim, or arm/runtime blockers.
- Concurrent claimed, completed, cancelled, or otherwise changed tasks are not overwritten.
- No arm is prompted directly when a dependency completes.

### Task Completion Flow

```txt
Arm completes implementation pass
        |
        v
Task enters evaluation on the same branch
        |
        v
Brain scores next action using branch, diff, tests, history, and comments
        |
        +--> Independent review pass
        |       |
        |       +--> Modify/polish branch and return to evaluation
        |       +--> Approve and return to evaluation
        |
        +--> Human review request when risk or policy requires it
        |       |
        |       +--> Reject: same task becomes eligible for more work
        |       +--> Approve: task becomes eligible for merge
        |       +--> Approve plus new scope: create linked follow-up task
        |
        +--> Merge pass when evidence and confidence are sufficient
                |
                +--> Verify main and mark the original task complete
```

### Migration Plan

- [ ] **Add durable lifecycle storage.** Store task passes, leases, branch references, diff references, and structured decisions. Preserve the association between all pass artifacts and the original task.
- [ ] **Add atomic pass operations.** Implement claim, release, and completion API operations that verify eligibility, arm idleness, lease identity, and task state atomically.
- [ ] **Require lease identity for completion.** Require matching lease ID, pass ID, task ID, and arm ID in arm completion and review tools and in inbox validation. Reject missing, stale, duplicated, expired, unleased, or wrong-arm responses without changing state.
- [ ] **Make comments passive context.** Stop human comments from changing blocked-review scheduling or active leases. Ensure generic email replies are stored as comments and do not directly create reviewers, requeue tasks, or prompt arms.
- [ ] **Correlate email threads and human reviews.** Store durable message-to-task and human-review-request mappings, and resolve inbound mail through `In-Reply-To` and `References`.
- [ ] **Guard dependency reevaluation.** Replace unconditional dependency unblocking with compare-and-set reevaluation that changes readiness only for genuinely dependency-blocked tasks with all prerequisites complete and no active pass.
- [ ] **Remove the blocked-task reviewer loop.** Stop the periodic reviewer-assignment loop and use Brain task-action scoring with the branch-centered pass model.
- [ ] **Use passes instead of child tasks.** Stop creating validation, review, and polish child tasks. Convert identifiable existing review child tasks into pass history while preserving comments and activity records.
- [ ] **Add Brain scoring and merge safeguards.** Score implement, review, polish, human review, merge, wait, and irrelevant outcomes using task, branch, diff, evidence, comments, cost, risk, and confidence; enforce deterministic merge rules.
- [ ] **Add autonomy metrics.** Track human-review rate, autonomous approval rate, merge success, rework passes, and stale-lease rejection so the target of more than 50% autonomous merged work can be evaluated.

### Acceptance Criteria

- [ ] A failed lease or arm-state write never prompts an arm or marks it busy locally.
- [ ] Two concurrent pass claims produce exactly one winner.
- [ ] Duplicate, stale, unleased, expired, and wrong-arm completion responses have no side effects.
- [ ] A late response cannot clear an arm’s newer assignment.
- [ ] Human comments and generic email replies never create a reviewer, immediately requeue a task, or prompt an arm.
- [ ] The next pass briefing always includes comments added since the previous pass.
- [ ] Dependency completion cannot clear unrelated blockers or overwrite concurrent task transitions.
- [ ] Local and external approval replies correlate with the correct task and human-review request.
- [ ] Every implementation receives at least one independent review before merge.
- [ ] Reviewers can modify or approve the same task branch without a child review task.
- [ ] Final completion requires a successful merge pass and verification on main.
- [ ] Human rejection returns the same task to work with feedback preserved.
- [ ] Approved additional scope creates a linked follow-up task without keeping completed work open.
- [ ] More than 50% of merged tasks complete without human review under normal risk policy.

---

## Milestones

| Milestone | Target | Description |
|---|---|---|
| M1: Observable | End of Phase 1 | See arm activity in the web UI |
| M2: Coordinated | End of Phase 3 | Arms negotiate and reach consensus |
| M3: Visual | End of Phase 4 | 3D Garden shows workspace state |
| M4: Agentic | End of Phase 2.6 | Brain uses agentic decision making |
| M5: Production | End of Phase 7 | Ready for real use |

Harness strategy is daemon-first for resilient lifecycles, with protocol adapters such as ACP planned for broader client interoperability.

---

## Changelog

| Date | Change |
|---|---|
| 2026-07-17 | Added branch-centered iterative task lifecycle: durable task passes and leases, same-branch review/polish/merge, passive comment context, guarded dependency reevaluation, reliable mail correlation, and autonomous Brain scoring without generated review tasks |
| 2026-05-26 | Clarified that progressive task determination uses `.project/plan.md` and explicitly referenced sub-plans only |
| 2026-02-13 | Updated Phase 6 to daemon-first harness lifecycle (`opencode-api`/`opencode` through ArmAgent), kept `opencode-tui` as local-optional mode, and added ACP roadmap |
| 2026-02-04 | Added Phase 2.9: Code Graph & Navigable Context |
| 2026-01-25 | Added Phase 1.2: Collaborative Planning & Task Refinement |
| 2026-01-23 | Added Phase 2.8: Global Status History Search |
| 2026-01-23 | Reordered phases so Status Reports precedes Bug Tracking |
| 2026-01-24 | Added Phase 8: Budget Planning & Burn Rate Estimation |
| 2026-01-23 | Added cost and money usage line graph to Arm Activity Visualization |
| 2026-01-23 | Added Arm Activity & Efficiency Visualization |
| 2026-01-23 | Added Regular Refactoring Cycle |
| 2026-01-17 | Added Phase 2.4: Bug Tracking & Resolution with priority escalation |
| 2026-01-17 | Added model recommendations, budget tracking, vector database arm history, context compression improvements, status-report tracking, governance clarifications, and garden visualization avatars/personality |
| 2026-01-16 | Updated Phase 1 enhancements with sent messages, task history/current/next views, Arm Viewer, and web-based arm spawning |
| 2026-01-16 | Updated Phase 3 governance to use proposals, arguments, and signals without MR-specific workflows |
| 2026-01-16 | Marked Phase 1 complete; treated Project Plan Viewer as non-blocking; deferred IMAP/SMTP gateway |
| 2026-01-16 | Added Phase 2.2 documentation-update tasks |
| 2026-01-16 | Focused Phase 6 on `opencode-api`; deferred PTY harnesses to Phase 7+ |
| 2026-01-15 | Updated philosophy: arms are not specialized (ADR-009) |
| 2026-01-15 | Added `requirements.md` with task-classification details |
| 2026-01-15 | Added PM arm documentation and `.project` structure |
| 2026-01-15 | Added agent-harness documentation |
| 2026-01-15 | Updated governance, security, deployment, and related documentation |
| 2024-01-10 | Initial project setup; Phase 0 complete |
