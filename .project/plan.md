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

## Phase 0: Planning, Architecture, and Execution Preconditions

This phase establishes the authoritative planning model, resolves architectural conflicts, and verifies repository/runtime assumptions before any feature work is assigned. Existing filenames, modified files, generated artifacts, and tests must not be treated as proof that implementation is complete.

The current workspace contains changes across Cloudflare and hosting entrypoints, onboarding and Arms UI/API code, migration catalog code, image-tag and repository-preparation scripts, end-to-end coverage, onboarding tests, and newly added workspace-startup, arm-host, repository-preparation, and arm-context-defaults modules/tests. These paths are inventory evidence only; their behavior must be inspected and validated before being treated as delivered.

Phase 0 is also the planning gate for all later phases. It must establish the authoritative command set, service topology, persistence boundaries, deployment target, rollback posture, task dependencies, and concurrent-work controls before technical implementation tasks can be claimed.

### Deliverables

- [ ] **Inventory the current implementation before assignment.** Read the complete canonical plan, explicitly linked sub-plans, requirements, decisions, acceptance documents, relevant source modules, tests, configuration, deployment files, and current Git status. Treat `.project/plan.md` and only the sub-plans explicitly referenced from it as authoritative for progressive planning.
- [ ] **Inspect the current workspace changes before feature assignment.** Review the modified and untracked files reported by Git, including `docker/prepare-repository.sh`, Cloudflare and hosting entrypoints, onboarding routes and tests, migration catalog and arm-context-defaults migration/tests, Cloudflare image-tag and preparation tests, `App.tsx`, `ProjectOnboarding.tsx`, `ArmsPage.tsx`, API helpers, `WorkspaceConnectionNotice`, `WorkspaceStartup`, arm-host hooks/libs/components, and workspace-startup tests. Distinguish verified behavior from merely present files.
- [ ] **Record the current baseline.** Run the documented install, typecheck, lint, unit-test, web-build, integration-test, and end-to-end validation commands where available. Record failures, environment prerequisites, changed files, generated files, and known gaps in a status report before assigning feature work.
- [ ] **Confirm the runtime and primary application stack.** Preserve the existing decisions for Bun, Hono, React/Vite, SQLite, NATS, API-key authentication, and shadcn/ui, and verify conformity with decisions/001, decisions/003, and decisions/004.
- [ ] **Decide and document the production deployment target.** Compare the existing self-hosting, Docker, Cloudflare, and planned Docker Swarm paths. Record which target is authoritative for production, which targets are local or transitional, and compatibility requirements before production deployment work begins.
- [ ] **Decide and document vector-search deployment and embedding boundaries.** Before Phase 12 couples production behavior to Qdrant, decide whether Qdrant is approved for the selected deployment target, identify its persistent-volume, authentication, network, backup, retention, access-control, cost, and outage-recovery requirements, and record the approved embedding provider, data-handling restrictions, fallback behavior, and rollback path. Qdrant remains a recommendation rather than an approved production dependency until this decision is recorded.
- [ ] **Reconcile arm identity, reputation, and governance requirements.** Arms are general-purpose and must not use arm-global reputation or domain routing. Phase 14 governance references reputation-based consensus and reputation tracking. Add an architectural decision resolving this conflict before governance implementation; do not silently preserve arm specialization or reputation-based selection.
- [ ] **Reconcile task lifecycle models.** Use the branch-centered iterative task lifecycle as the authoritative lifecycle for implementation, review, polish, human review, and merge. Preserve progressive planning’s single-next-task model while ensuring review and polish are passes on the original task rather than generated child tasks.
- [ ] **Reconcile Agentic Brain boundary descriptions.** Preserve Phase 9’s API-first requirement and resolve the apparent conflict between its diagram/tool descriptions that mention direct SQLite, file system, MCP, and NATS access and the requirement that the Brain Agent must not bypass the verified boundary to access NATS, JetStream, harnesses, task state, or external side effects directly. Record which API or mediated interfaces each Brain tool may use before Agentic Brain implementation begins.
- [ ] **Reconcile production persistence sequencing.** Document how the Phase 23 PostgreSQL option relates to the Phase 0 SQLite source-of-truth decision, Phase 6 SQLite consolidation, selected production target, migration safety requirements, and any future database portability work. Do not begin PostgreSQL support or treat it as a production prerequisite until the approved production persistence posture is explicit.
- [ ] **Define source-of-truth boundaries.** Confirm that plan documents remain human-editable and version controlled, Maildir remains the interoperable communication store, SQLite remains the queryable application state store unless an approved event-sourcing migration changes a specific boundary, and NATS JetStream is used only according to the approved migration plan.
- [ ] **Define task-file dependency and output tracking.** Establish how tasks reference acceptance criteria, decisions, plans, source files, context files, and output files, including verification of outputs before completion.
- [ ] **Define assignment and approval gates.** No task may be assigned until prerequisites are complete. Represent unresolved dependencies, active leases, file claims, human approval gates, and status-report-created verification or clarification work explicitly.
- [ ] **Create or update the canonical status record.** Maintain `.project/status.md` as the human-facing record of current phase, verified capabilities, known gaps, blockers, links to plans and acceptance documents, and validation evidence.
- [ ] **Define validation and delivery commands.** Identify the authoritative commands for repository installation, formatting, linting, type checking, unit tests, integration tests, browser tests, documentation builds, production builds, migrations, and deployment smoke tests. Record environment variables, services, ports, fixtures, cleanup requirements, and expected outputs.
- [ ] **Define change isolation and ownership rules.** Confirm branch, worktree, claim, lease, generated-file, migration, and concurrent-edit rules before assigning work to multiple arms.
- [ ] **Define rollback and migration safety.** Document backup, restore, rollback, dual-write, feature-flag, and failure-recovery expectations for schema, event, deployment, and persistence changes.
- [ ] **Verify the workspace-startup and repository-preparation contract.** Determine the intended relationship between onboarding, `docker/prepare-repository.sh`, Cloudflare/hosting entrypoints, workspace connection notices, startup state, arm-host discovery, and migration defaults. Add or update documentation and failure-path tests without assuming the newly present files already satisfy the contract.
- [ ] **Stage status-report foundations before lifecycle implementation.** Define the minimum report schema, durable storage boundary, routing ownership, and malformed-report handling needed by task lifecycle work. Full reporting, Maildir migration, dashboard work, and human-facing aggregation remain Phase 7 deliverables.
- [ ] **Create an execution dependency map.** Map each phase’s prerequisites, service dependencies, migration dependencies, acceptance evidence, approval gates, and rollback requirements so dependent work cannot start ahead of its foundations.
- [ ] **Create a verified implementation inventory.** For every completed or in-progress checkbox in this plan, record the evidence source, validation command, relevant tests, runtime conditions, known limitations, and whether the behavior remains verified after the current workspace changes.

