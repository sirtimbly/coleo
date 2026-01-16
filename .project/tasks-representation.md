# Task Representation in Octopai

## Problem with Traditional Task Lists

A fixed database table with CRUD operations doesn't fit a **progressive planning system**:

- Tasks are **determined at runtime**, not pre-created
- The "next task" changes based on context
- Task history is more important than future tasks
- The "backlog" is actually the plan document, not a database

## New Model: Timeline + Next Task

### What the UI Should Show

#### 1. Recent Activity Timeline

Show what was just accomplished:

| Column         | Description                           |
| -------------- | ------------------------------------- |
| Task           | What was done                         |
| Arm            | Which arm did it                      |
| Duration       | How long it took                      |
| Outputs        | Files changed, discoveries, artifacts |
| Classification | architect / development / qa          |

**Query:**
```sql
SELECT * FROM tasks
WHERE status = 'completed'
ORDER BY completed_at DESC
LIMIT 20
```

#### 2. Current Work In Progress

Show what's being worked on right now:

| Column         | Description          |
| -------------- | -------------------- |
| Task           | What's being done    |
| Arm            | Which arm is working |
| Started        | When it started      |
| Classification | What type of task    |

**Query:**
```sql
SELECT * FROM tasks
WHERE status IN ('claimed', 'in_progress')
ORDER BY started_at ASC
LIMIT 5
```

#### 3. Next Task Preview

The **single next task** ready for an idle arm. This is **not** a static list—it's dynamically determined:

| Column         | Description                          |
| -------------- | ------------------------------------ |
| Task           | The next bullet point from the plan  |
| Source         | Which plan document it comes from    |
| Classification | What type of work (dev/qa/verify)    |
| Context        | Summary of relevant discoveries/docs |

**How it's determined:**
1. Read current plan document
2. Check completed tasks for this plan
3. Check status reports for this plan
4. Calculate what comes next
5. **This is a single value**, not a list

### What NOT to Show

- ❌ Full task backlog (too many items, mostly speculative)
- ❌ Task assignment UI (brain assigns tasks automatically)
- ❌ Manual task creation (architect creates plans, not tasks)
- ❌ Drag-and-drop prioritization (plan document is the source of truth)

## Task Status in Database

Tasks exist **only when started or completed**:

| Status        | Meaning                           |
| ------------- | --------------------------------- |
| `claimed`     | Arm has accepted, not started yet |
| `in_progress` | Arm is actively working           |
| `completed`   | Arm finished successfully         |
| `failed`      | Arm couldn't complete             |

**No `pending` status**—tasks are determined dynamically, not queued up.

## Plan Documents Are the Backlog

The plan document (`.project/plans/*.md`) is the **true source of truth** for what needs to be done.

**START EXAMPLE**

```markdown
# Phase 1: User Authentication

## Goal
Implement OAuth2 authentication

## Approach
1. [ ] Add OAuth2 provider configuration
2. [ ] Create login API endpoints
3. [ ] Write integration tests
4. [ ] Update documentation
```

Brain checks this file to determine what's next. Humans edit this file to change direction.

## Timeline Example

```
┌─────────────────────────────────────────────────────────────┐
│ Recently Completed                                          │
├─────────────────────────────────────────────────────────────┤
│ ✅ Add OAuth2 provider config | backend | 5min | 3 files   │
│ ✅ Create login API endpoints | backend | 12min | 2 files  │
│ ✅ Write integration tests | qa-engineer | 8min | 5 files  │
│ ✅ Update auth documentation | fullstack | 3min | 1 file   │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ In Progress                                                │
├─────────────────────────────────────────────────────────────┤
│ 🔄 Verify OAuth2 implementation | backend | started 2m ago │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Next Task Ready                                            │
├─────────────────────────────────────────────────────────────┤
│ 📋 "Create logout API endpoints" | development             │
│    From: Phase 1 plan, bullet 2                            │
│    Context: 2 discoveries about rate limiting              │
└─────────────────────────────────────────────────────────────┘
```

## Task Database Schema (Simplified)

```sql
-- Tasks that have been worked on
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  plan_id TEXT,           -- Which plan this relates to
  subject TEXT NOT NULL,  -- What the task was about
  description TEXT,       -- Full task context
  classification TEXT,    -- architect | development | qa | verify
  status TEXT,            -- claimed | in_progress | completed | failed
  assigned_to TEXT,       -- arm_id
  started_at TEXT,
  completed_at TEXT,
  artifacts TEXT,         -- JSON: files changed, discoveries, etc.
  created_at TEXT DEFAULT (datetime('now'))
);

-- Index for recent activity
CREATE INDEX idx_tasks_recent ON tasks(completed_at DESC);
```

## API Endpoints

| Endpoint                         | Returns                                  |
| -------------------------------- | ---------------------------------------- |
| `GET /api/tasks/recent?limit=20` | Recently completed tasks                 |
| `GET /api/tasks/in-progress`     | Currently working tasks                  |
| `GET /api/tasks/next`            | **Single** next task determined by Brain |
| `GET /api/tasks/:id`             | Task details with artifacts              |

**The `/api/tasks/next` endpoint** is key—it calls the Brain's progressive planning logic to determine what comes next.

## What the Brain Does

```
when arm asks for task OR task completes:
  1. Read current plan document
  2. Query completed tasks for this plan
  3. Parse status reports for this plan
  4. Calculate next incomplete bullet point
  5. Build context bundle (discoveries, docs)
  6. Return as "next task"
```

## Summary

| Old Model          | New Model                      |
| ------------------ | ------------------------------ |
| Static task list   | Dynamic next task              |
| CRUD operations    | Read timeline + determine next |
| Backlog management | Plan document is source        |
| Manual assignment  | Brain auto-assigns             |
| Many pending tasks | Few in-progress tasks          |

The UI becomes a **timeline of accomplishment** plus **what's next**, not a **backlog to manage**.
