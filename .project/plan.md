# Octopai Project Plan

## Vision

Build an AI agent orchestrator that coordinates multiple AI arms working on a shared codebase, with human oversight via email. **Arms are not specialized**—they adapt their behavior based on task classification (architect, development, QA, etc.).

See [requirements.md](./requirements.md) for philosophy, [progressive-planning.md](./progressive-planning.md) for task determination, and [tasks-representation.md](./tasks-representation.md) for UI design.

## Guiding Principles

1. **Arms are general-purpose** - Behavior determined by task classification, not arm identity.
2. **Progressive planning** - Tasks determined at runtime from plan documents.
3. **Timeline UI** - Show recent activity + next task, not CRUD backlog.
4. **Transparency** - All project state in plain text files, version controlled.
5. **Human-centric** - Humans provide requirements; arms execute and report.

## Current Planning Position

Execution begins with the previously defined Phase 4 work. Phase 0 through Phase 3 are retained below as historical prerequisite records and decisions; their early verification tasks are not reopened or placed ahead of the active work. The current workspace already contains related collaborative-planning, activity, queue, dashboard, and arm-viewer changes, but filenames and Git status do not by themselves establish implementation completion. Existing checked states are preserved as source-plan state and must not be changed without task evidence.

The current workspace is not clean: Git status includes modified project, documentation, API, Brain, database, CLI, setup, fixture, and web files, one new CLI plan command, and new dashboard and queue-chart tests/components. These changes may represent partial implementation, unrelated work, or work requiring integration. Phase 4 therefore begins with inspection and contract reconciliation before additional implementation. No changed file is treated as complete solely because it appears in the workspace inventory.

The regeneration review must use the complete Markdown plan and workspace inventory before assigning implementation work. The first active tasks establish the baseline, reconcile staged and unstaged changes, identify authoritative boundaries, and confirm prerequisites. No implementation task is assigned until those checks are complete.

The active dependency order is:

1. Phase 4 baseline and contract reconciliation.
2. Phase 5 status-report contracts and human-oversight persistence.
3. Phase 6 progressive-planning gates and durable task lifecycle.
4. Phase 4 task-preparation execution.
5. Phase 8 bug handling.
6. Phase 9 Agentic Brain.
7. Later phases in their declared dependency order.

No unfinished task is assigned before the earliest active numbered phase containing unfinished source work. Historical phases remain immutable.

---

## Historical Prerequisite Record

The following completed or foundational phases remain part of the project record. They are not reopened as early verification work for the current execution sequence.

## Phase 1: Core Infrastructure and API Boundary

This phase provides the execution substrate and integration boundaries required by every later feature. Phase 0 decisions, repository validation, and the API-owned integration model must precede changes here. The existing foundation is described below as complete in the source plan, while its runtime behavior, tests, and boundary claims remain subject to evidence when affected by later work.

### Completed Foundation

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

### Active Refactor: Brain/API Boundary

We are executing a boundary cleanup where:

- Brain becomes an API-first orchestrator with no direct NATS/JetStream/harness calls.
- API server becomes the typed/authenticated integration boundary.
- ArmAgent owns harness/OpenCode traffic and publishes arm events/messages through NATS.

Execution details and phased rollout:

- `.project/plans/brain-api-boundary-execution-plan.md`
- `docs/architecture/brain-api-boundary.md`

## Phase 2: Observatory Foundation Verification and Enhancements

This phase depends on the verified API boundary and core infrastructure. The source plan records Phase 1 as complete, while the following enhancements remain non-blocking and do not retroactively prevent Phase 1 from being considered complete. Each enhancement must be validated through API behavior, UI behavior, and relevant acceptance evidence.

### Deliverables

- [x] **Verify the Phase 1 acceptance criteria.** Confirm Hono startup, health behavior, automatic SQLite migrations, arm listing and lifecycle updates, activity timeline, WebSocket reconnect behavior, React/Vite build, client-side routing, CLI proxying, API-key authentication, progressive-planning hooks, and `.project/status.md` evidence.
- [x] **Verify the Phase 1 web implementation without assuming changed filenames prove completion.** Inspect the actual behavior of the current adaptive-card, workbench, workspace, page, layout, design-system, and background-asset changes listed by Git status.
- [x] **Add the Project Plan Viewer.** Provide a file/folder tree of `.project/` and key documents on the left, including `README.md`, `plan.md`, `requirements.md`, `decisions/`, `acceptance/`, and `plans/`. Render the selected Markdown file on the right, allow plan documents to be edited in the browser, show a visible “Last Updated” timestamp derived from git commit metadata or filesystem mtime, and clearly indicate recently changed files.
- [x] **Enhance the Mail and Message Interface.** Show sent messages from users to the Brain or arms in addition to the current inbox-only view. Provide threaded conversations that include arm responses.
- [x] **Enhance the Task List.** Display past completed tasks, the current in-progress task, and the next scheduled or upcoming task. Provide a timeline view with recent activity rather than limiting the interface to a CRUD backlog.
- [x] **Add the Arm Viewer Page.** Make every arm clickable from anywhere in the UI, show live arm status and activity, and display the history of arms that have closed or finished in the project. For dead arms, retain only the last 100 activity items, and assign each arm a unique randomly generated color.
- [x] **Add the Arm Activity and Efficiency Visualization.** Provide a minute-by-minute activity bar graph over a 30-minute window, using stacked or grouped bars with events per minute and leaving gaps for inactive minutes. Distinguish file writes in blue, thinking/reasoning in yellow, tool calls in green, and completed tasks in prominent purple; allow tasks to pile up vertically within a minute bar so activity and efficiency are visible at a glance.
- [x] **Add context usage visualization to arm activity.** Place a higher-resolution context-length line graph below the activity graph, using samples such as every 10–15 seconds. Show context token usage over time, indicate the 80% compression threshold, and shade the warning zone near context limits.
- [x] **Add cost visualization to arm activity.** Place a cost or money-usage line graph below the context graph and show a running total of spend over time. Optionally stack input, output, and cache costs, show a dollars-per-hour cost-rate indicator based on recent activity, and show a budget threshold line when configured.
- [x] **Source arm cost data from OpenCode.** Use `GET /provider` and `Provider.models[].cost` for model pricing, `AssistantMessage.cost` for per-message cost, and `AssistantMessage.tokens` for input, output, reasoning, and cache read/write usage. The resulting views must help users identify expensive and inexpensive arms, cost spikes during complex reasoning, and the return on investment of different model choices.
- [x] **Provide responsive graph views and data feeds.** Show complete 30-minute graphs and legends on the Arms list page, and a compressed sparkline-style view on the Arm Viewer page. Generate graph data from the SSE event stream, poll an aggregated metrics endpoint from the frontend, and continue delivering live list updates through WebSocket events.
- [x] ~~**Add arm metrics endpoints.** Implement `GET /api/arms/:id/metrics`, `GET /api/arms/:id/context-history`, and `GET /api/arms/:id/cost-history`. The endpoints must provide the data required for the full graph, sparkline, context, and cost views.~~ <!--octopai:status:cancelled-->
- [x] **Add Arm Spawning from the Web UI.** Provide a browser form for spawning arms, auto-populate the name input with generated names, allow names to be regenerated, and provide provider and model dropdowns with cost estimates and budget warnings. Show real-time feedback while spawning.
- [x] **Add Model Recommendations and Budget Tracking.** Show cost estimates per model, such as GPT-4.1 versus Claude-3.5, based on expected token usage. Warn users about high-cost models when they spawn arms.
- [x] **Add Message Queue Visualization.** Add an API endpoint that reports queue depth and processing times, then display real-time queue status with graphs.
- [x] **Validate accessibility, responsive layouts, loading states, empty states, error states, reconnect behavior, keyboard navigation, and reduced-motion behavior for the Observatory surfaces.**
- [x] **Validate API/UI data ownership.** Confirm that the UI does not derive authoritative task, arm, activity, ownership, or queue state from filenames or stale local state.

### Acceptance Criteria