### Communication Modes

To keep humans, the Brain, and arms aligned, standardize three primary communication paths:

1. **CLI ↔ API Server** – The `octopai` CLI becomes a thin client that authenticates against the Hono REST API for every management action (spawn, list, kill, status). Local-only code paths are legacy fallbacks.
2. **Web UI ↔ API Server** – The React/Vite Observatory consumes the same authenticated REST and WebSocket endpoints, mirroring CLI capabilities with dashboards and controls.
3. **Mail Client ↔ Email Server** – A future IMAP/SMTP gateway will expose the Maildir inbox/outbox so humans can use any email client. Until then, humans interact through Maildir-backed tools and the Observatory’s Mail UI.

### Database and Messaging Compatibility Follow-up

- [ ] **Validate versioned NATS payloads at consumer boundaries.** Define supported schema versions, translate supported historical payloads into the current internal form, and retain unsupported messages with an actionable operator error. Test replay of retained messages across upgrades; version badges alone are observational.
- [ ] **Make message-to-database processing retry-safe.** Commit database changes and durable message deduplication records atomically before acknowledging JetStream messages. Verify duplicate delivery and crash recovery between commit and acknowledgement. Audit database-to-NATS writes for an outbox requirement so committed state cannot lose its event.

## Phase 1: Core Infrastructure and API Boundary

This phase provides the execution substrate and integration boundaries required by every later feature. Phase 0 decisions, repository validation, and the API-owned integration model must precede changes here. The existing foundation is described below as complete in the source plan, but its runtime behavior, tests, and boundary claims remain subject to verification.

The verified API boundary, startup ordering, authentication, migrations, event delivery, and failure behavior are prerequisites for Observatory, task lifecycle, arm-harness, and deployment work. No dependent phase may infer successful implementation from file paths or test names alone.

### Deliverables

- [ ] **Verify the Brain/API boundary refactor.** Brain becomes an API-first orchestrator with no direct NATS/JetStream/harness calls. The API server becomes the typed/authenticated integration boundary. ArmAgent owns harness/OpenCode traffic and publishes arm events/messages through NATS.
- [ ] **Complete the boundary cleanup described in `.project/plans/brain-api-boundary-execution-plan.md`.**
- [ ] **Validate the architecture described in `docs/architecture/brain-api-boundary.md`.**
- [ ] **Verify Brain polling, Maildir I/O, MCP server, arm spawning, CLI basics, type definitions, and NATS integration against runtime tests rather than filenames.**
- [ ] **Verify API migrations run automatically and preserve the API-owned SQLite access boundary.**
- [ ] **Verify authentication, authorization, error handling, logging, WebSocket behavior, and API-to-CLI integration before dependent UI or orchestration work is assigned.**
- [ ] **Verify event publication and lifecycle behavior between ArmAgent, harnesses, NATS, the API, and the Brain.**
- [ ] **Verify that failure paths do not create local arm/task state that was not durably persisted by the API.**
- [ ] **Verify startup and shutdown ordering.** Confirm database migration, NATS connection, API startup, Brain polling, ArmAgent startup, WebSocket registration, and cleanup behavior.
- [ ] **Verify integration contracts with contract and failure-path tests.** Cover authentication failures, unavailable dependencies, duplicate requests, process exits, stale state, reconnects, and partial persistence.
- [ ] **Verify onboarding and workspace connection boundaries.** Confirm that onboarding creates or selects the intended project/workspace, that API authentication and connection errors are surfaced clearly, and that startup does not silently use stale or local-only state.
- [ ] **Verify arm-context default migration behavior.** Validate migration ordering, repeatability, rollback expectations, default values, and compatibility with existing arm records.
- [ ] **Publish verified boundary evidence.** Update `.project/status.md` with tested service topology, supported startup paths, known limitations, command evidence, and unresolved boundary gaps.

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

The Observatory phase depends on the verified API boundary and core infrastructure. The source plan records Phase 1 as complete, while the following enhancements remain non-blocking and do not retroactively prevent Phase 1 from being considered complete. Each enhancement must be validated through API behavior, UI behavior, and relevant acceptance evidence.

Observatory work consumes authoritative API and WebSocket state. It must not become an alternate source of truth for task, arm, ownership, activity, queue, or startup state. Reusable UI primitives, error boundaries, accessibility behavior, loading states, and responsive behavior should be established before individual surface expansion.

