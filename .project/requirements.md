# Octopai Requirements & Philosophy

## Core Philosophy: Arms Are Not Specialized

**The fundamental design principle:** Arms are **general-purpose** AI agents that adapt their behavior based on the **task classification** they're executing.

An arm executing an architect task behaves like an architect. The same arm executing a QA task behaves like a QA engineer. The arm's behavior, context, and prompts are determined by the task type, not the arm's identity.

### Why Arms Should Not Be Specialized

1. **Flexibility**: The same arm can work on any type of task
2. **Context sharing**: No artificial barriers between task types
3. **Resource efficiency**: One arm can handle a mixed workload
4. **Simplicity**: No arm "type" management required

### How It Works

When the Brain assigns a task to an arm, it includes:
1. **Task classification** (architect, development, qa, etc.)
2. **Context bundle** (relevant discoveries, docs, decisions)
3. **Instructions** appropriate to the classification

The arm then operates with the mindset and tools appropriate to that classification.

---

## Progressive Planning System

Tasks are **not pre-generated**. The Brain **progressively determines** the next task at runtime by re-evaluating plan documents, completed task history, and status reports.

See [progressive-planning.md](./progressive-planning.md) for full details.

### Inputs

- Plan documents (from Architect tasks)
- Completed tasks history
- Status reports from arms
- Open discoveries

### Outputs

- Next task for an arm (single, not a list)
- Context bundle for that task
- Status update to human

### Task Determination

The Brain re-evaluates the plan when:
- An arm asks for a task
- A task completes
- A status report arrives
- Periodic check

**Decision logic:**
- Completed with issues? → Assign "verify & polish" task
- Ready to work? → Assign development task
- Blocked? → Notify human
- Complete? → Ask Architect for next phase

---

## Task Representation in UI

Tasks are **not a CRUD list**. See [tasks-representation.md](./tasks-representation.md) for full design.

### What the UI Shows

1. **Recent Activity Timeline** - Recently completed tasks with outputs
2. **In Progress** - Currently working tasks
3. **Next Task** - Single next task determined by Brain
4. **Collaborative Planning Board** - High-density grid for sorting items and discussing design with agents

### What the UI Does NOT Show

- ❌ Full task backlog (plan document is the source)
- ❌ Manual task assignment (Brain auto-assigns)
- ❌ Drag-and-drop prioritization

---

## Information Flow

```
Human Input (Requirements, Decisions)
         ↓
    ┌────────┐
    │ Brain  │ ← Processes via Architect tasks
    └────┬───┘
         ↓
    Plans & Tasks
         ↓
    ┌────────┐
    │  Arms  │ ← Execute tasks (dev/qa/other)
    └────┬───┘
         ↓
    Discoveries & Status Reports
         ↓
    ┌────────┐
    │ Brain  │ ← Aggregates and routes to human
    └────┬───┘
         ↓
    Human Notification
```

---

## Context Available to Arms

When executing any task, an arm can access:

1. **Requirements** - `.project/requirements.md` and related files
2. **Decisions** - `.project/decisions/` ADRs
3. **Plans** - `.project/plans/` implementation plans
4. **Tasks** - `.project/tasks/` work items
5. **Documentation** - `docs/` directory
6. **Discoveries** - From Brain (stored in SQLite)
7. **Prior Art** - Completed tasks and their outcomes

---

## Status Reports

**Purpose**: Keep humans informed of progress and issues.

**Triggered by**:
- Task completion
- Significant discoveries
- Blockers or issues
- Test failures

**Format**:
- What was done
- What was discovered
- What's blocking progress
- What's next

**Flow**:
```
Arm → Status Report → Brain → Human Notification (email)
```

---

## The Brain's Role

1. **Receives** requirements and decisions from human
2. **Classifies** work items as architect tasks
3. **Assigns** tasks to arms with appropriate context
4. **Collects** discoveries and status reports
5. **Notifies** human of important findings
6. **Maintains** system state (discoveries, tasks, plans)

The Brain doesn't execute tasks—it orchestrates the flow of work and information.

---

## Example: Feature Implementation

1. **Human** submits: "Add user authentication"
2. **Architect Task**:
   - Analyzes auth requirements
   - Creates plan: "OAuth2 integration"
   - Breaks into tasks: "Add OAuth2 provider", "Create login API", "Update user model"
3. **Development Task** (first task):
   - Reads requirements and plan
   - Explores codebase
   - Implements OAuth2 provider
   - Reports discovery: "Found auth middleware at src/auth/"
   - Files status report
4. **Development Task** (second task):
   - Implements login API
   - Discovers: "Rate limiting needed"
   - Reports discovery
5. **QA Task**:
   - Reads code changes
   - Writes tests for new endpoints
   - Ensures docs updated
   - Reports test failures (if any)
6. **Human** receives status reports and notifications throughout

---

## Key Distinctions

| Concept | Description |
|---------|-------------|
| **Arm** | A running AI agent instance (general-purpose) |
| **Task Classification** | The type of work being done (architect/dev/qa) |
| **Task** | A unit of work assigned to an arm |
| **Context** | Information provided to arm for task execution |

---

## Decision Records

See [decisions/](./decisions/) for architectural decisions related to this philosophy.