- [x] Users can sort and filter 100+ items in the grid view without performance degradation.
- [x] Discussion history is preserved per item.
- [x] The repository baseline, workspace ownership, contracts, prerequisites, test commands, and evidence locations are recorded.
- [x] No implementation task is assigned before baseline reconciliation is complete.
- [x] Phase 4 task preparation has one documented API/Brain ownership boundary and one preview/approval state machine.

### Dependencies

- Phase 0: Planning, Architecture, and Execution Preconditions
- Phase 1: Core Infrastructure and API Boundary
- Phase 1 acceptance verification

## Phase 3: Task Classification and Context

This phase establishes task-level behavior and context while preserving the principle that arms remain general-purpose. It precedes collaborative task preparation because prepared work must have a defined classification, context bundle, acceptance schema, and dependency model.

### Task Classifications

| Classification | Purpose | Output |
|---|---|---|
| Architect | Requirements → Plans | Plans, tasks |
| Development | Tasks → Code | Code, discoveries |
| QA | Code → Tests | Tests, doc verification |
| Documentation | Code → Feature Docs | Updated feature docs, “future work” notes |

### Deliverables

- [x] **Verify that arms receive discoveries when tasks are assigned.**
- [x] **Verify that discoveries are stored in SQLite with FTS5 search.**
- [x] **Verify that the API provides discovery listing and search.**

### Dependencies

- Phase 1: Core Infrastructure and API Boundary
- Phase 2: Observatory Foundation Verification and Enhancements

### Acceptance Criteria

- [x] Arms can execute any task classification.
- [x] Arms receive discoveries when tasks are assigned.
- [x] Discoveries are stored in SQLite with FTS5 search.
- [x] The API provides discovery listing and search.
- [x] No arm is selected by domain, expertise, or arm-global reputation.

---

## Active Work

## Phase 4: Collaborative Planning and Task Refinement — Baseline and Contract Reconciliation

This is the active starting phase. It depends on the Observatory API/UI foundation, classification and context contracts, canonical plan format, task-file references, progressive-planning semantics, and the branch-centered task lifecycle. Existing grid, progress, discussion, activity, queue, dashboard, arm-viewer, CLI, and related UI work must be inspected and integrated rather than assumed complete from filenames or Git status alone.

This initial segment establishes the evidence and contracts required before any implementation task is assigned. The later status-report and durable-lifecycle phases remain authoritative for those interfaces; this phase consumes them and must not silently duplicate or replace them.

### Deliverables

- [x] **Add a high-performance multi-tabbed grid view.** Support sorting and filtering large numbers of plan items, tasks, and discoveries. The grid must remain usable for the scale covered by the acceptance criteria.
- [x] **Add progress visualization.** Show real-time progress tracking, completion status, and sub-task breakdown for plan items and tasks.
- [x] **Add collaborative discussion UI.** Provide an integrated chat interface for discussing implementation and design for a specific item with an “Architect” agent.
- [ ] **Establish the Phase 4 execution baseline.** Record the repository revision, working-tree state, staged and unstaged file sets, relevant test commands, current runtime assumptions, and the acceptance evidence locations before assigning implementation work.
- [ ] **Inspect current collaborative-planning changes before implementation.** Review the actual behavior and ownership boundaries of `src/brain/task-regenerator.ts`, `src/db/state.ts`, `src/api/routes/activity.ts`, `src/cli/commands/plan.ts`, `src/cli/index.ts`, `src/cli/tui/arms-dashboard-data.ts`, `src/web/src/components/CommandQueueChart.tsx`, `src/web/src/pages/ArmViewerPage.tsx`, `src/web/src/pages/DashboardPage.tsx`, `src/web/src/pages/SettingsPage.tsx`, related tests, fixtures, documentation, and the changed plan file. Preserve unrelated work and do not infer completion from the inventory.
- [ ] **Reconcile staged and unstaged workspace changes.** Inspect the actual diffs for all related files, identify ownership of overlapping changes, preserve valid partial work, and record any conflicts or intentionally excluded files before modifying implementation.
- [ ] **Confirm the canonical task, discussion, activity, queue, and project-file contracts.** Identify the authoritative API routes, database state, plan parser, task-file references, event/activity feeds, and UI query/cache paths that Phase 4 must use.
- [ ] **Inventory every remaining phase and dependency before task assignment.** Confirm that active work is ordered by prerequisite, identify cross-phase cycles, and record which interfaces are supplied by Phase 5, Phase 6, and Phase 18 rather than creating duplicate local implementations.
- [ ] **Confirm repository and environment prerequisites.** Verify package-manager and runtime versions, database migration/test setup, NATS and Maildir assumptions, web build and browser-test commands, required environment variables, and the clean/dirty-file policy for implementation.
- [ ] **Define the evidence-recording process.** Identify the project task, acceptance record, status report, changelog, and test artifacts that must be updated for each completed baseline or implementation deliverable.
- [ ] **Confirm the Phase 4 prerequisites supplied by later lifecycle phases.** Identify the status-report, lease, pass, dependency, task-file, and approval interfaces that Phase 4 will consume from Phase 5, Phase 6, and Phase 18; record any unavailable prerequisite as a blocker rather than implementing a competing local contract.
- [ ] **Confirm the task-preparation decision boundary.** Resolve any genuinely open choice about whether preparation is synchronous or job-backed, how preview identity is represented, and which Brain/API service owns generation, while preserving explicit approval and preventing preview mutation.
- [ ] **Map the discussion-to-task data flow end to end.** Document request creation, Brain processing, generated task representation, preview persistence, UI rendering, approval/rejection, task mutation, activity recording, and retry/error paths before implementation.
- [ ] **Define the preview and approval state machine.** Specify valid transitions, authorization, expiry, idempotency keys, concurrent-operation behavior, rejection semantics, and the relationship between preview records and authoritative task records.
- [ ] **Define the integration test matrix and acceptance evidence plan.** Cover API, Brain, database, UI client, activity events, task mutation, duplicate requests, stale clients, multiple tabs, refreshes, expired previews, rejected previews, malformed output, and concurrent approvals.
- [ ] **Add a clean-boundary implementation checklist.** Confirm that implementation tasks identify their owning layer, migration requirements, event/API contracts, rollback behavior, and affected validation suites before assignment.
- [ ] **Obtain explicit baseline sign-off before assigning implementation work.** Record the reconciled contracts, unresolved blockers, excluded workspace changes, and approved next implementation boundary.

### Acceptance Criteria

- [x] Users can sort and filter 100+ items in the grid view without performance degradation.
- [x] Discussion history is preserved per item.
- [ ] The repository baseline, workspace ownership, contracts, prerequisites, test commands, and evidence locations are recorded.
- [ ] No implementation task is assigned before baseline reconciliation is complete.
- [ ] Phase 4 task preparation has one documented API/Brain ownership boundary and one preview/approval state machine.

### Dependencies

- Phase 2: Observatory Foundation Verification and Enhancements
- Phase 3: Task Classification and Context
- Phase 5: Status Reports and Human Oversight
- Phase 6: Progressive Planning and Durable Task Lifecycle
- Task-file references and canonical plan format

## Phase 5: Status Reports and Human Oversight

Status reports provide evidence for task history, blockers, discoveries, and next actions. This phase must precede durable task scheduling and bug handling so the Brain can distinguish completed work, issues, blockers, clarification requests, and work requiring verification. Phase 4 task preparation may consume status context, but status-report behavior must remain independently durable and API-owned.

The status-report schema and persistence path must be established before Phase 6 assignment gates or Phase 4 generated-task previews rely on report-derived state. Implementation begins with schema, ownership, migration, and compatibility setup, followed by Brain processing, routing, API exposure, and validation.

### Deliverables