### Deliverables

- [ ] **Verify the Phase 1 acceptance criteria.** Confirm Hono startup, health behavior, automatic SQLite migrations, arm listing and lifecycle updates, activity timeline, WebSocket reconnect behavior, React/Vite build, client-side routing, CLI proxying, API-key authentication, progressive-planning hooks, and `.project/status.md` evidence.
- [ ] **Verify the Phase 1 web implementation without assuming changed filenames prove completion.** Inspect the actual behavior of the current adaptive-card, workbench, workspace, page, layout, design-system, and background-asset changes listed by Git status.
- [ ] **Establish Observatory resilience primitives.** Validate screen error boundaries, workspace connection notices, startup states, retry behavior, loading and empty states, route recovery, and telemetry for client-visible API or WebSocket failures before adding dependent pages.
- [ ] **Add the Project Plan Viewer.** Provide a file/folder tree of `.project/` and key documents on the left, including `README.md`, `plan.md`, `requirements.md`, `decisions/`, `acceptance/`, and `plans/`. Render the selected Markdown file on the right, allow plan documents to be edited in the browser, show a visible “Last Updated” timestamp derived from git commit metadata or filesystem mtime, and clearly indicate recently changed files.
- [x] **Enhance the Mail and Message Interface.** Show sent messages from users to the Brain or arms in addition to the current inbox-only view. Provide threaded conversations that include arm responses.
- [ ] **Enhance the Task List.** Display past completed tasks, the current in-progress task, and the next scheduled or upcoming task. Provide a timeline view with recent activity rather than limiting the interface to a CRUD backlog.
- [ ] **Add the Arm Viewer Page.** Make every arm clickable from anywhere in the UI, show live arm status and activity, and display the history of arms that have closed or finished in the project. For dead arms, retain only the last 100 activity items, and assign each arm a unique randomly generated color.
- [ ] **Resolve the arm-metrics API contract.** The prior dedicated arm metrics endpoint task is cancelled below. Before graph work relies on an aggregated metrics endpoint, identify the approved replacement route or routes, define authentication, aggregation windows, retention, polling, cache, and failure behavior, and verify that the cancelled endpoint contract is not reintroduced implicitly.
- [ ] ~~**Add arm metrics endpoints.** Implement `GET /api/arms/:id/metrics`, `GET /api/arms/:id/context-history`, and `GET /api/arms/:id/cost-history`. The endpoints must provide the data required by the full graph, sparkline, context, and cost views.~~ <!--octopai:status:cancelled-->
- [ ] **Add Arm Activity and Efficiency Visualization.** Provide a minute-by-minute activity bar graph over a 30-minute window, using stacked or grouped bars with events per minute and leaving gaps for inactive minutes. Distinguish file writes in blue, thinking/reasoning in yellow, tool calls in green, and completed tasks in prominent purple; allow tasks to pile up vertically within a minute bar so activity and efficiency are visible at a glance.
- [ ] **Add context usage visualization to arm activity.** Place a higher-resolution context-length line graph below the activity graph, using samples such as every 10–15 seconds. Show context token usage over time, indicate the 80% compression threshold, and shade the warning zone near context limits.
- [ ] **Add cost visualization to arm activity.** Place a cost or money-usage line graph below the context graph and show a running total of spend over time. Optionally stack input, output, and cache costs, show a dollars-per-hour cost-rate indicator based on recent activity, and show a budget threshold line when configured.
- [ ] **Source arm cost data from OpenCode.** Use `GET /provider` and `Provider.models[].cost` for model pricing, `AssistantMessage.cost` for per-message cost, and `AssistantMessage.tokens` for input, output, reasoning, and cache read/write usage. The resulting views must help users identify expensive and inexpensive arms, cost spikes during complex reasoning, and the return on investment of different model choices.
- [ ] **Provide responsive graph views and data feeds.** Show complete 30-minute graphs and legends on the Arms list page, and a compressed sparkline-style view on the Arm Viewer page. Generate graph data from the SSE event stream, poll an aggregated metrics endpoint from the frontend, and continue delivering live list updates through WebSocket events.
- [ ] **Add Arm Spawning from the Web UI.** Provide a browser form for spawning arms, auto-populate the name input with generated names, allow names to be regenerated, and provide provider and model dropdowns with cost estimates and budget warnings. Show real-time feedback while spawning.
- [ ] **Add Model Recommendations and Budget Tracking.** Show cost estimates per model, such as GPT-4.1 versus Claude-3.5, based on expected token usage. Warn users about high-cost models when they spawn arms.
- [ ] **Add Message Queue Visualization.** Add an API endpoint that reports queue depth and processing times, then display real-time queue status with graphs.
- [ ] **Validate accessibility, responsive layouts, loading states, empty states, error states, reconnect behavior, keyboard navigation, and reduced-motion behavior for the Observatory surfaces.**
- [ ] **Validate API/UI data ownership.** Confirm that the UI does not derive authoritative task, arm, activity, ownership, or queue state from filenames or stale local state.

### Dependencies

- Phase 0: Planning, Architecture, and Execution Preconditions
- Phase 1: Core Infrastructure and API Boundary
- Phase 1 acceptance verification

## Phase 3: Collaborative Planning and Task Refinement

This phase depends on the Observatory API/UI foundation, the canonical plan format, task-file references, progressive-planning semantics, and the branch-centered task lifecycle. It provides human and architect-agent collaboration without turning the UI into a static CRUD backlog or bypassing Brain-controlled assignment.

