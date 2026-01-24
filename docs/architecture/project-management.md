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
  planFile: string;                           // .project/plan.md contents
  requirementsFile: string;                   // .project/requirements.md contents
  decisionsIndex: string[];                   // .project/decisions/*.md
  inboxFile: string;                         // .project/inbox.md contents
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
├── inbox.md               # Quick task input - processed and cleared by brain
├── decisions/             # Architecture Decision Records (ADRs)
│   ├── 001-use-bun.md
│   ├── 002-maildir-for-communication.md
│   ├── ...
├── acceptance/
│   ├── phase-0.md         # Acceptance criteria for Phase 0
│   ├── phase-1.md
│   ├── phase-2.md
│   └── ...
└── plans/                 # Implementation plans generated by architect tasks
```

> Note: Tasks are stored in SQLite (the system of record), not in markdown files. The `inbox.md` file is the only task input mechanism - items are converted to database tasks and the inbox is cleared.

## File Formats

### inbox.md

Quick task input that the brain processes every poll cycle. Items are parsed, deduplicated against existing tasks, and then the inbox is cleared.

```markdown
# Inbox

## Add favicon to web app
Need Octopai branding - octopus icon for the browser tab.

- [ ] Update API documentation for new endpoints
- [ ] Review error handling in arm spawner
```

**Format rules:**
- `## Header` creates a task with the header as title, following paragraph as description
- `- [ ] Text` creates a task with Text as title
- After processing, items become tasks in SQLite and the inbox is cleared
- Goal: inbox should always be empty after brain processes it

## Architect Project-Management Behaviors

The following behaviors describe **architect project-management tasks**, not a dedicated PM arm type. Any general-purpose arm can perform these when assigned the appropriate classification, template, and context.

### 1. Status Updates

> **Note**: Full status report automation is planned for Phase 2.4. The interfaces below describe the target behavior.

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

Tasks are stored in SQLite (see `tasks` table schema). When tasks complete, the brain updates the database:

```typescript
async function onTaskCompleted(armId: string, taskId: string): Promise<void> {
  // Update task status in database
  await db.run(`
    UPDATE tasks 
    SET status = 'completed', 
        completed_at = datetime('now'),
        assigned_to = ?
    WHERE id = ?
  `, [armId, taskId]);

  // Check if any blocked tasks can now start
  await checkUnblockedTasks(taskId);

  // Update status
  await updateStatus({ event: "task_completed" });
}
```

### 3. Feedback Incorporation

Human feedback flows through `inbox.md` and becomes tasks in SQLite:

```typescript
// Feedback added to inbox.md by human or email processor
// Brain's processInbox() parses and creates tasks:

async function processInbox(): Promise<void> {
  const inboxPath = path.join(projectDir, "inbox.md");
  const content = await fs.readFile(inboxPath, "utf-8");
  
  const items = parseInboxItems(content);
  
  for (const item of items) {
    // Check for duplicates by title similarity
    const existing = await findSimilarTask(item.title);
    if (existing) continue;
    
    // Create task in SQLite
    await db.run(`
      INSERT INTO tasks (id, subject, description, source_type, priority)
      VALUES (?, ?, ?, 'manual', 'normal')
    `, [generateId(), item.title, item.description || ""]);
  }
  
  // Clear inbox after processing
  await fs.writeFile(inboxPath, "# Inbox\n");
}
```

### 4. Communication Drafting

> **Note**: Automated communication drafting is planned for Phase 2.6 (Agentic Brain). The interfaces below describe the target behavior.

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

> **Note**: Full metrics collection is partially implemented. Some metrics (task completion, arm status) are available; others (feedback incorporation rate, doc sync score) are planned for future phases.

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

The choice to use plain text files for **human-facing project documentation**:

| Benefit | Explanation |
|---------|-------------|
| **Transparency** | Anyone can read the files, no special tools needed |
| **Git-friendly** | Full history, diffs show exactly what changed |
| **AI-friendly** | Easy for arms to read/write markdown |
| **Human-friendly** | Humans can edit directly if needed |
| **Inspectable** | Debug by just reading the files |
| **Collaborative** | Multiple arms can update different files |

This approach makes the project state a **first-class part of the codebase**, not hidden in an external tool.

> **Note**: SQLite is the system of record for operational state (tasks, arms, activity, discoveries). Text files (`.project/*.md`) are the human-facing interface for plans, status, and decisions. The brain reads these files and syncs relevant items to SQLite.