- [ ] **Establish the status-report ownership and compatibility boundary.** Identify the canonical message, database, Brain, API, and Maildir representations; preserve existing `.project/status-*.md` records during migration.
- [ ] **Define the status report message type.** Specify fields identifying reporting arm, task, status, findings, and supporting information. Support later bug-reporting and task-determination flows.
- [ ] **Add or verify the persistence migration and indexes.** Store reports durably with task, arm, pass, branch, files, tests, discoveries, issues, blockers, and next steps without losing existing history.
- [ ] **Implement status report parsing in the Brain.** Parse incoming reports, validate structure, and store information needed for task history and aggregation.
- [ ] **Aggregate and route reports to humans.** Combine relevant arm reports and deliver them through the established communication path, including email where appropriate.
- [ ] **Make status influence task determination.** Feed parsed reports into progressive planning so issues, blockers, and completion information affect the next assignment.
- [ ] **Add a status dashboard in the API.** Expose status-report information for Observatory display.
- [ ] **Add user-message confirmation and tracking.** Track the processing fate of each user message, whether it was added to the plan, and whether it unblocked work.
- [ ] **Migrate status reports to Maildir when approved.** Write reports to `~/.octopai/mail/brain/cur/`, preserve Markdown bodies, add `X-Octopai-Type: status-report` and `X-Octopai-Task: <task-id>` headers, expose reports through mail UI/API, and support human replies.
- [ ] **Preserve status evidence in task passes.** Associate reports with task, pass, branch, files, tests, discoveries, issues, blockers, and next steps.
- [ ] **Add failure and retry handling.** Ensure malformed, duplicated, delayed, or unrouteable status reports do not corrupt task state.
- [ ] **Verify the following status-action mapping:**

| Status | Brain action |
|---|---|
| `on_track` | Log progress, no immediate action |
| `blocked` | Update task to blocked and notify human |
| `issues_found` | Log issues and notify human if significant |
| `needs_review` | Notify human and possibly assign review work |
| `completed_with_issues` | Schedule verification or polish on the same task/pass lifecycle |

- [ ] **Add unit, integration, migration, duplicate-delivery, delayed-delivery, and Maildir compatibility tests.**
- [ ] **Validate that reports cannot directly bypass lease, pass, dependency, approval, or human-review gates.**
- [ ] **Record status-report acceptance evidence before Phase 6 assignment gates consume the contract.**

### Status Report Flow

```txt
Arm → Status Report → Brain → Aggregates → Human (email)
                       ↓
              Updates task history
              Influences next task
```

### Dependencies

- Phase 1: Core Infrastructure and API Boundary
- Phase 3: Task Classification and Context
- Phase 4 baseline and contract reconciliation
- Communication modes and Maildir boundary

## Phase 6: Progressive Planning and Durable Task Lifecycle

This phase makes the canonical plan executable by the Brain while preserving progressive planning’s runtime determination model. It establishes the durable branch-centered lifecycle governing implementation, review, polish, human review, and merge. Dependencies must be parsed before work is assigned, and task state must never be reset by stale or unrelated events.

Phase 4 task-preparation implementation remains gated until the relevant status-report, lease, pass, dependency, task-file, and approval contracts below are implemented or explicitly recorded as unavailable.

### Inputs to Task Assignment

| Source | Purpose |
|---|---|
| Plan documents | What needs to be done |
| Completed tasks | What is already done |
| Status reports | What issues were found |
| Discoveries | What has been discovered |
| Open tasks | What is in progress |

### Decision Logic

```txt
IF completed AND no issues → skip
IF completed BUT has issues → assign "verify & polish"
IF incomplete AND ready → assign development task
IF blocked → notify human
```

The branch-centered task lifecycle defined below supersedes generation of separate review or polish child tasks. “Verify & polish” work must be recorded as a pass on the original task where that lifecycle applies.

### Deliverables

- [x] **Verify Brain re-evaluation on task completion.**
- [x] **Verify Brain status-report influence on task assignment.**
- [x] **Verify the “verify & polish” task classification.**
- [x] **Verify the plan document format.**
- [x] **Verify completed-task history tracking through the `status_reports` table.**
- [x] **Verify status report parsing and influence on tasking.**
- [ ] **Establish the lifecycle schema and migration boundary.** Define task passes, leases, branches, diffs, decisions, task-file references, approvals, comments, and dependency events before changing assignment behavior.
- [x] **Verify automatic primary and watcher arm assignment when tasks are claimed.**
- [x] **Verify consensus updates through the API, allowing arms to submit approvals or rejections and reach quorum.**
- [x] **Verify that the `report_dependency` tool captures discovery-based relationships surfaced during execution.**
- [x] **Verify that `### Dependencies` sections are parsed directly from plan phases.** Evidence: `extractDependenciesForPhaseLabel` parses bullet/asterisk entries and stops at the next `###` section; tests in `src/brain/__tests__/prompt-generator.test.ts`.
- [x] **Verify that plan dependencies are linked to matching tasks.** Evidence: `collectDependenciesForTask` matches by task subject or phase label, deduplicates plan and keyword matches, and records reasons; tests in `src/brain/__tests__/prompt-generator.test.ts`.
- [x] **Verify that new work is marked blocked when prerequisites are unfinished.** Evidence: `evaluateTaskDependencies` inserts `task_dependencies` records, sets `dependencyBlocked = true`, and `generateTaskDetermination` skips blocked tasks; tests in `src/brain/__tests__/prompt-generator.test.ts`.
- [x] **Verify that architect tasks can be spawned to update plan dependencies when unresolved prerequisites are discovered.** Evidence: `ensurePlanDependencyTask` creates an architect-domain task when `collectDependenciesForTask` returns unresolved reasons; tests in `src/brain/__tests__/prompt-generator.test.ts`.
- [x] **Implement the canonical single-next-task calculation.** Read `.project/plan.md`, follow only explicitly referenced sub-plans, inspect completed tasks, status reports, discoveries, open tasks, and blockers, then determine one next task or pass.
- [ ] **Implement dependency-aware assignment gating.** Do not assign a task until required prerequisites are complete and no human, bug, environment, file-claim, arm/runtime, or active-pass blocker remains.
- [ ] **Add durable lifecycle storage.** Store task passes, leases, branch references, diff references, and structured decisions. Preserve association between all pass artifacts and the original task.
- [x] **Add atomic pass operations.** Implement claim, release, and completion API operations that verify eligibility, arm idleness, lease identity, and task state atomically.
- [ ] **Require lease identity for completion.** Require matching lease ID, pass ID, task ID, and arm ID in arm completion and review tools and inbox validation. Reject missing, stale, duplicated, expired, unleased, or wrong-arm responses without changing state.
- [ ] **Make comments passive context.** Human comments must not change blocked-review scheduling or active leases. Generic email replies are comments and do not directly create reviewers, requeue tasks, or prompt arms.
- [ ] **Correlate email threads and human reviews.** Store durable message-to-task and human-review-request mappings and resolve inbound mail through `In-Reply-To` and `References`.
- [ ] **Guard dependency reevaluation.** Replace unconditional dependency unblocking with compare-and-set reevaluation that changes readiness only for genuinely dependency-blocked tasks with all prerequisites complete and no active pass.
- [ ] **Remove the blocked-task reviewer loop.** Stop the periodic reviewer-assignment loop and use Brain task-action scoring with the branch-centered pass model.
- [ ] **Use passes instead of child tasks.** Stop creating validation, review, and polish child tasks. Convert identifiable existing review child tasks into pass history while preserving comments and activity records.
- [ ] **Add Brain scoring and merge safeguards.** Score implement, review, polish, human review, merge, wait, and irrelevant outcomes using task, branch, diff, evidence, comments, cost, risk, and confidence; enforce deterministic merge rules.
- [ ] **Add autonomy metrics.** Track human-review rate, autonomous approval rate, merge success, rework passes, and stale-lease rejection so the target of more than 50% autonomous merged work can be evaluated.
- [ ] **Add task-file references.** Store acceptance criteria, decisions, plans, source dependencies, context files, and output files for each task.
- [ ] **Verify task outputs before completion.** Confirm declared output files exist, are valid, correspond to the pass, and are not merely claimed in a report.
- [ ] **Add integration and concurrency tests.** Cover competing claims, stale leases, dependency races, branch continuity, comments, email correlation, approvals, merge failures, and restart recovery.
- [ ] **Record lifecycle acceptance evidence and release the Phase 4 task-preparation gate.**