Task preparation must remain distinct from task assignment: preparation may create validated candidate work, while only the Brain’s dependency-aware single-next-task calculation may make work eligible for execution.

### Deliverables

- [ ] **Add a high-performance multi-tabbed grid view.** Support sorting and filtering large numbers of plan items, tasks, and discoveries. The grid must remain usable for the scale covered by the acceptance criteria.
- [x] **Add progress visualization.** Show real-time progress tracking, completion status, and sub-task breakdown for plan items and tasks.
- [x] **Add collaborative discussion UI.** Provide an integrated chat interface for discussing implementation and design for a specific item with an “Architect” agent.
- [ ] **Add the Task Preparation Agent.** Allow the agent to turn a discussion into a detailed task definition containing context, requirements, and acceptance criteria.
- [ ] **Add the Task Handoff Mechanism.** Queue prepared tasks for execution by other arms and bridge the planning and execution workflows.
- [ ] **Preserve the planning representation.** Show recent activity, current work, the single next task, and a collaborative planning board without exposing a full speculative backlog as the source of truth.
- [ ] **Ensure prepared tasks integrate with the canonical plan.** Prepared work must reference its plan item, acceptance criteria, dependencies, context, and outputs before it can appear in the Next Task preview.
- [ ] **Validate discussion persistence and authorization.** Preserve discussion history per item and prevent unauthorized plan, task, or context changes.
- [ ] **Validate large-collection performance.** Measure sorting, filtering, rendering, updates, and interaction for at least 100 items.

### Acceptance Criteria

- [ ] Users can sort and filter 100+ items in the grid view without performance degradation.
- [ ] Discussion history is preserved per item.
- [ ] The agent can generate a valid task definition from a discussion.
- [ ] Prepared tasks appear in the “Next Task” preview when ready.
- [ ] Foundational criteria remain covered by [acceptance/phase-1.md](./acceptance/phase-1.md).

## Phase 4: Task Classification and Context

This phase establishes task-level behavior and context while preserving the principle that arms remain general-purpose. It depends on the core Brain/MCP/CLI infrastructure and task representation, but not on permanent arm domains or specialization. Existing context-bundle, discovery, assignment, and discovery API infrastructure must be verified before missing prompt behavior is added.

Classification schemas, context redaction, prompt construction, and tool filtering must be specified before lifecycle assignment begins. The same task metadata must be used consistently by the Brain, API, MCP, harnesses, and Observatory.

### Task Classifications

| Classification | Purpose | Output |
|---|---|---|
| Architect | Requirements → Plans | Plans, tasks |
| Development | Tasks → Code | Code, discoveries |
| QA | Code → Tests | Tests, doc verification |
| Documentation | Code → Feature Docs | Updated feature docs, “future work” notes |

### Deliverables

- [ ] **Implement classification-specific prompt templates.** Create prompts for architect, development, QA, documentation, and other required classifications. Each template must describe expected work and output without assigning permanent specialization to an arm.
- [ ] **Ensure arms can execute every task classification.** Classification must determine behavior and context rather than arm identity. Verify that any eligible arm can receive and complete each classification.
- [x] **Verify that arms receive discoveries when tasks are assigned.**
- [x] **Verify that discoveries are stored in SQLite with FTS5 search.**
- [x] **Verify that the API provides discovery listing and search.**
- [ ] **Filter tools by task specialization only as task-context filtering.** Select and filter available tools based on task classification to prevent context overload while preserving general-purpose arms.
- [ ] **Ensure classification is task metadata.** Do not add or restore arm-level domain, expertise, or specialization fields used for routing.
- [ ] **Define classification-specific acceptance and output schemas.**
- [ ] **Verify context bundles.** Include requirements, decisions, plans, tasks, documentation, discoveries, prior art, acceptance criteria, dependencies, comments, branch state, and relevant files.
- [ ] **Validate context-size and redaction rules.** Prevent sensitive, irrelevant, duplicate, or stale content from entering prompts.

### Dependencies

- Phase 0: Planning, Architecture, and Execution Preconditions
- Phase 1: Core Infrastructure and API Boundary
- Phase 3: Collaborative Planning and Task Refinement

### Acceptance Criteria

- [ ] Arms can execute any task classification.
- [x] Arms receive discoveries when tasks are assigned.
- [x] Discoveries are stored in SQLite with FTS5 search.
- [x] The API provides discovery listing and search.

## Phase 5: Progressive Planning and Durable Task Lifecycle

This phase makes the canonical plan executable by the Brain while preserving progressive planning’s runtime determination model. It establishes the durable branch-centered lifecycle governing implementation, review, polish, human review, and merge. Dependencies must be parsed before work is assigned, and task state must never be reset by stale or unrelated events.

The Phase 0 status-report foundation is a prerequisite for this phase. Phase 7 completes formal report aggregation, dashboard, and Maildir migration after durable task and pass relationships exist. This sequencing resolves the dependency without weakening the requirement that status reports influence task determination.

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

