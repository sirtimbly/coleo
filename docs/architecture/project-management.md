# Project Management

Octopai includes a specialized "PM Arm" that manages the software project itself - coordinating tasks, updating documentation, tracking progress, and ensuring human feedback is properly incorporated.

## The PM Arm

Unlike other arms that write code, the PM arm **observes and coordinates**. It's the human's primary interface into the system's progress.

```
┌─────────────────────────────────────────────────────────────┐
│                      PM ARM ROLE                             │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Does NOT write code. Instead:                               │
│                                                              │
│  ├── Watches all arm activity                                │
│  ├── Updates project plans and task lists                    │
│  ├── Maintains acceptance criteria                           │
│  ├── Writes status updates and summaries                     │
│  ├── Drafts communications to humans                         │
│  ├── Ensures human feedback is captured and acted on         │
│  ├── Tracks blockers and escalates when needed               │
│  └── Keeps documentation in sync with reality                │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### PM Arm Profile

```typescript
const PM_ARM: ArmProfile = {
  id: "pm",
  name: "Project Manager",
  agent: "opencode",  // or any harness
  
  domain: {
    name: "project-management",
    description: "Project coordination, documentation, human communication",
    defaultPatterns: [
      ".project/**",
      "docs/**/*.md",
      "README.md",
      "CHANGELOG.md",
      "TODO.md",
    ],
    mcpServers: ["git", "docs"],
  },
  
  // PM has read access to everything, write access to docs/project files
  expertise: ["documentation", "planning", "communication", "coordination"],
  
  // PM observes but rarely proposes code changes
  permissions: {
    canPropose: ["docs", "refactor"],  // Not deploy
    canVeto: false,                     // Observes, doesn't block
    canEscalate: true,                  // Can always ping human
  },
};
```

## On-Disk Project Structure

All project management happens through **plain text files** in a `.project/` directory. This makes the project state:

- **Version controlled** - Full history of project evolution
- **Human readable** - No proprietary formats, just markdown
- **Diff-friendly** - Easy to see what changed
- **Tool agnostic** - Works with any editor or viewer

### Directory Structure

```
.project/
├── README.md              # Project overview and quick status
├── plan.md                # High-level project plan and phases
├── status.md              # Current status, updated frequently
├── decisions/             # Architecture Decision Records (ADRs)
│   ├── 001-use-bun.md
│   ├── 002-maildir-for-ipc.md
│   └── ...
├── tasks/
│   ├── backlog.md         # Future work, ideas, nice-to-haves
│   ├── current.md         # Active sprint/iteration tasks
│   ├── blocked.md         # Tasks waiting on something
│   └── completed.md       # Done tasks (recent, then archived)
├── feedback/
│   ├── pending.md         # Human feedback awaiting action
│   ├── incorporated.md    # Feedback that's been addressed
│   └── sessions/          # Per-session feedback logs
│       └── 2024-01-15.md
├── communications/
│   ├── drafts/            # Messages being composed
│   └── sent/              # Sent updates (for reference)
└── acceptance/
    ├── phase-1.md         # Acceptance criteria for Phase 1
    ├── phase-2.md
    └── ...
```

## File Formats

### status.md

Updated frequently (every significant change):

```markdown
# Project Status

**Last Updated**: 2024-01-15 14:30 UTC
**Updated By**: PM Arm

## Current State

🟢 **On Track** | Phase 1: Observatory Foundation

### Active Work

| Arm | Task | Status | Since |
|-----|------|--------|-------|
| api-arm | Hono server setup | 🔨 In Progress | 2h ago |
| ui-arm | React shell | 🔨 In Progress | 1h ago |
| test-arm | API test suite | ⏳ Waiting | Blocked on api-arm |

### Recent Completions (Last 24h)

- ✅ Database schema design (api-arm)
- ✅ WebSocket integration plan (api-arm)

### Blockers

None currently.

### Human Attention Needed

- [ ] Review API authentication approach (see decisions/003-api-auth.md)

---

## Metrics

- Tasks completed this week: 7
- Tasks in progress: 3
- Estimated completion: Phase 1 by Jan 20
```

### tasks/current.md

Active work items:

```markdown
# Current Tasks

## In Progress

### [TASK-012] Hono API Server Setup
- **Assigned**: api-arm
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
- **Assigned**: ui-arm
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
- **Assigned**: test-arm
- **Waiting On**: TASK-012 (Hono server)
- **Estimate**: 2 hours

**Description**: Create test suite for API endpoints.

**Notes**: Can start once api-arm has basic endpoints working.
```

### feedback/pending.md

Human feedback awaiting action:

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
**Completed**: 2024-01-15 14:00

---

### [FB-008] Add project management arm
**Received**: 2024-01-15 14:30
**Source**: Human (Tim)
**Priority**: High

> Need documentation about management of the software project. The brain 
> probably needs an arm that updates docs, tasks, acceptance criteria, 
> and makes sure human feedback is incorporated properly.

**Status**: 🔨 In Progress
**Assigned To**: pm-arm (self)
**Notes**: Creating project-management.md and .project/ structure.
```

### decisions/001-example.md

Architecture Decision Records:

```markdown
# ADR-001: Use Bun as Runtime

**Status**: Accepted
**Date**: 2024-01-10
**Deciders**: Human (Tim)

## Context

Need to choose a JavaScript/TypeScript runtime for Octopai.

## Decision

Use Bun as the primary runtime.

## Rationale

- First-party SQLite support (bun:sqlite)
- Fast startup time (good for spawning arms)
- TypeScript native
- Built-in test runner
- Growing ecosystem

## Consequences

**Positive**:
- Simplified stack (no separate bundler/transpiler)
- Fast development iteration
- Native SQLite without dependencies

**Negative**:
- Newer ecosystem, some packages may not work
- Team may need to learn Bun-specific APIs
- Less battle-tested than Node.js

## Alternatives Considered

- **Node.js**: More mature, but needs more tooling
- **Deno**: Good security model, but smaller ecosystem
```

## PM Arm Behaviors

### 1. Status Updates

The PM arm regularly updates `status.md`:

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

When arms complete work:

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

When human provides feedback:

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

PM arm drafts updates for humans:

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

Keep docs in sync with actual implementation:

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

The PM arm follows these principles for human communication:

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

The PM arm tracks metrics for project health:

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

The PM arm has special privileges:

```typescript
interface PMBrainIntegration {
  // PM can observe all arm activity
  subscriptions: ["arm.*", "proposal.*", "deploy.*", "claim.*"];
  
  // PM can request arm attention
  canPing: true;
  
  // PM can escalate to human without proposal
  canEscalate: true;
  
  // PM updates are visible in Observatory dashboard
  statusFeed: true;
}
```

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