### Dependencies

- Phase 3: Task Classification and Context
- Phase 5: Status Reports and Human Oversight
- Claims system
- Verified API boundary
- Phase 4 baseline and contract reconciliation

### Branch-Centered Iterative Task Lifecycle

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

## Phase 4: Collaborative Planning and Task Refinement — Task Preparation Execution

This continuation resumes Phase 4 only after the baseline, contract reconciliation, status-report prerequisites, and durable lifecycle prerequisites have been completed or explicitly resolved. It remains in the same active phase and uses the API/Brain boundaries confirmed above.

### Deliverables

- [ ] **Add the Task Preparation Agent.** Allow the agent to turn a discussion into a detailed task definition containing context, requirements, and acceptance criteria. Preview the proposed task changes and additions in a panel when the user clicks a button in the task discussion panel.
- [ ] **Confirm the task-preparation API, Brain service, UI client, and preview contract are integrated end to end.** Preserve API ownership of authoritative task data and ensure the preview does not mutate task state until explicitly approved.
- [ ] **Confirm task-preparation request identity and lifecycle handling.** Ensure requests are idempotent, stale previews cannot overwrite newer previews, concurrent approvals are serialized, and rejected or expired previews remain auditable without mutating task state.
- [ ] **Persist preparation inputs and outputs durably.** Retain the source discussion reference, requester, task/item identity, generated proposal, model or agent outcome, validation errors, preview status, approval or rejection actor, timestamps, and resulting task references.
- [ ] **Validate generated task definitions before preview.** Require context, requirements, and acceptance criteria; reject malformed, incomplete, ambiguous, or oversized output without mutating authoritative task or discussion state.
- [ ] **Add or update focused tests for discussion-to-task generation, malformed agent output, preview rendering, approval, rejection, and duplicate submission handling.**
- [ ] **Add integration coverage for API, Brain, database, UI client, activity events, and task mutation boundaries.**
- [ ] **Validate the current collaborative-planning surfaces against the established accessibility, responsive-layout, loading, empty, error, reconnect, keyboard-navigation, and reduced-motion requirements.**
- [ ] **Validate preview and approval behavior against API ownership and stale-client scenarios.** Confirm browser refreshes, multiple tabs, repeated clicks, expired previews, rejected previews, and concurrent approvals cannot corrupt authoritative state.
- [ ] **Run the complete focused and regression validation suite.** Include type checking, server tests, web tests, API integration tests, browser tests, migration tests, and a production web build using the commands recorded during baseline reconciliation.
- [ ] **Record implementation and acceptance evidence in the appropriate project task, acceptance, status, and changelog artifacts.**

### Acceptance Criteria

- [ ] The agent can generate a valid task definition from a discussion.
- [ ] A generated task definition contains context, requirements, and acceptance criteria.
- [ ] Users can preview proposed task changes and additions before mutation.
- [ ] Approval and rejection are explicit and durable.
- [ ] Duplicate, stale, malformed, and failed preparation requests do not corrupt task or discussion state.

### Dependencies

- Phase 4 baseline and contract reconciliation
- Phase 5: Status Reports and Human Oversight
- Phase 6: Progressive Planning and Durable Task Lifecycle
- Task-file references and canonical plan format

## Phase 8: Bug Tracking and Resolution

Bug tracking depends on formal status reports and progressive dependency blocking. It must preserve source, priority, assignment, blockers, evidence, and the investigation → fix → verification sequence without bypassing durable task passes.

### Problem

Arms may encounter compilation failures, test failures, runtime errors, and other bugs during execution. Humans may report issues that block progress. These issues must be tracked, prioritized, and resolved without losing work history.

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

- [ ] **Define bug report message types.** Support `arm_reported`, `human_reported`, and `system_detected` sources and retain priority, assignment, blockers, and resolution information.
- [ ] **Add the bug-tracking table.** Store bug status, priority, assignee, and blockers.
- [ ] **Implement Brain priority rules.**
- [ ] **Implement escalation for blocked tasks.** Escalate high-priority work, reassign isolated medium-priority work, and prevent dependent tasks from running while an unresolved blocking bug remains.
- [ ] **Implement the bug-resolution workflow.** Track investigation → fix → verification, including evidence and outcome.
- [ ] **Notify humans about critical and blocking bugs.**
- [ ] **Add API endpoints for bug management.**
- [ ] **Add UI for bug tracking and status.**
- [ ] **Ensure bug work uses task passes.** Do not create review or polish child tasks where the branch-centered lifecycle applies.
- [ ] **Test duplicate, concurrent, stale, and reopened bug reports.**
- [ ] **Preserve bug-to-task, bug-to-pass, bug-to-branch, and bug-to-commit relationships.**
- [ ] **Validate bug blocking and recovery against dependency, lease, approval, and human-review gates.**
- [ ] **Record bug-resolution acceptance evidence and operational recovery procedures.**

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

- Phase 5: Status Reports and Human Oversight
- Phase 6: Progressive Planning and Durable Task Lifecycle

## Phase 9: Agentic Brain

The Agentic Brain depends on task classification, progressive planning, formal status reports, bug handling, and the API-owned integration boundary. Migration must be incremental: retain the polling loop, add the agent and validated tools, replace one behavior at a time, and preserve deterministic fallback logic whenever the LLM or framework is unavailable.

### Goal

Transform Brain from a polling loop with hardcoded logic into an agentic AI system.

See [brain-agent-plan.md](./brain-agent-plan.md) for full implementation details.

### Architecture

```txt
Human Input → Brain Agent (LLM + Tools) → Arm Actions (via MCP/NATS)
                         ↓
                 SQLite / File System / MCP / NATS
```

### Framework

Use LangChain.js with:

- `createAgent` for the agent pattern.
- Tool calling with Zod schema validation.
- Memory/checkpointer support for conversation state.
- GPT-4.1 for reasoning.
- GPT-4.1 Codex for code tasks.

The model choice must remain configurable and must not be treated as an arm specialization decision.

### Deliverables

- [ ] **Confirm framework and model prerequisites.** Verify Bun compatibility, provider credentials, model configuration, token/cost limits, timeout behavior, and the fallback policy before integrating the dependency.
- [ ] **Integrate LangChain.js.** Configure `createAgent`, Zod-validated tool calling, memory/checkpoint support, GPT-4.1 reasoning, and GPT-4.1 Codex code tasks.
- [ ] **Implement the `BrainAgent` class.** Create the agent under the planned Brain agent structure and expose the nine tools above.
- [ ] **Add the Brain agent system prompt.** Define how the agent reads project state, respects human approval gates, and communicates decisions.
- [ ] **Implement all nine Brain agent tools.**
- [ ] **Add memory and checkpoint support.**
- [ ] **Retain fallback logic.** On LLM/framework failure, use deterministic logic without losing task or state updates.
- [ ] **Add the system-alignment control loop.** Compare project state with the plan and take corrective actions while enforcing human approval gates.
- [ ] **Optimize polling and busy-arm handling.** Adjust polling frequency and add arm `busy` status so active arms are not interrupted.
- [ ] **Add vector search for arm context history.** Store searchable arm conversation history for relevant prior context.
- [ ] **Align agent actions with the branch-centered lifecycle.** Deterministic lease, dependency, review, merge, and approval rules remain authoritative.
- [ ] **Preserve general-purpose arm behavior.** Never select arms by domain, expertise, or arm-global reputation.
- [ ] **Add timeout, retry, cost, rate-limit, cancellation, and observability controls.**
- [ ] **Test deterministic fallback under unavailable-model, malformed-tool, timeout, and partial-write conditions.**
- [ ] **Run staged integration and shadow evaluation before replacing production decisions.** Compare agent recommendations with deterministic decisions, record disagreements, and require an explicit cutover decision.
- [ ] **Document rollback from agent decisions to deterministic orchestration.**