- [ ] **Verify Brain re-evaluation on task completion.**
- [ ] **Verify Brain status-report influence on task assignment.**
- [ ] **Verify the “verify & polish” task classification.**
- [ ] **Verify the plan document format.**
- [ ] **Verify completed-task history tracking through the `status_reports` table.**
- [ ] **Verify status report parsing and influence on tasking.**
- [ ] **Verify automatic primary and watcher arm assignment when tasks are claimed.**
- [ ] **Verify consensus updates through the API, allowing arms to submit approvals or rejections and reach quorum.**
- [ ] **Verify that the `report_dependency` tool captures discovery-based relationships surfaced during execution.**
- [ ] **Verify that `### Dependencies` sections are parsed directly from plan phases.**
- [ ] **Verify that plan dependencies are linked to matching tasks.**
- [ ] **Verify that new work is marked blocked when prerequisites are unfinished.**
- [ ] **Verify that architect tasks can be spawned to update plan dependencies when unresolved prerequisites are discovered.**
- [ ] **Implement the canonical single-next-task calculation.** Read `.project/plan.md`, follow only explicitly referenced sub-plans, inspect completed tasks, status reports, discoveries, open tasks, and blockers, then determine one next task or pass.
- [ ] **Implement dependency-aware assignment gating.** Do not assign a task until required prerequisites are complete and no human, bug, environment, file-claim, arm/runtime, or active-pass blocker remains.
- [ ] **Add durable lifecycle storage.** Store task passes, leases, branch references, diff references, and structured decisions. Preserve association between all pass artifacts and the original task.
- [ ] **Add atomic pass operations.** Implement claim, release, and completion API operations that verify eligibility, arm idleness, lease identity, and task state atomically.
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

### Dependencies

- Phase 0 status-report foundation
- Phase 4: Task Classification and Context
- Claims system
- Verified API boundary

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

## Phase 6: Technical Debt and Data Consistency

This phase removes duplicated and unsafe persistence/access patterns only after core schema and migration behavior have been verified. JSON fallbacks must remain during the safety transition and must not be deleted before migration verification.

The work should proceed by inventorying active persistence paths, adding shared utilities and tests, migrating call sites incrementally, validating production-equivalent data migration, and only then deleting verified obsolete fallback paths.

### Known Architectural Issues

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

- [ ] **Audit persistent JSON before removal.** Identify every persistent JSON path, reader, writer, fallback condition, migration path, recovery behavior, and test fixture before deleting any fallback.
- [ ] **Create shared database utilities.** Add `src/db/utils.ts` to consolidate duplicated database connection and access patterns.
- [ ] **Create safe JSON utilities.** Add `src/utils/json.ts` for JSON operations and use Zod validation for parsed values.
- [ ] **Create standardized error utilities.** Add `src/utils/errors.ts` for standardized error handling and middleware integration.
- [ ] **Consolidate duplicate type definitions.** Move shared `OctopaiConfig`, `ArmConfig`, and arm interfaces into `src/types/index.ts`.
- [ ] **Create activity-logging helpers.** Add `src/utils/activity.ts` to consolidate repeated activity-logging patterns.
- [ ] **Fix API error handling.** Update all six violations in `src/api/routes/agents.ts` at lines 45, 50, 64, 69, 75, and 79, and the violation in `src/api/routes/activity.ts` at line 90, so routes use `HttpError` middleware rather than direct error responses.
- [ ] **Validate every JSON parse.** Add Zod schema validation around all `JSON.parse()` operations.
- [ ] **Replace overly broad types.** Replace `Record<string, unknown>` with specific interfaces where the data shape is known, reduce inappropriate uses of `unknown`, and remove unsafe `as unknown as` casting chains.
- [ ] **Reduce duplicated implementation patterns.** Consolidate the 50+ duplicated database connection patterns, 100+ duplicated error-handling patterns, and 100+ duplicated JSON-operation patterns. Target at least a 50% reduction in code duplication.
- [ ] **Validate production-equivalent migration.** Exercise backup, restore, fallback, upgrade, downgrade, interrupted-migration, and recovery procedures against representative persistent state before fallback removal.
- [ ] **Remove JSON file fallbacks after migration verification.** Confirm SQLite migrations are complete and fallback files are no longer needed before deleting JSON persistence paths.
- [ ] **Verify the SQLite single-source-of-truth result.** Ensure all persistent state is in SQLite and no JSON files are used for persistent state.

### Remaining Migration Work

File fallbacks are currently retained for safety during transition and must be removed only after migration verification.

### Dependencies

- Phase 0: Planning, Architecture, and Execution Preconditions
- Phase 1: Core Infrastructure and API Boundary
- Successful migration verification

### Acceptance Criteria

- [ ] `find .octopai -name "*.json" -path "*state*"` returns no results.
- [ ] No direct `c.json({ error: ... })` calls remain in API routes.
- [ ] Every `JSON.parse()` call is wrapped with schema validation.
- [ ] No duplicate type definitions remain across files.
- [ ] Shared utility modules exist for common patterns.
- [ ] All API routes use `HttpError` middleware.
- [ ] Code duplication is reduced by 50% or more.

## Phase 7: Status Reports and Human Oversight

Status reports depend on progressive planning and the communication boundary. They must be formalized before bug tracking and agentic Brain behavior because status reports provide evidence for task history, blockers, discoveries, and next actions.

The schema and minimum parsing foundation was staged in Phase 0 so Phase 5 could model status evidence safely. This phase completes formal report generation, routing, Maildir integration where approved, human-facing dashboarding, and resilient end-to-end report processing.

### Deliverables

