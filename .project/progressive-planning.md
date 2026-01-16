# Progressive Planning System

## Overview

The Brain doesn't pre-generate all tasks upfront. Instead, it **progressively determines** the next task at runtime by re-evaluating plan documents, completed task history, and status reports.

## Inputs to Task Determination

```
                    ┌──────────────────┐
                    │   Plan Documents │ ← Updated by Architect tasks
                    │   (.project/plans)│
                    └────────┬─────────┘
                             ↓
    ┌─────────────────────────┼─────────────────────────┐
    ↓                         ↓                         ↓
┌──────────────┐    ┌─────────────────┐    ┌──────────────────┐
│ Completed    │    │ Status Reports  │    │ Current System   │
│ Tasks History│    │ from Arms       │    │ State            │
│              │    │                 │    │                  │
│ - What done  │    │ - Discoveries   │    │ - Open discoveries│
│ - Outcomes   │    │ - Issues found  │    │ - Blocked tasks  │
└──────────────┘    │ - Progress made │    │ - In-progress    │
                    └─────────────────┘    └──────────────────┘
                             ↓
                    ┌──────────────────┐
                    │   Brain Re-      │ ← Determines next task
                    │   evaluation     │
                    └────────┬─────────┘
                             ↓
                    ┌──────────────────┐
                    │  Next Task for   │ → Assigned to arm
                    │  Arm             │   with context bundle
                    └──────────────────┘
```

## Plan Documents

Plan documents are **stable** during execution:
- Created by Architect tasks
- Describe the goal and approach
- Contain bullet points to accomplish
- Only change when Architect revises them

Example plan:
```markdown
# Phase 1: User Authentication

## Goal
Implement OAuth2 user authentication

## Approach
1. Add OAuth2 provider configuration
2. Create login/logout API endpoints
3. Update user model for auth
4. Write integration tests
5. Update documentation
```

## Task Determination Algorithm

When an arm asks for a task or completes a task:

1. **Read plan document** for the current phase/goal
2. **Check completed tasks** - what bullet points are done?
3. **Check status reports** - any issues, discoveries, blockers?
4. **Determine next step**:
   - If bullet point is marked done → skip
   - If bullet point has status issues → assign "verify & polish" task
   - If bullet point is incomplete → assign development task
   - If all done → ask Architect for next phase

### Decision Logic

```
For each bullet point in plan:
  IF completed AND no issues:
    → Mark as done, continue
  
  IF completed BUT has discoveries/issues:
    → Assign "check, verify, polish" task
  
  IF incomplete AND ready to work on:
    → Assign development task
  
  IF incomplete AND blocked:
    → Note blocker, skip for now
```

## Task Types for Re-evaluation

### Fresh Task
Assigned when starting a new bullet point from the plan.

### Verify & Polish Task
Assigned when:
- A bullet point was completed but has open discoveries
- A status report mentioned issues
- The same area was worked on before

Example: "Review completed task 'Add OAuth2 provider' - there were discoveries about rate limiting. Verify the implementation and address discoveries."

### Clarification Task
Assigned when:
- An arm asks for clarification
- Status report indicates confusion
- Plan is ambiguous

### Blocked Task
Assigned when:
- A dependency is missing
- Another task must complete first

## Status Reports Influence Task Assignment

Status reports contain:
- What was done
- What was discovered
- What's blocking progress
- Recommendations for next steps

The Brain uses this to adjust task assignment:

| Status Report Content | Brain Action |
|----------------------|--------------|
| "Tests failing" | Assign QA verify task |
| "Found security issue" | Create discovery, assign fix task |
| "Blocked on API" | Mark task blocked, assign unblocker |
| "Completed successfully" | Mark done, get next task |
| "Need clarification" | Assign clarification task |

## Example Flow

```
1. Human: "Add user authentication"
2. Architect Task → Creates plan with 5 bullet points
3. Brain reads plan → Assigns task 1 (OAuth2 config) to Arm A
4. Arm A completes task, files status report
5. Brain reads status report + plan:
   - Task 1: marked done
   - Status: mentions "rate limiting concern"
   - → Assigns "verify & polish" for task 1
6. Arm A (or Arm B) does verify & polish
7. Brain reads verify status:
   - All discoveries addressed
   - → Assigns task 2 (login API)
8. ...continues until plan complete
```

## Context Bundle for Progressive Tasks

When assigning any task, the Brain includes:

1. **Task classification** (verify & polish / development / clarification)
2. **Plan excerpt** - the relevant bullet points
3. **History** - previous attempts at this task
4. **Discoveries** - related discoveries
5. **Status reports** - relevant status report excerpts
6. **Instructions** - specific to the task type

## Plan Document Format

Plans should have:
- Clear phase/goal statement
- Numbered or bulleted implementation steps
- Dependencies noted
- Acceptance criteria per step

```markdown
# Phase N: [Phase Name]

## Goal
[Brief description of what this phase accomplishes]

## Approach
1. [Step 1] - [Brief description]
   - Sub-task A
   - Sub-task B
2. [Step 2] - [Brief description]
3. [Step 3] - [Brief description]

## Dependencies
- Phase N-1 must be complete
- Document X must be updated

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2
```

## Brain Re-evaluation Points

The Brain re-evaluates the plan at:

1. **When an arm asks for a task** (idle arm needs work)
2. **When a task completes** (determine next step)
3. **When a status report arrives** (adjust priorities)
4. **When discoveries are filed** (may affect plan)
5. **Periodic check** (every N polls, verify progress)

## Error Handling

If the Brain cannot determine the next task:
1. Check if plan is complete → Ask Architect for next phase
2. Check if blocked → Notify human, suggest unblocking
3. Check if ambiguous → Assign clarification task to Architect
4. Otherwise → Escalate to human

---

This system ensures:
- Tasks are always aligned with the current plan
- Previous work is respected (not duplicated)
- Issues are caught and addressed (verify & polish)
- Progress is tracked against the plan
- The human is informed of blockers and progress