### Agent Tools

The Brain agent exposes:

1. `readPlan(planId?: string): PlanDocument`
2. `getTaskHistory(options): Task[]`
3. `getStatusReports(options): StatusReport[]`
4. `getDiscoveries(options): Discovery[]`
5. `determineNextTask(options): NextTask`
6. `assignTask(task: Task, armId: string): void`
7. `storeDiscovery(discovery: Discovery): void`
8. `sendToHuman(message): void`
9. `getArmStatus(armId?: string): ArmStatus[]`

Each tool must validate inputs and outputs, enforce API ownership, and avoid bypassing deterministic lifecycle safeguards.

### Migration Strategy

1. Create `src/brain/agent/`.
2. Implement the agent and tools.
3. Replace functions one at a time:
   - `determineNextTask()` → use the agent.
   - `handleDiscovery()` → use the agent.
   - `handleHumanMessage()` → use the agent.
4. Keep the polling loop as the orchestrator.
5. Retain deterministic fallback behavior and provide an operational rollback path.

### Dependencies

- Phase 3: Task Classification and Context
- Phase 5: Status Reports and Human Oversight
- Phase 6: Progressive Planning and Durable Task Lifecycle
- Phase 8: Bug Tracking and Resolution

### Acceptance Criteria

- [ ] The agent makes reasonable task determinations.
- [ ] Discoveries are properly stored and surfaced.
- [ ] Human messages receive appropriate responses.
- [ ] Stuck arms are detected and handled.
- [ ] Fallback logic works when the LLM is unavailable.

## Phase 10: Context Compression

This phase depends on classification-specific context, the Agentic Brain, harness integration, and searchable arm history. Reinjection must preserve the current task’s identity and context without assigning permanent arm specialization.

### Goal

Configure context-size limits and automatically re-inject task context after compression so agents remain focused on Brain directives.

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

### Deliverables

- [ ] **Add Brain context-compression configuration.**
- [ ] **Add the reinjection prompt template.**
- [ ] **Add the compression-reporting MCP tool.** Register `report_context_compression` with datetime, original token count, compressed token count, and retention summary fields, then send the event to the Brain with arm ID.
- [ ] **Detect compression and reinject context.**
- [ ] **Document harness-specific configuration.**
- [ ] **Test context-compression scenarios.** Cover threshold and hard-limit behavior, reinjection, disabled reinforcement, event parsing, and retention summaries.
- [ ] **Filter tools by task specialization.** Select and filter available tools based on task classification to prevent context overload while preserving general-purpose arms.
- [ ] **Add vector-backed arm conversation history.** Store arm conversation history in a vector database and provide configurable retention.

### Dependencies

- Phase 3: Task Classification and Context
- Phase 9: Agentic Brain

## Phase 11: NATS JetStream Event Sourcing

This phase migrates event persistence and state reconstruction incrementally. It depends on verified NATS integration, API boundary behavior, and status-report/event schemas. Dual-write, replay, backup, compatibility, and performance validation are mandatory before removing SQLite event storage.

### Overview

Migrate from SQLite-based event storage to NATS JetStream for event persistence, enabling event-sourcing patterns for state reconstruction and audit trails.

### Current State

- Events stored in SQLite `arm_events` table.
- Events published by harnesses via `emitEvent()`.
- Events queried via API endpoints.
- No event-sourcing patterns implemented.

### Target State

- Events persisted in NATS JetStream streams.
- State derived from event streams.
- Comprehensive API for event querying and state reconstruction.
- Real-time event processing and historical analysis.

### Deliverables

- [ ] **Approve the event-sourcing boundary.** Preserve SQLite for complex query state, Maildir for messages, plans for version-controlled documents, and configuration for human-editable TOML unless an explicit decision changes a boundary.
- [ ] **Enable JetStream on the NATS server.** Configure required flags, file storage, memory/file limits, and persistent volume.
- [ ] **Integrate the JetStream client.** Initialize `JetStreamClient` and `JetStreamManager`, ensure the event stream exists, and preserve retention and subject strategy.
- [ ] **Standardize event schemas.**
- [ ] **Migrate harness event publishing.**
- [ ] **Implement question event handling.**
- [ ] **Implement task state reconstruction.**
- [ ] **Implement arm state reconstruction.**
- [ ] **Implement activity analysis.**
- [ ] **Add event-query routes.**
- [ ] **Migrate Brain state queries incrementally.** Retain SQLite fallback during transition.
- [ ] **Migrate activity detection.**
- [ ] **Migrate status-report processing.**
- [ ] **Add push and pull consumer strategies.**
- [ ] **Add state caching.**
- [ ] **Add batch operations.**
- [ ] **Run dual-write and backup procedures.**
- [ ] **Replay and compare reconstructed state against SQLite state.**
- [ ] **Test retention, replay, ordering, duplicate delivery, consumer recovery, and malformed events.**
- [ ] **Remove old SQLite event tables only after migration acceptance.**
- [ ] **Document event schemas, replay, retention, backup, consumers, and rollback.**

### Event Type Standardization

```txt
"arm.spawned" | "arm.status_changed" | "arm.killed" | "arm.heartbeat"
"task.assigned" | "task.claimed" | "task.completed" | "task.blocked"
"status_report.submitted" | "status_report.processed"

"message.sent" | "message.received"
"tool.invoked" | "tool.completed" | "tool.failed"
"file.created" | "file.modified" | "file.deleted"
"session.compacted" | "session.created" | "session.error"

"question.asked" | "question.replied" | "question.rejected"

"brain.task_determined" | "brain.status_analyzed"
"discovery.created" | "plan.updated"
```

### Question Event Format

```typescript
interface QuestionAskedEvent {
  type: "question.asked";
  properties: {
    id: string;
    sessionID: string;
    questions: QuestionInfo[];
    tool?: {
      messageID: string;
      callID: string;
    };
  };
}

interface QuestionInfo {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
}
```

**Brain Response Events:**

- `question.replied`: Human answered the question.
- `question.rejected`: Question was rejected/ignored.

**Brain Action Required:**

When the Brain detects a `question.asked` event from any arm, it should:

1. Parse the question content and options.
2. Evaluate whether it can answer autonomously or needs human input.
3. Either respond directly or escalate to a human.
4. Track the question-response cycle for learning.

### Dependencies

- Phase 1: Core Infrastructure and API Boundary
- Phase 5: Status Reports and Human Oversight
- Phase 9: Agentic Brain
- Approved event-sourcing boundary decision

### Acceptance Criteria

- [ ] All Brain database queries for state are replaced with event queries.
- [ ] WebSocket real-time updates work via JetStream consumers.
- [ ] API endpoints return event-sourced data.
- [ ] State reconstruction works for tasks and arms.
- [ ] Query performance is under 100ms and reconstruction performance is under 500ms.
- [ ] No data loss occurs during migration.
- [ ] Backward compatibility is maintained during transition.

## Phase 12: Global Status History Search

This phase depends on formal status reports, JetStream event ingestion, the Agentic Brain, embedding infrastructure, and the approved vector-database deployment decision. Qdrant is the recommended choice and must be explicitly verified before production coupling.

### Goal

Provide searchable full-text history of arm status messages and completions through vector-database indexing.

### Architecture

```txt
Arms → Status Reports → NATS JetStream → Consumer
                                      ↓
                                Vector DB
                                      ↓
                                Search API
                                 ↙     ↘
                              Users    Brain
```

### Deliverables

- [ ] **Decide and document the production vector database.** Compare SQLite + sqlite-vss, LanceDB, Chroma, and Qdrant. The recommendation is Qdrant from the start because it is production-ready, supports filtered search, fits the distributed NATS/API architecture, and can run as a container.
- [ ] **Add the NATS JetStream status-event consumer.**
- [ ] **Integrate Qdrant.**
- [ ] **Generate embeddings.**
- [ ] **Add the hybrid search API.**
- [ ] **Add the historical-search MCP tool.**
- [ ] **Add the status history search page.**
- [ ] **Add the dashboard notable-events widget.**
- [ ] **Implement the retention policy.**
- [ ] **Add a backfill script.**
- [ ] **Validate embedding failures, duplicate events, stale indexes, retention deletion, filters, pagination, and access control.**