- [ ] **Define the status report message type.** Specify fields identifying reporting arm, task, status, findings, and supporting information. Support later bug-reporting and task-determination flows.
- [ ] **Implement status report parsing in the Brain.** Parse incoming reports, validate structure, and store information needed for task history and aggregation.
- [ ] **Aggregate and route reports to humans.** Combine relevant arm reports and deliver them through the established communication path, including email where appropriate.
- [ ] **Make status influence task determination.** Feed parsed reports into progressive planning so issues, blockers, and completion information affect the next assignment.
- [ ] **Add a status dashboard in the API.** Expose status-report information for Observatory display.
- [ ] **Add user-message confirmation and tracking.** Track the processing fate of each user message, whether it was added to the plan, and whether it unblocked work.
- [ ] **Migrate status reports to Maildir when approved.** Write reports to `~/.octopai/mail/brain/cur/`, preserve Markdown bodies, add `X-Octopai-Type: status-report` and `X-Octopai-Task: <task-id>` headers, expose reports through mail UI/API, and support human replies.
- [ ] **Preserve status evidence in task passes.** Associate reports with task, pass, branch, files, tests, discoveries, issues, blockers, and next steps.
- [ ] **Add failure and retry handling.** Ensure malformed, duplicated, delayed, or unrouteable status reports do not corrupt task state.

### Status Report Flow

```txt
Arm → Status Report → Brain → Aggregates → Human (email)
                       ↓
              Updates task history
              Influences next task
```

### Dependencies

- Phase 0 status-report foundation
- Phase 1: Core Infrastructure and API Boundary
- Phase 5: Progressive Planning and Durable Task Lifecycle
- Communication modes and Maildir boundary

## Phase 8: Bug Tracking and Resolution

Bug tracking depends on formal status reports and progressive dependency blocking. It must preserve source, priority, assignment, blockers, evidence, and the investigation → fix → verification sequence without bypassing durable task passes.

Bug state, escalation, notification, and resolution actions must use API-owned persistence and must not directly reset lifecycle state, bypass assignment gates, or create review/polish child tasks.

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

- Phase 5: Progressive Planning and Durable Task Lifecycle
- Phase 7: Status Reports and Human Oversight

## Phase 9: Agentic Brain

The Agentic Brain depends on task classification, progressive planning, formal status reports, bug handling, and the API-owned integration boundary. Migration must be incremental: retain the polling loop, add the agent and validated tools, replace one behavior at a time, and preserve deterministic fallback logic whenever the LLM or framework is unavailable.

The Brain Agent must remain an API-first orchestration client. It must not bypass the verified boundary to access NATS, JetStream, harnesses, task state, or external side effects directly.

### Goal

Transform Brain from a polling loop with hardcoded logic into an agentic AI system.

See [brain-agent-plan.md](./brain-agent-plan.md) for full implementation details.

### Architecture

```txt
┌──────────────────────────────────────────────────────────────────────────────┐
│                    Agentic Brain                                             │
├──────────────────────────────────────────────────────────────────────────────┤
│  ┌───────────────┐    ┌───────────────────────┐    ┌─────────────────────┐   │
│  │ Human Input   │──▶ │ Brain Agent          │──▶ │ Arm Actions         │   │
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

The Phase 0 Brain-boundary decision determines the mediated API or service interfaces represented by “via MCP/ NATS” and “Tools (SQLite, File System, MCP, NATS)” in this historical architecture diagram. The diagram does not authorize direct Brain bypasses of the verified API-owned integration boundary.

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

### Migration Strategy

1. Create `src/brain/agent/`.
2. Implement the agent and tools.
3. Replace functions one at a time:
   - `determineNextTask()` → use the agent.
   - `handleDiscovery()` → use the agent.
   - `handleHumanMessage()` → use the agent.
4. Keep the polling loop as the orchestrator.

### Dependencies

- Phase 0 Agentic Brain boundary decision
- Phase 4: Task Classification and Context
- Phase 5: Progressive Planning and Durable Task Lifecycle
- Phase 7: Status Reports and Human Oversight
- Phase 8: Bug Tracking and Resolution

### Acceptance Criteria

- [ ] The agent makes reasonable task determinations.
- [ ] Discoveries are properly stored and surfaced.
- [ ] Human messages receive appropriate responses.
- [ ] Stuck arms are detected and handled.
- [ ] Fallback logic works when the LLM is unavailable.

## Phase 10: Context Compression

Context compression depends on classification-specific context, the Agentic Brain, harness integration, and searchable arm history. Reinjection must preserve the current task’s identity and context without assigning permanent arm specialization.

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

- Phase 0 vector-search deployment and embedding-boundary decision
- Phase 4: Task Classification and Context
- Phase 9: Agentic Brain
- Phase 16: Agent Harnesses

## Phase 11: NATS JetStream Event Sourcing

This phase migrates event persistence and state reconstruction incrementally. It depends on verified NATS integration, API boundary behavior, and status-report/event schemas. Dual-write, replay, backup, compatibility, and performance validation are mandatory before removing SQLite event storage.

No event-sourcing work may silently change the source-of-truth boundary established in Phase 0. SQLite remains the queryable application-state store during transition, Maildir remains the communication store, and human-editable plans and configuration remain files unless an explicit approved decision changes a specific boundary.

### Overview

Migrate from SQLite-based event storage to NATS JetStream for event persistence, enabling event-sourcing patterns for state reconstruction and audit trails.

### Current State

- Events stored in SQLite `arm_events` table
- Events published by harnesses via `emitEvent()`
- Events queried via API endpoints
- No event-sourcing patterns implemented

### Target State

- Events persisted in NATS JetStream streams
- State derived from event streams
- Comprehensive API for event querying and state reconstruction
- Real-time event processing and historical analysis

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

interface QuestionOption {
  label: string;
  description: string;
}
```

**Brain Response Events:**

- `question.replied`: Human answered the question
- `question.rejected`: Question was rejected/ignored

**Brain Action Required:**

When the Brain detects a `question.asked` event from any arm, it should:

