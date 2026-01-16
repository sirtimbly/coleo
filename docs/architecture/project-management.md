# Project Management

Octopai manages the software project itself through **architect-classified tasks** that coordinate work, update documentation, track progress, and ensure human feedback is properly incorporated.

Instead of a permanently specialized "PM arm", **any general-purpose arm** can temporarily execute **project management tasks** when the brain assigns it an `architect` (project-management) classification with the right context and **task configuration template**.

## Project Management via Architect Tasks

When running in a project management role, an architect-classified task behaves like a project manager. It is the human's primary interface into the system's overall progress and plans.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                ARCHITECT (PROJECT MANAGEMENT)                               │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Does NOT primarily write product code. Instead it:                          │
│                                                                              │
│  ├── Watches arm and task activity                                           │
│  ├── Updates project plans and task lists in .project/                       │
│  ├── Maintains phase acceptance criteria                                     │
│  ├── Writes status updates and summaries                                     │
│  ├── Drafts communications to humans                                         │
│  ├── Ensures human feedback is captured and acted on                         │
│  ├── Tracks blockers and escalates when needed                               │
│  └── Keeps documentation in sync with reality                                │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

These responsibilities are fulfilled by **architect tasks operating over the `.project/` directory and docs/**, guided by a **task configuration template**, not by a separate PM-only agent type.

### Architect Task Profile (Project Management Flavor)

Architect tasks that focus on project management use a predictable set of inputs and outputs.

```typescript
interface ProjectManagementTaskContext {
  classification: "architect";               // Architect task
  subtype: "project-management";             // Flavor: project management

  // Inputs from the brain
  projectRoot: string;                        // Path to repo
  projectDir: string;                         // Path to .project/
  docsDir: string;                            // Path to docs/
  recentActivityMinutes: number;              // Window to summarize

  // Current state snapshots
  statusFile: string;                         // .project/status.md contents
  planFile: string;                           // .project/plan.md contents
  requirementsFile: string;                   // .project/requirements.md contents
  decisionsIndex: string[];                   // .project/decisions/*.md
  taskFiles: {
    backlog: string;
    current: string;
    blocked: string;
    completed: string;
  };
  feedbackFiles: {
    pending: string;
    incorporated: string;
  };
}

interface ProjectManagementTaskOutput {
  updatedFiles: {
    path: string;
    content: string;
  }[];
  statusSummary?: string;                     // For email / Observatory
  humanAttentionItems?: string[];             // Bullets for "Human Attention Needed"
}
```

The **same physical arm instance** might perform:

- A development task (implementing code)
- Then an architect/project-management task (updating `.project/status.md` and docs)
- Then a QA task (writing tests)

The brain decides which classification to assign based on current needs, and then selects an appropriate **task configuration template** for that classification.

## Task Configuration Templates

Octopai replaces MR-specific templates with **task configuration templates** that are keyed by task classification (and optional subtype). These templates live in code (see `src/types/index.ts`) and describe how different kinds of tasks should behave.

### Template Fields

```typescript
interface TaskConfigurationTemplate {
  classification: string;       // e.g., "architect", "development", "qa"
  subtype?: string;             // e.g., "project-management"
  description: string;          // Human-readable summary
  allowedTools?: string[];      // Logical tool names ("fs", "git", "mcp:guidance")
  contextBundles?: string[];    // What context to load (".project/*", "docs/", "discoveries")
  governance?: {
    requiresProposal?: boolean; // Should large changes go through proposals?
    typicalProposalTypes?: string[]; // Common proposal types for this task
    emphasizeStatusReports?: boolean; // Should tasks send frequent status?
  };
  hints?: {
    systemHint?: string;        // Short instruction for the arm
  };
}
```

A registry of built-in templates (`TASK_CONFIGURATION_TEMPLATES`) maps keys of the form `"classification:subtype"` to concrete configurations. Examples:

- `"architect:project-management"` – drives status/doc-focused architect tasks over `.project/` and `docs/`.
- `"development:default"` – for ordinary implementation work.
- `"qa:default"` – for testing and verification.
- `"documentation:default"` – for documentation sync.

### How the Brain Uses Templates

1. **Determine next task** via progressive planning.
2. **Choose classification and (optional) subtype** for that task.
3. **Look up template key** `${classification}:${subtype ?? "default"}` in `TASK_CONFIGURATION_TEMPLATES`.
4. **Prepare context** according to `contextBundles` (e.g., `.project/*`, related files, discoveries).
5. **Shape prompts and tools** based on `allowedTools`, `governance`, and `hints.systemHint`.

This replaces MR-style templates and "spawn a special arm for this MR" patterns with **classification-driven behavior for general-purpose arms**.

## On-Disk Project Structure

All project management happens through **plain text files** in a `.project/` directory. This makes the project state:

- **Version controlled** - Full history of project evolution
- **Human readable** - No proprietary formats, just markdown
- **Diff-friendly** - Easy to see what changed
- **Tool agnostic** - Works with any editor or viewer

### Directory Structure

This structure reflects the current implementation and planning in `.project/`:

```
.project/
├── README.md              # Project overview and quick status
├── requirements.md        # Core philosophy & task classifications
├── plan.md                # High-level project plan and phases
├── status.md              # Current status, updated frequently
├── decisions/             # Architecture Decision Records (ADRs)
│   ├── 001-use-bun.md
│   ├── 002-maildir-for-communication.md
│   ├── ...
├── tasks/
│   ├── backlog.md         # Future work, ideas, nice-to-haves
│   ├── current.md         # Active work items
│   ├── blocked.md         # Tasks waiting on something
│   └── completed.md       # Recently done tasks
├── feedback/
│   ├── pending.md         # Human feedback awaiting action
│   ├── incorporated.md    # Feedback that's been addressed
│   └── sessions/          # Per-session feedback logs
├── acceptance/
│   ├── phase-0.md         # Acceptance criteria for Phase 0
│   ├── phase-1.md
│   ├── phase-2.md
│   └── ...
└── plans/                 # Implementation plans generated by architect tasks
```

> Note: older references to a dedicated `communications/` folder and `pm-arm` should now be interpreted as **architect project-management tasks** reading from and writing to these core `.project/` files, guided by their task configuration template.

## File Formats

### status.md

`status.md` is the canonical high-level status for the project, updated by architect project-management tasks whenever significant changes occur.

```markdown
# Project Status

**Last Updated**: 2024-01-15 14:30 UTC
**Updated By**: Architect task (project-management)

## Current State

🟢 **On Track** | Phase 1: Observatory Foundation

### Active Work

| Classification | Task | Status | Since |
|----------------|------|--------|-------|
| development | Hono server setup | 🔨 In Progress | 2h ago |
| development | React shell | 🔨 In Progress | 1h ago |
| qa | API test suite | ⏳ Waiting | Blocked on Hono server setup |

### Recent Completions (Last 24h)

- ✅ Database schema design (development)
- ✅ WebSocket integration plan (architect)

### Blockers

None currently.

### Human Attention Needed

- [ ] Review API authentication approach (see decisions/003-api-authentication.md)

---

## Metrics

- Tasks completed this week: 7
- Tasks in progress: 3
- Estimated completion: Phase 1 by Jan 20
```

### tasks/current.md

Architect project-management tasks maintain an overview of active work items, but the **brain uses progressive planning** to determine the next task at runtime. `tasks/current.md` is a human-readable projection, not a canonical backlog.

```markdown
# Current Tasks

## In Progress

### [TASK-012] Hono API Server Setup
- **Classification**: development
- **Assigned Arm**: worker-1
- **Started**: 2024-01-15 10:00
- **Estimate**: 4 hours
- **Status**: 🔨 In Progress

**Description**: Set up Hono server with basic middleware, health endpoint, and CORS.

**Acceptance Criteria**:
- [ ] Server starts on configured port
- [ ] Health endpoint returns 200
- [ ] CORS configured for local development
- [ ] Request logging middleware

**Progress Notes**:
- 10:30 - Basic server structure created
- 11:15 - Added health endpoint
- 12:00 - Working on middleware stack

---

### [TASK-013] React Shell
- **Classification**: development
- **Assigned Arm**: worker-2
- **Started**: 2024-01-15 11:00
- **Estimate**: 3 hours
- **Status**: 🔨 In Progress

**Description**: Create React app shell with routing and basic layout.

**Acceptance Criteria**:
- [ ] Vite + React + TypeScript setup
- [ ] React Router with placeholder pages
- [ ] Basic layout component
- [ ] Tailwind CSS configured

---

## Waiting

### [TASK-014] API Test Suite
- **Classification**: qa
- **Assigned Arm**: worker-3
- **Waiting On**: TASK-012 (Hono server)
- **Estimate**: 2 hours

**Description**: Create test suite for API endpoints.

**Notes**: Can start once the Hono server has basic endpoints working.
```

### feedback/pending.md

Human feedback is tracked as structured markdown that architect project-management tasks can parse, prioritize, and incorporate.

```markdown
# Pending Feedback

## From Session 2024-01-15

### [FB-007] Radial coordinate system for Garden
**Received**: 2024-01-15 13:00
**Source**: Human (Tim)
**Priority**: High

> The 3D coordinate system should change so recently touched things are 
> closer to the center. A radial system where each category is a slice 
> of 360 degrees, and distance from center = activity level.

**Status**: ✅ Incorporated
**Action Taken**: Updated components.md with radial coordinate system design.

---

### [FB-008] Clarify project management responsibilities
**Received**: 2024-01-15 14:30
**Source**: Human (Tim)
**Priority**: High

> Project management (status updates, task tracking, doc sync) should be
> handled by architect-classified tasks, not a separate PM-only arm.

**Status**: 🔨 In Progress
**Assigned To**: architect (project-management)
**Notes**: Updating project-management.md and .project/ structure.
```

## Architect Project-Management Behaviors

The following behaviors describe **architect project-management tasks**, not a dedicated PM arm type. Any general-purpose arm can perform these when assigned the appropriate classification, template, and context.

### 1. Status Updates

Architect project-management tasks regularly update `status.md`:

```typescript
interface StatusUpdateTrigger {
  event:
    | "task_completed"
    | "task_started"
    | "blocker_detected"
    | "human_feedback"
    | "arm_paused"
    | "deploy_completed"
    | "scheduled";  // Every 30 min if active work

  action: "update_status";
}

async function updateStatus(event: StatusUpdateTrigger): Promise<void> {
  const currentState = await gatherArmStates();
  const recentActivity = await getRecentActivity(24 * 60); // 24h
  const blockers = await detectBlockers();
  const humanNeeds = await getPendingHumanItems();

  await writeStatusFile({
    timestamp: new Date(),
    state: determineOverallState(currentState, blockers),
    activeWork: formatActiveWork(currentState),
    recentCompletions: formatCompletions(recentActivity),
    blockers: formatBlockers(blockers),
    humanAttention: formatHumanNeeds(humanNeeds),
    metrics: calculateMetrics(recentActivity),
  });
}
```

### 2. Task Tracking

When tasks complete, architect project-management tasks keep `.project/tasks/*.md` in sync:

```typescript
async function onTaskCompleted(armId: string, taskId: string): Promise<void> {
  // Move from current.md to completed.md
  await moveTask(taskId, "current.md", "completed.md");

  // Update task with completion details
  await appendToTask(taskId, {
    completedAt: new Date(),
    completedBy: armId,
    notes: await getCompletionNotes(armId, taskId),
  });

  // Check if any waiting tasks can now start
  await checkUnblocked(taskId);

  // Update status
  await updateStatus({ event: "task_completed" });
}
```

### 3. Feedback Incorporation

When humans provide feedback (typically via email or direct edits), architect project-management tasks ensure it is tracked and acted on:

```typescript
interface FeedbackItem {
  id: string;
  received: Date;
  source: string;
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "incorporated" | "declined";
  assignedTo?: string;
  notes?: string;
}

async function onHumanFeedback(feedback: string, session: string): Promise<void> {
  // Parse and categorize feedback
  const items = await parseFeedback(feedback);

  for (const item of items) {
    // Add to pending feedback
    await appendToPendingFeedback(item);

    // Determine if it needs immediate action
    if (item.priority === "high") {
      // Notify relevant arms
      await broadcastToArms({
        type: "feedback_received",
        item,
        action: "review_and_incorporate",
      });
    }

    // Log to session file
    await appendToSessionLog(session, item);
  }

  await updateStatus({ event: "human_feedback" });
}
```

### 4. Communication Drafting

Architect project-management tasks draft updates for humans, which can then be sent via Maildir / future IMAP/SMTP gateway:

```typescript
interface CommunicationDraft {
  type: "daily_summary" | "blocker_alert" | "milestone_reached" | "decision_needed";
  recipient: "human";
  subject: string;
  body: string;
  attachments?: string[];  // Paths to relevant files
  urgency: "immediate" | "normal" | "low";
}

async function draftDailySummary(): Promise<CommunicationDraft> {
  const activity = await getActivitySince(lastSummary);
  const blockers = await getBlockers();
  const decisions = await getPendingDecisions();

  return {
    type: "daily_summary",
    recipient: "human",
    subject: `Octopai Daily: ${completedCount} done, ${inProgressCount} active`,
    body: formatDailySummary(activity, blockers, decisions),
    urgency: blockers.length > 0 ? "immediate" : "normal",
  };
}
```

### 5. Documentation Sync

Architect project-management tasks help keep docs in sync with implementation:

```typescript
async function checkDocSync(): Promise<DocSyncReport> {
  const issues: DocSyncIssue[] = [];

  // Check if code has changed but docs haven't
  const codeChanges = await getRecentCodeChanges();
  for (const change of codeChanges) {
    const relatedDocs = findRelatedDocs(change.path);
    for (const doc of relatedDocs) {
      if (!await wasUpdatedSince(doc, change.date)) {
        issues.push({
          type: "stale_docs",
          doc,
          reason: `Code changed in ${change.path} but docs not updated`,
          suggestion: `Review ${doc} for accuracy`,
        });
      }
    }
  }

  // Check if docs reference non-existent code
  const docRefs = await extractCodeReferences(getAllDocs());
  for (const ref of docRefs) {
    if (!await exists(ref.path)) {
      issues.push({
        type: "broken_reference",
        doc: ref.sourceDoc,
        reason: `References ${ref.path} which doesn't exist`,
        suggestion: `Update or remove reference`,
      });
    }
  }

  return { issues, checkedAt: new Date() };
}
```

## Human Communication Principles

These principles describe **how architect project-management tasks communicate with humans** (usually via email), rather than a special PM arm.

### 1. Proactive, Not Reactive

Don't wait for humans to ask. Provide regular updates:
- Status changes when significant events occur
- Daily summaries if work is ongoing
- Immediate alerts for blockers or decisions needed

### 2. Concise but Complete

```markdown
# Good
✅ Completed API server setup. Tests passing. Ready for UI integration.
Blocker: Need decision on auth approach before proceeding.

# Bad  
I have finished working on the API server. The server is now set up and 
running. I ran all the tests and they are all passing now. The next step
is to integrate with the UI. However, there is a blocker...
```

### 3. Always Actionable

Every communication should be clear about:
- What happened
- What it means
- What (if anything) is needed from the human

```markdown
## Decision Needed: API Authentication

**Context**: We're implementing the Observatory API and need to choose 
an authentication approach.

**Options**:
1. Simple API key (X-API-Key header) - quick to implement
2. JWT tokens - more secure, supports expiration
3. OAuth - full-featured, more complex

**Recommendation**: Option 1 for Phase 1, upgrade to Option 2 in Phase 3.

**Your Input Needed**: Approve recommendation or choose alternative.
```

### 4. Track Everything

All human feedback is logged and tracked:
- When it was received
- What was done about it
- When it was completed (or why it was declined)

### 5. No Surprises

Humans should never be surprised by:
- What the system is working on
- Why something was done a certain way
- The current state of the project

## Metrics and Reporting

Architect project-management tasks track metrics for project health:

```typescript
interface ProjectMetrics {
  // Velocity
  tasksCompletedThisWeek: number;
  averageTaskDuration: number;  // hours

  // Quality
  feedbackIncorporationRate: number;  // % of feedback acted on
  docSyncScore: number;  // % of docs up-to-date

  // Health
  currentBlockers: number;
  averageBlockerDuration: number;  // hours
  armUtilization: Record<string, number>;  // % time active

  // Communication
  humanResponseTime: number;  // avg hours to respond to questions
  decisionsAwaitingInput: number;
}
```

## Integration with Brain

Rather than a dedicated PM arm with special privileges, the **brain** knows how to:

- Spawn general-purpose arms
- Assign them architect project-management tasks when the project needs coordination
- Provide `.project/` and activity context bundles to those tasks based on the selected task configuration template

Architect project-management tasks, in turn, rely on the brain for:

- Subscriptions to activity streams (`arm.*`, `proposal.*`, `deploy.*`, `claim.*`, etc.)
- A way to send human-facing messages (Maildir / future IMAP/SMTP gateway)
- APIs for querying current arms, tasks, and discoveries

## Why Text Files?

The choice to use plain text files for project management:

| Benefit | Explanation |
|---------|-------------|
| **Transparency** | Anyone can read the files, no special tools needed |
| **Git-friendly** | Full history, diffs show exactly what changed |
| **AI-friendly** | Easy for arms to read/write markdown |
| **Human-friendly** | Humans can edit directly if needed |
| **Portable** | Works on any system, no database required |
| **Inspectable** | Debug by just reading the files |
| **Collaborative** | Multiple arms can update different files |

This approach makes the project state a **first-class part of the codebase**, not hidden in an external tool.