### Search Capabilities

- Semantic search, such as “problems with database migrations”.
- Filtered search by arm, date, event type, task, and classification.
- Exact full-text search, such as `error: SQLITE_BUSY`.
- Hybrid search combining semantic ranking and filters.

### API

```txt
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
    description:
      "Search historical status reports and completions from all arms",
    inputSchema: {
      query: z.string().describe("Natural language search query"),
      filters: z.object({
        arm_ids: z.array(z.string()).optional(),
        event_types: z.array(
          z.enum([
            "status_report",
            "task_completed",
            "discovery",
            "bug_reported",
          ]),
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
  },
);
```

### Retention Policy

| Event type | Retention | Rationale |
|---|---:|---|
| Task completions | Forever | Critical audit trail |
| Status reports | 90 days | Useful for debugging |
| Routine heartbeats | 7 days | High volume and low value |
| Critical events | Forever | Important history |

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

- Phase 5: Status Reports and Human Oversight
- Phase 9: Agentic Brain
- Phase 11: NATS JetStream Event Sourcing

## Phase 13: Code Graph and Navigable Context

This phase depends on stable workspace access, SQLite utilities, API/MCP boundaries, and Brain context retrieval. The graph must represent actual current code structure, update incrementally, and remain useful when source files change between indexing and task assignment.

### Deliverables

- [ ] **Add a Tree-sitter code scanner.** Regularly index the workspace using Tree-sitter and update incrementally where possible.
- [ ] **Store the graph in SQLite.** Represent files, symbols, and definitions as nodes, and imports, calls, references, and containment as edges.
- [ ] **Add graph-query API endpoints.**
- [ ] **Add the code-navigation MCP tool.** Support find definition, find references, and dependency-chain traversal.
- [ ] **Integrate graph context with the Brain.**
- [ ] **Add incremental invalidation and recovery.** Handle deleted, renamed, malformed, or partially written files without serving stale authoritative relationships.
- [ ] **Add graph indexing and query benchmarks.**
- [ ] **Validate graph context against current file contents before task assignment.**

### Acceptance Criteria

- [ ] Graph updates automatically on file changes and are queryable within seconds.
- [ ] Agents can navigate from a file to related symbols and dependencies through MCP.
- [ ] The Brain can attach graph-derived context snippets to task payloads.
- [ ] Graph data is persisted in SQLite and survives restarts.

### Dependencies

- Phase 1: Core Infrastructure and API Boundary
- Phase 3: Task Classification and Context
- Phase 6: Progressive Planning and Durable Task Lifecycle

## Phase 14: Governance

This phase depends on the resolved governance architecture decision from Phase 0, durable tasks and passes, status/discovery history, and human approval handling. Governance must use proposals, arguments, signals, and evidence without reintroducing arm domains or unapproved arm-global reputation routing.

### Goal

Arms debate and reach consensus on plans and changes through proposals, arguments, and signals rather than human-maintained merge-request workflows.

### Deliverables

- [ ] **Add the proposal system.** Support proposals for `deploy`, `claim`, `refactor`, `dependency`, `breaking_change`, and `creative_override`. Retain subject, task relationship, arguments, signals, and outcome.
- [ ] **Tie arguments and signals to tasks and classifications.**
- [ ] **Calculate consensus dynamically.** Use the Phase 0 governance decision for evidence, argument quality, human-provided weights, task context, and approved trust annotations.
- [ ] **Add reputation tracking and enforcement hooks.** Store reputation information and allow Brain use only if the Phase 0 decision explicitly approves it. Otherwise use proposal- or signal-level evidence.
- [ ] **Add the creative-override flow.** Require a clear rollback plan.
- [ ] **Add emergency-stop (“andon cord”) handling.**
- [ ] **Transition to task configuration templates.** Templates define defaults for tools, context bundles, safety rules, and governance expectations; remove or update MR-style templates that reference fixed arm or MR roles.
- [ ] **Allow direct Brain plan updates with proposal-controlled arm changes.**
- [ ] **Record governance decisions durably.**
- [ ] **Test quorum, conflict, rejection, override, rollback, human escalation, and emergency-stop behavior.**

### Dependencies

- Phase 0 governance decision
- Phase 5: Status Reports and Human Oversight
- Phase 6: Progressive Planning and Durable Task Lifecycle
- Phase 9: Agentic Brain

## Phase 15: Garden Visualization

This phase depends on stable workspace events, ownership/claim data, WebSocket or JetStream updates, and the Observatory rendering foundation. It provides visualization only; it must not become an unverified source of task or ownership truth.

### Deliverables

- [ ] **Integrate React Three Fiber.**
- [x] Add a radial coordinate system.
- [ ] **Display real-time file activity.**
- [ ] **Add ownership coloring.**
- [ ] **Highlight conflict zones.**
- [x] Add interactive navigation.
- [x] Generate octopus avatars for arms with reuse logic and color/personality traits.
- [x] Add a Brain mascot with personality and animation.
- [ ] **Define stale-event and disconnected-state rendering.**
- [ ] **Validate that Garden state is read-only and consistent with API/event authority.**

### Dependencies

- Phase 2: Observatory Foundation Verification and Enhancements
- Phase 6: Durable claims and passes
- Phase 11: Event delivery

## Phase 16: Agent Harnesses

This phase depends on the API boundary, durable lifecycle, event handling, and the production deployment decision. Harnesses must remain pluggable, restart-aware, and compatible with general-purpose arms. Daemon-managed harnesses must be launched through ArmAgent so sessions survive API restarts.

### Goal

Support multiple AI agents through pluggable harnesses with restart-resilient lifecycle management.

### Current Status

Implemented harnesses:

- `opencode-api` (HTTP)
- `opencode` (PTY)
- `opencode-tui` (visual terminal plus API)

Lifecycle policy:

- `opencode-api` and `opencode` are daemon-managed and should be launched through `ArmAgent` so sessions survive API restarts.
- `opencode-tui` can remain a local/operator mode where persistence across API restarts is less critical.

### Phase 16.1: Daemon-First Harness Routing

#### Deliverables

- [ ] **Add API-restart regression tests.** Verify that an arm survives an API restart, prompts still route to the surviving session, and claims remain valid. Cover daemon-managed `opencode-api` and `opencode`.

### Phase 16.2: ACP Integration

**Goal**: Add an ACP adapter layer so Coleo can interoperate with external clients, including Claude Code and Codex CLI, without hard-coding each harness.

#### Deliverables

- [ ] **Implement the ACP handshake.** Support `initialize`, version negotiation, and capability negotiation.
- [ ] **Map core ACP methods to harness actions.** Support `session/new`, `session/load`, `session/prompt`, `session/cancel`, and `session/set-mode`.
- [ ] **Support ACP authorization callbacks.** Handle `acp/fs/read-text-file` and `acp/fs/write-text-file`.
- [ ] **Add ACP transports incrementally.** Start with ACP `stdio`, then add Streamable HTTP/SSE.
- [ ] **Define `AcpHarnessAdapter`.** Map `spawn`, `prompt`, `interrupt`, and `state`.
- [ ] **Support session attach and resume.**
- [ ] **Document ACP compatibility.**
- [ ] **Add ACP conformance tests.**

### Future Work: Phase 18+

- [ ] Add more harnesses and protocol adapters beyond OpenCode.
- [ ] Improve PTY/TUI session reattachment and persistence.
- [ ] Add placement policies based on capabilities, load, and affinity for multi-agent scheduling.

### Dependencies

- Phase 1: Core Infrastructure and API Boundary
- Phase 6: Progressive Planning and Durable Task Lifecycle
- Phase 11: NATS JetStream Event Sourcing
- Phase 0 production deployment decision

## Phase 17: Budget Planning and Burn Rate Estimation