1. Parse the question content and options.
2. Evaluate whether it can answer autonomously or needs human input.
3. Either respond directly or escalate to a human.
4. Track the question-response cycle for learning.

### Dependencies

- Phase 1: Core Infrastructure and API Boundary
- Phase 7: Status Reports and Human Oversight
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

### Problem

Arms generate status reports, task completions, discoveries, and progress updates. Once processed, this institutional knowledge is difficult to search. Users and the Brain need:

1. Historical context: “What did we try before that failed?”
2. Pattern recognition: “Which arms tend to get stuck on similar problems?”
3. Knowledge retrieval: “Has anyone solved this type of problem before?”
4. An audit trail: “What happened during that overnight run?”

### Vector Database

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

### Deliverables

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

- Phase 0 vector-search deployment and embedding-boundary decision
- Phase 7: Status Reports and Human Oversight
- Phase 11: NATS JetStream Event Sourcing
- Phase 9: Agentic Brain
- Approved vector-database deployment decision

## Phase 13: Code Graph and Navigable Context

This phase depends on stable workspace access, SQLite utilities, API/MCP boundaries, and Brain context retrieval. The graph must represent actual current code structure, update incrementally, and remain useful when source files change between indexing and task assignment.

Graph results are advisory context rather than authoritative source control, dependency, task, ownership, or lifecycle state. The system must identify stale, malformed, deleted, renamed, and partially written source conditions.

### Deliverables

- [ ] **Add a Tree-sitter code scanner.** Regularly index the workspace using Tree-sitter and update incrementally where possible.
- [ ] **Store the graph in SQLite.** Represent files, symbols, and definitions as nodes, and imports, calls, references, and containment as edges.
- [ ] **Add graph-query API endpoints.**
- [ ] **Add the code-navigation MCP tool.** Support find definition, find references, and dependency-chain traversal.
- [ ] **Integrate graph context with the Brain.**
- [ ] **Add incremental invalidation and recovery.** Handle deleted, renamed, malformed, or partially written files without serving stale authoritative relationships.
- [ ] **Add graph indexing and query benchmarks.**

### Dependencies

- Phase 1: Core Infrastructure and API Boundary
- Phase 4: Task Classification and Context
- Phase 6: Technical Debt and Data Consistency
- Stable workspace access

### Acceptance Criteria

- [ ] Graph updates automatically on file changes and are queryable within seconds.
- [ ] Agents can navigate from a file to related symbols and dependencies through MCP.
- [ ] The Brain can attach graph-derived context snippets to task payloads.
- [ ] Graph data is persisted in SQLite and survives restarts.

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

- Phase 0 governance architecture decision
- Phase 5: Progressive Planning and Durable Task Lifecycle
- Phase 7: Status Reports and Human Oversight
- Phase 12: Global Status History Search
- Human approval handling

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

- Phase 1: Core Infrastructure and API Boundary
- Phase 2: Observatory Foundation Verification and Enhancements
- Phase 5: Progressive Planning and Durable Task Lifecycle
- Stable workspace events and ownership/claim data

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

- Phase 0 production deployment decision
- Phase 1: Core Infrastructure and API Boundary
- Phase 5: Progressive Planning and Durable Task Lifecycle
- Verified event handling

## Phase 17: Budget Planning and Burn Rate Estimation

This phase depends on Observatory usage data, OpenCode provider/model integration, task classifications, and verified cost events. It must not route tasks by cost until model preferences, banned models, pricing freshness, and budget enforcement semantics are defined and tested.

### Goal

Enable long-running autonomous operation with predictable costs through model cost tracking, burn-rate estimation, and budget forecasting.

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
- Phase 4: Task Classification and Context
- Phase 11: NATS JetStream Event Sourcing or separately verified equivalent cost/event data
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

### Deliverables

- [ ] **Implement task-file dependency/output tracking.**
- [ ] **Implement output existence and content verification.**
- [ ] **Document event-sourcing boundaries and rollback.**
- [ ] **Migrate approved status-report flows to Maildir.**
- [ ] **Preserve compatibility with existing `.project/status-*.md` records during migration.**
- [ ] **Add integration tests for task files, Maildir reports, event-derived state, and SQLite query state.**

### Dependencies

- Phase 5: Progressive Planning and Durable Task Lifecycle
- Phase 7: Status Reports and Human Oversight
- Phase 11: NATS JetStream Event Sourcing
- Approved persistence-boundary decisions

## Phase 19: Adaptive Card Collections and Customizable Widget Dashboards

Muuri makes more sense than Isotope if those are the only choices, but neither should become Coleo’s universal card layer.

This phase depends on the Observatory foundation, existing saved-view behavior, accessibility primitives, and confirmed React ownership of collection projection. The persisted widget model must remain independent from a specific rendering engine.

### Rationale

- Sorting and filtering already happen correctly in React through `projectResourceCollection()` in `resource-sheet-model.ts`. A layout library should not duplicate that state.
- `AdaptiveCardCollection` already preserves accessible row-major DOM order with CSS Grid.
- Isotope has no built-in drag support and its GPL-3.0 option does not fit Coleo’s BUSL license without purchasing a commercial license.
- Muuri is MIT-licensed, typed, and draggable, but it is an imperative absolute-positioning engine whose latest npm release is from 2021. Its DOM manipulation and pointer-oriented drag model add risk with React StrictMode, live updates, variable-height Adaptive Cards, and keyboard accessibility.
- Coleo already includes `dnd-kit` and Framer Motion.

### Deliverables

