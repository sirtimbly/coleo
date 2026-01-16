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

| Status Report Content    | Brain Action                        |
| ------------------------ | ----------------------------------- |
| "Tests failing"          | Assign QA verify task               |
| "Found security issue"   | Create discovery, assign fix task   |
| "Blocked on API"         | Mark task blocked, assign unblocker |
| "Completed successfully" | Mark done, get next task            |
| "Need clarification"     | Assign clarification task           |

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


## Plan for making arms generic and making the brain orchestration smarter

1) Remove arm domains completely
Scope:
- DB schema / migrations
- Types
- CLI and config
- Docs (we already softened them; this step fully removes the concept)
Planned changes:
- Database
  - arms table:
    - Drop domain and any domain-like columns (expertise if it encodes domain-ish roles).
    - If it’s painful to drop immediately, mark as deprecated in the schema and cut off all usage in code, then drop in a later migration.
  - Any tables where domain is referenced as a routing field (claims, tasks, etc.) should no longer use it for logic.
- Types (src/types/index.ts)
  - Remove domain from Arm or keep as an internal, unused legacy field that is not surfaced anywhere.
  - Remove ArmDomain and any domain enums/union types.
  - Remove any type-level logic that picks arms “by domain”.
- CLI & config
  - octopai arm spawn:
    - Remove --domain as a meaningful configuration surface. At most, keep it as a deprecated no-op (ignored) for backward compatibility.
  - Arm TOML configs:
    - Remove domain or clearly mark it as ignored.
  - Presets:
    - Stop modeling presets as domain teams (“frontend”, “backend”, “docs”); reframe them as:
      - Count/shape (number of arms, workdirs, harnesses).
      - Maybe runtime constraints (max concurrent arms, etc.), but no specialization.
- Docs
  - We’ve already marked domains as legacy; this step completes the job:
    - Strip references to domains from public stories.
    - Keep only task classification (on tasks) and file categories (in visualization) as organizing dimensions.
---
2) Remove arm‑level reputation logic
You described reputation as no longer central; arms are not persistent experts whose “influence score” matters.
Planned changes:
- Database
  - reputation_events table:
    - Either drop entirely, or keep as a generic event log without semantics that affect decision-making.
  - Any reputation column on arms:
    - Drop or freeze (no further updates).
- Types & brain logic
  - Remove any weighting logic that uses arm.reputation to:
    - Weight proposal arguments.
    - Prefer arms for certain work.
  - If you still want per-task or per-proposal trust annotations, model them as:
    - Part of the proposal/argument/signal itself (e.g. human-provided weights), not arm-global reputation.
- Docs
  - Governance docs already emphasize “anarchy with persuasion”; we should:
    - Downgrade reputation from a core mechanism to a potential future enhancement or delete it entirely.
    - Emphasize argument quality and evidence over arm identity.
---
3) Make tasks and proposals first‑class; arms become stateless executors
Arms should be simple conduits:
- They receive:
  - A task ID.
  - A prompt that includes all relevant context, plans, and constraints.
- They:
  - Perform work, discover information, and send activity, discoveries, and proposals back.
  - May not finish; partial progress is expected.
Planned changes:
- Tasks
  - Ensure there is a proper tasks table (SQLite) with at least:
    - id, subject, description, status, timestamps.
    - Optionally, classification (but this is task metadata, not arm metadata).
  - Task type:
    - Capture the brain’s “plan state” for that task (high-level; not full auto-planner yet).
    - No domain, no binding to a “specialist” arm.
- Proposals & discoveries
  - Strengthen proposals, proposal_arguments, proposal_signals as the main intelligence ledger:
    - Arms write proposals when they want to change direction or escalate choices.
  - Consider a “discoveries” concept (it can just be a type in the activity table):
    - activity.type = "discovery", with structured details.
    - This is where arms log “I learned X about Y” so the brain can surface/recall it later.
- Arm lifecycle
  - Arm records should track:
    - Identity (name, agent type, workdir).
    - Status (idle/working/paused).
    - Current task ID (if any).
  - Remove:
    - reputation, domain, any “expertise” describing areas of ownership.
- Brain responsibilities
  - On task start:
    - Brain prepares a rich prompt: relevant files, past proposals, discoveries, previous attempts.
    - Assigns the task to one or more arms (chaotic is acceptable).
  - On arm reports:
    - Brain stores:
      - Updates to task state (partial progress, remaining work).
      - Proposals and discoveries.
      - Any conflicts with other arms’ work (e.g. conflicting edits, alternative implementations).
---
4) Change the decision point: brain intervenes only on conflict/competition
Instead of centrally scheduling idle arms, the brain should arbitrate only when needed.
Planned changes:
- No automatic “pick best arm” when idle
  - For now, the mapping between task and arm can be:
    - Human-triggered (mail/CLI says “give this to arm X”).
    - Simple round-robin / random if needed, but not based on domain or reputation.
- Conflict detection
  - Use claims/activity (or just Git/diff) to detect:
    - When two arms are touching the same files or the same task in incompatible ways.
  - On conflict:
    - Brain pulls in proposals and discoveries from both arms.
    - Brain picks a winner (or escalates to human) and:
      - Marks one path as accepted.
      - Logs the alternative as an abandoned proposal.
- Multiple attempts
  - Task model supports:
    - Multiple attempt IDs or a notion of “attempt count”.
    - Arms can attach their work to task_attempt entries, not just the task itself.
  - Brain can then:
    - Keep history of multiple approaches.
    - Reuse those histories when restarting a task later with a different arm.
---
5) Align any remaining code paths with “dumber, long‑running arms”
This is more behavioral than schema, but the plan should acknowledge it.
Planned changes (conceptual; code changes later):
- Arm run loop
  - Ensure harnesses (esp. opencode-api) are set up to:
    - Tolerate long-running sessions.
    - Allow incremental progress (arms send intermediate mail / logs, not only “done”).
- Brain poller
  - Focus on:
    - Reading mail/task updates.
    - Recording activity, discoveries, and proposals.
    - Detecting conflicts.
  - Avoid:
    - Trying to constantly assign tasks by scanning for idle arms and “choosing the best one”.
- Configuration knobs
  - Introduce or document sliding scales on tasks:
    - Maximum wall-clock time or poll-cycles an arm is allowed to spend before:
      - The brain pauses it.
      - Or re-queues the task for another attempt.
  - This is a task-level control, not an arm-level “intelligence” slider.
---