This phase depends on Observatory usage data, OpenCode provider/model integration, task classifications, and verified cost events. It must not route tasks by cost until model preferences, banned models, pricing freshness, and budget enforcement semantics are defined and tested.

### Goal

Enable long-running autonomous operation with predictable costs through model cost tracking, burn-rate estimation, and budget forecasting.

### Model Preference Configuration

```toml
[models]
preferred = ["claude-sonnet-4", "gpt-4.1", "grok-code"]
banned = ["gpt-3.5-turbo", "claude-haiku"]

[models.overrides]
architect = ["claude-sonnet-4"]
qa = ["grok-code", "gpt-4.1-mini"]
documentation = ["grok-code"]
```

The preferred list is ordered, with the first model preferred and the last as fallback. Banned models must never receive work.

### Deliverables

- [ ] **Add historical model-price tracking.**
- [ ] **Refresh prices from OpenCode.** Fetch current prices through `GET /provider`, preserve historical records, and identify source.
- [ ] **Calculate burn rate from recent activity.**
- [ ] **Add budget forecasting.**
- [ ] **Add model-preference configuration.**
- [ ] **Route tasks by classification and cost** without treating model choice as arm specialization.
- [ ] **Add the budget dashboard widget.**
- [ ] **Add the budget-planning page.**
- [ ] **Add the cost-aware model selector.**
- [ ] **Add optional budget-enforcement policies.**
- [ ] **Detect price changes and alert users.**
- [ ] **Add budget API endpoints.**
- [ ] **Test pricing freshness, banned-model enforcement, forecast accuracy, budget races, pause behavior, and failure recovery.**

### Dependencies

- Phase 2: Observatory Foundation Verification and Enhancements
- Phase 3: Task Classification and Context
- OpenCode API integration
- Verified cost/event data

### Acceptance Criteria

- [ ] Users can set daily and weekly budgets.
- [ ] Burn rate updates in real time from actual usage.
- [ ] Budget forecasts are within 20% of actual spend.
- [ ] Price changes are detected and estimates are updated.
- [ ] Model preference ordering is respected.
- [ ] Banned models never receive work.
- [ ] The UI clearly shows cost and quality tradeoffs.

## Phase 18: Additional Architecture and Persistence Integration

These concerns cross multiple phases and must be implemented only after the relevant boundaries are stable. They preserve the distinction between durable project artifacts, SQLite query state, event history, and Maildir communication.

### NATS JetStream Event Sourcing

Some current-state data is better modeled as derived state from an event stream. NATS JetStream provides:

- Append-only event logs with configurable time, size, and count retention.
- A key-value store for derived state snapshots.
- Replay to rebuild state from the stream.

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
- Humans can reply with feedback or corrections.

### Deliverables

- [ ] **Implement task-file dependency/output tracking.**
- [ ] **Implement output existence and content verification.**
- [ ] **Document event-sourcing boundaries and rollback.**
- [ ] **Migrate approved status-report flows to Maildir.**
- [ ] **Preserve compatibility with existing `.project/status-*.md` records during migration.**
- [ ] **Add integration tests for task files, Maildir reports, event-derived state, and SQLite query state.**

### Dependencies

- Phase 5: Status Reports and Human Oversight
- Phase 6: Progressive Planning and Durable Task Lifecycle
- Phase 11: NATS JetStream Event Sourcing
- Approved persistence-boundary decisions

## Phase 19: Adaptive Card Collections and Customizable Widget Dashboards

Muuri makes more sense than Isotope if those are the only choices, but neither should be Coleo’s universal card layer.

### Rationale

- Sorting and filtering already happen correctly in React through `projectResourceCollection()` in `resource-sheet-model.ts`. A layout library should not duplicate that state.
- `AdaptiveCardCollection` already preserves accessible row-major DOM order with CSS Grid.
- Isotope has no built-in drag support and its GPL-3.0 option does not fit Coleo’s BUSL license without purchasing a commercial license.
- Muuri is MIT-licensed, typed, and draggable, but it is an imperative absolute-positioning engine whose latest npm release is from 2021. Its DOM manipulation and pointer-oriented drag model add risk with React StrictMode, live updates, variable-height Adaptive Cards, and keyboard accessibility.
- Coleo already includes `dnd-kit` and Framer Motion.

### Architecture

#### Record Card Collections

- [ ] Keep React as the sole source of sorting and filtering.
- [ ] Keep CSS Grid and row-major visual order.
- [ ] Add subtle position, enter, and exit animation to `AdaptiveCardCollection` with Framer Motion’s lightweight `LazyMotion` path.
- [ ] Respect reduced motion and disable expensive layout animation for large or rapidly updating collections.
- [ ] Apply ordered animated collection behavior to Tasks, Bugs, Processes, Inbox, Arms, and other genuinely sortable or filterable record collections.
- [ ] Do not make record cards draggable unless a future explicit `Manual order` sort is selected.

#### Structured Widget Grid

- [ ] Add a reusable `WidgetGrid` under `src/web/src/workbench/`.
- [ ] Use CSS Grid for responsive placement and `dnd-kit` for drag ordering.
- [ ] Enable dragging only inside an explicit **Customize dashboard** mode.
- [ ] Restrict dragging to dedicated handles so charts, links, inputs, and Adaptive Card actions remain usable.
- [ ] Support keyboard reordering, screen-reader announcements, and visible move commands.
- [ ] Support controlled presets such as single, double, or full width and auto, compact, or tall height.
- [ ] Include collapse, hide/show, reset, and restore-default actions.

#### Profile-Backed Persistence

- [ ] Use existing `useViewPreferences()` and `workbench_views` infrastructure with `kind: "dashboard"`.
- [ ] Store only layout configuration in `preferences.extras`; do not persist fetched metric or card payloads.
- [ ] Version the stored layout schema and normalize it against the current widget registry so new widgets are appended and removed widgets are ignored.
- [ ] Commit order only when a drag ends rather than during every pointer movement.
- [ ] Avoid a database migration or new endpoint unless later requirements exceed the existing saved-view model.

#### Per-Profile Templates

- [ ] Add `dashboard.main` for the main system dashboard.
- [ ] Add `dashboard.brain` for Brain status and configuration.
- [ ] Add `dashboard.arm-telemetry`, shared by fleet telemetry and every Arm Viewer instance.
- [ ] Add `dashboard.task-insights`, shared across Task burndown and activity panels.
- [ ] Add the corresponding Bug insights template because Bugs mirrors Tasks and should not remain inconsistent.

### Surface Migration

- [ ] **Main dashboard:** Expose infrastructure, plan status, runtime hosts, Arms, operational inbox, task progress, and burndown as individually keyed widgets. Keep critical setup warnings pinned and non-hideable.
- [ ] **Brain:** Make status and configuration reorderable. Keep model-access and planning-gate alerts pinned.
- [ ] **Arm telemetry:** Keep date-range controls pinned and arrange Activity, Context, and Cost charts through the shared template.
- [ ] **Task and Bug insights:** Preserve existing toolbar toggles while moving internal cards and charts onto the widget grid.
- [ ] **Static surfaces:** Keep settings forms, detail cards, discussions, diffs, and live chronological streams semantically fixed.

### Sorting Consistency

- [ ] Lift Process saved sort and filter preferences out of `ProcessSheet` so card and sheet modes use the same projected collection.
- [ ] Audit other card and sheet pairs for the same consistency requirement.
- [ ] Ensure DOM order always equals the selected sort order; animation must remain purely visual.
- [ ] Ensure filtered cards are unmounted rather than visually hidden with focusable controls remaining in the DOM.

### Delivery Sequence

1. Implement and unit-test the widget-layout preference model and normalization logic.
2. Add ordered card transition behavior to `AdaptiveCardCollection` without changing its data ownership.
3. Implement the responsive `WidgetGrid`, customization mode, keyboard interactions, and saved-view hook.
4. Pilot the grid on the main Dashboard and validate resizing inside Golden Layout.
5. Roll it out to Brain, Arm telemetry, Task insights, and Bug insights.
6. Fix Process card/sheet projection consistency and audit remaining record collections.
7. Update Workbench documentation and record the final interaction and persistence contracts.