- [ ] Keep React as the sole source of sorting and filtering.
- [ ] Keep CSS Grid and row-major visual order.
- [ ] Add subtle position, enter, and exit animation to `AdaptiveCardCollection` with Framer Motion’s lightweight `LazyMotion` path.
- [ ] Respect reduced motion and disable expensive layout animation for large or rapidly updating collections.
- [ ] Apply ordered animated collection behavior to Tasks, Bugs, Processes, Inbox, Arms, and other genuinely sortable or filterable record collections.
- [ ] Do not make record cards draggable unless a future explicit `Manual order` sort is selected.
- [ ] Add a reusable `WidgetGrid` under `src/web/src/workbench/`.
- [ ] Use CSS Grid for responsive placement and `dnd-kit` for drag ordering.
- [ ] Enable dragging only inside an explicit **Customize dashboard** mode.
- [ ] Restrict dragging to dedicated handles so charts, links, inputs, and Adaptive Card actions remain usable.
- [ ] Support keyboard reordering, screen-reader announcements, and visible move commands.
- [ ] Support controlled presets such as single, double, or full width and auto, compact, or tall height.
- [ ] Include collapse, hide/show, reset, and restore-default actions.
- [ ] Use existing `useViewPreferences()` and `workbench_views` infrastructure with `kind: "dashboard"`.
- [ ] Store only layout configuration in `preferences.extras`; do not persist fetched metric or card payloads.
- [ ] Version the stored layout schema and normalize it against the current widget registry so new widgets are appended and removed widgets are ignored.
- [ ] Commit order only when a drag ends rather than during every pointer movement.
- [ ] Avoid a database migration or new endpoint unless later requirements exceed the existing saved-view model.
- [ ] Add `dashboard.main` for the main system dashboard.
- [ ] Add `dashboard.brain` for Brain status and configuration.
- [ ] Add `dashboard.arm-telemetry`, shared by fleet telemetry and every Arm Viewer instance.
- [ ] Add `dashboard.task-insights`, shared across Task burndown and activity panels.
- [ ] Add the corresponding Bug insights template because Bugs mirrors Tasks and should not remain inconsistent.
- [ ] **Main dashboard:** Expose infrastructure, plan status, runtime hosts, Arms, operational inbox, task progress, and burndown as individually keyed widgets. Keep critical setup warnings pinned and non-hideable.
- [ ] **Brain:** Make status and configuration reorderable. Keep model-access and planning-gate alerts pinned.
- [ ] **Arm telemetry:** Keep date-range controls pinned and arrange Activity, Context, and Cost charts through the shared template.
- [ ] **Task and Bug insights:** Preserve existing toolbar toggles while moving internal cards and charts onto the widget grid.
- [ ] **Static surfaces:** Keep settings forms, detail cards, discussions, diffs, and live chronological streams semantically fixed.
- [ ] Lift Process saved sort and filter preferences out of `ProcessSheet` so card and sheet modes use the same projected collection.
- [ ] Audit other card and sheet pairs for the same consistency requirement.
- [ ] Ensure DOM order always equals the selected sort order; animation must remain purely visual.
- [ ] Ensure filtered cards are unmounted rather than visually hidden with focusable controls remaining in the DOM.
- [ ] Update Workbench documentation and record the final interaction and persistence contracts.

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
- Existing `useViewPreferences()` and `workbench_views` behavior verified in Phase 0
- Verified React-owned collection projection and accessibility primitives

## Phase 20: Remaining Brain-Created Tasks

These tasks were documented by the Brain and remain in scope. They depend on the API boundary, durable claims and passes, task handoff semantics, and safe development-server controls.

### Deliverables

- [ ] **Provide arm access to development-server logs and restart control.** Research existing solutions, including MCP servers, then implement log access and development-server restart control. Coordinate destructive operations through the Brain rather than allowing unreviewed direct actions.
- [ ] **Add thrashing detection for lazy claims.** Detect when arms are fighting over files, implement a lazy claim-release protocol, and throttle rapid reclaims.
- [ ] **Add the handoff protocol between arms.** Define graceful task handoff, include context transfer, and handle abandoned tasks and conflicts without losing task state or work history.
- [ ] **Test restart, abandoned-pass, handoff, claim-release, and conflict-recovery paths.**

### Dependencies

- Phase 1: Core Infrastructure and API Boundary
- Phase 5: Progressive Planning and Durable Task Lifecycle
- Phase 16: Agent Harnesses
- Safe development-server controls and task handoff semantics

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
|---|---|
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

- Phase 5: Progressive Planning and Durable Task Lifecycle
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
- Phase 1 authentication and security boundaries
- Phase 11 verified event delivery
- Phase 14: Governance
- Selected deployment target

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

- All required preceding phases
- Phase 0 production deployment decision
- Phase 0 production persistence decision
- Phase 0 vector-search deployment and embedding-boundary decision
- Selected production target
- Verified rollback, migration, backup, and disaster-recovery procedures

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
| 2026-09-18 | Added an explicit verified-implementation inventory task to Phase 0 so all existing checked items and current workspace changes require behavioral evidence before dependent work is assigned. |
| 2026-09-18 | Added explicit Phase 0 decisions for vector-search deployment and embeddings, Agentic Brain API-boundary reconciliation, production persistence sequencing, and replacement arm-metrics API contract; updated dependent phase prerequisites without changing existing checkbox states. |
| 2026-09-18 | Reordered execution dependencies, staged minimum status-report foundations before durable lifecycle work, added explicit Observatory resilience, persistence-audit, deployment-target, vector-decision, graph-boundary, and execution-dependency prerequisites, while preserving all existing requirements and checkbox states. |
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