### Acceptance Criteria

- [ ] Sorting and filtering are performed by React before rendering, and visual animation never becomes the source of collection state.
- [ ] Record card DOM order matches visual and keyboard order before, during, and after transitions.
- [ ] Record cards are not draggable in normal collection views.
- [ ] Dashboard widgets are draggable only in customization mode and only from explicit handles.
- [ ] Dashboard widgets can be reordered, hidden, restored, collapsed, and assigned supported size presets.
- [ ] Pointer and keyboard users can perform equivalent widget-ordering actions.
- [ ] Main Dashboard, Brain, Arm telemetry, and Task and Bug insights persist separate per-profile templates.
- [ ] The Arm telemetry template is shared across fleet and per-Arm embedded views rather than stored per Arm.
- [ ] Narrow containers collapse safely to one column, while unsupported saved spans are clamped without corrupting preferences.
- [ ] Newly introduced widgets appear in an existing saved layout, and removed widget identifiers do not break rendering.
- [ ] Dynamic Adaptive Card height changes, compact/detail switching, and live additions or removals do not produce overlapping cards.
- [ ] Reduced-motion users receive immediate layout changes without movement animation.
- [ ] Customization remains usable inside resizable and duplicated Golden Layout panels.

### Verification

- [ ] Unit-test widget-state normalization, ordering, hiding, sizing, defaults, and schema upgrades.
- [ ] Add Playwright coverage for pointer and keyboard reordering, reload persistence, profile switching, reset, mobile collapse, and Golden Layout resizing.
- [ ] Test Adaptive Card height changes, compact/detail switching, live additions and removals, focus retention, and non-overlapping animated layouts.
- [ ] Verify that ordinary sort/filter operations leave DOM order canonical and filtered controls cannot receive focus.
- [ ] Run `bun run typecheck`.
- [ ] Run `bun run --cwd src/web lint`.
- [ ] Run the relevant unit and Playwright suites.
- [ ] Run `bun run web:build` and confirm animation and drag dependencies do not introduce avoidable eager bundle cost.

The persisted widget model must remain independent from a specific rendering engine. If Coleo later needs dense masonry, cross-grid transfers, or a pointer-heavy free-placement canvas, Muuri can be evaluated behind the widget layer without rewriting user preferences. For ordered grids and structured dashboards, CSS Grid, Framer Motion, and `dnd-kit` are the preferred implementation.

### Dependencies

- Phase 2: Observatory Foundation Verification and Enhancements
- Stable profile and workbench persistence
- Verified accessibility and frontend validation contracts

## Phase 20: Remaining Brain-Created Tasks

These tasks were documented by the Brain and remain in scope. They depend on the API boundary, durable claims and passes, task handoff semantics, and safe development-server controls.

### Deliverables

- [ ] **Provide arm access to development-server logs and restart control.** Research existing solutions, including MCP servers, then implement log access and development-server restart control. Coordinate destructive operations through the Brain rather than allowing unreviewed direct actions.
- [ ] **Add thrashing detection for lazy claims.** Detect when arms are fighting over files, implement a lazy claim-release protocol, and throttle rapid reclaims.
- [ ] **Add the handoff protocol between arms.** Define graceful task handoff, include context transfer, and handle abandoned tasks and conflicts without losing task state or work history.
- [ ] **Test restart, abandoned-pass, handoff, claim-release, and conflict-recovery paths.**

### Dependencies

- Phase 1: Core Infrastructure and API Boundary
- Phase 4: Collaborative Planning and Task Refinement
- Phase 6: Progressive Planning and Durable Task Lifecycle

## Phase 21: Regular Refactoring Cycle

This phase is a cross-cutting maintenance capability and may run after relevant Brain, claims, and task lifecycle foundations are available. Refactoring must never begin against uncommitted target files or active claims, and oversized-file blocking must not overwrite unrelated task state.

### Goal

Keep files small enough for LLM context windows through periodic refactoring.

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
|---:|---|
| >400 lines | Flag for refactoring |
| >600 lines | High-priority refactoring |
| >800 lines | Critical; block new work on the file until refactored |

### Deliverables

- [ ] **Track completed-task count in the Brain.** Increment count when a task completes and preserve it across the relevant Brain lifecycle.
- [ ] **Implement `findLargeFiles()`.**
- [ ] **Add the refactoring task classification.**
- [ ] **Add prerequisite verification to the template.**
- [ ] **Add configurable file-size thresholds.** Default flagging threshold 400 lines; preserve >600 high-priority and >800 critical rules.
- [ ] **Escalate oversized files.**
- [ ] **Integrate refactoring with claims.**
- [ ] **Ensure generated refactoring tasks obey the canonical single-next-task and dependency gates.**

### Dependencies

- Phase 6: Progressive Planning and Durable Task Lifecycle
- Claims system

## Phase 22: Notifications and Deployment

This phase depends on the production deployment decision, governance proposal flow, authentication/security boundaries, and verified event delivery. Deployment work must include pause, rollback, monitoring, and durable governance evidence before production traffic changes.

### Deliverables

- [ ] **Add browser push notifications.** Notify users about relevant project, arm, status, bug, governance, and deployment events.
- [ ] **Add the deployment proposal flow.** Route deployment requests through governance and preserve the resulting decision.
- [ ] **Add blue/green deployment support.**
- [ ] **Add rollback with pause.** Pause relevant work when rollback is required and retain the rollback outcome.
- [ ] **Add monitoring integration hooks.**
- [ ] **Test notification permissions, delivery failures, deployment pauses, rollback, health checks, and traffic restoration.**

### Dependencies

- Phase 0 production deployment decision
- Phase 11: Event delivery
- Phase 14: Governance
- Verified authentication and security boundaries

## Phase 23: Production Readiness

This phase is last because it depends on architecture, lifecycle, event, deployment, security, harness, and UI work above. It must be validated in the selected production target from Phase 0 and include failure-path testing rather than only happy-path builds.

### Goal

Produce a production-ready system.

### Deliverables

- [ ] **Add PostgreSQL support.** Provide the production database option while preserving required data and query behavior.
- [ ] **Add a comprehensive test suite.** Cover production system, orchestration behavior, APIs, harnesses, UI integration points, and failure paths.
- [ ] **Optimize performance.** Improve slow orchestration, database, API, search, and UI operations without changing required behavior.
- [ ] **Harden security.** Strengthen authentication, authorization, data handling, tool access, deployment controls, and production boundaries.
- [ ] **Add Docker Swarm support.**
- [ ] **Write user documentation.** Document setup, configuration, communication modes, arm operation, planning, governance, deployment, and troubleshooting.
- [ ] **Evaluate the PTY harness.** Reassess the PTY harness and record whether it is suitable for production use.
- [ ] **Run release validation.** Verify installation, migration, backup/restore, deployment, rollback, notifications, monitoring, API authentication, WebSocket behavior, harness restart resilience, and acceptance criteria in the selected deployment target.
- [ ] **Run disaster-recovery validation.** Test dependency outage, database failure, NATS failure, Qdrant failure, model outage, stale leases, interrupted deployment, and operator recovery.
- [ ] **Publish release evidence.** Update `.project/status.md`, acceptance records, changelog, deployment documentation, known limitations, and rollback instructions.

### Dependencies

- All preceding phases
- Approved production deployment target
- Completed release and disaster-recovery validation plan

## Milestones

| Milestone | Target | Description |
|---|---|---|
| M1: Observable | End of Phase 2 | See arm activity in the web UI |
| M2: Coordinated | End of Phase 14 | Arms negotiate and reach consensus |
| M3: Visual | End of Phase 15 | 3D Garden shows workspace state |
| M4: Agentic | End of Phase 9 | Brain uses agentic decision making |
| M5: Production | End of Phase 23 | Ready for real use |

Harness strategy is daemon-first for resilient lifecycles, with protocol adapters such as ACP planned for broader client interoperability.

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
