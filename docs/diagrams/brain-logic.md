---
title: Coleo Brain Logic - Idle Detection & Arm State Management
---

## Overview

The brain runs a polling cycle every 30 seconds that:
1. **Scans** for running arms and adds them to tracking
2. **Prompts** idle arms to check for available work
3. **Detects** stuck loops where arms repeatedly respond with "idle" without productive work

```mermaid
flowchart TD
    %% Styles
    classDef process fill:#e1f5fe,stroke:#01579b,stroke-width:2px
    classDef decision fill:#fff3e0,stroke:#e65100,stroke-width:2px,shape:rhombus
    classDef state fill:#f3e5f5,stroke:#4a148c,stroke-width:2px
    classDef external fill:#e8f5e9,stroke:#1b5e20,stroke-width:2px
    classDef arm fill:#ffebee,stroke:#b71c1c,stroke-width:2px

    subgraph POLL["Poll Cycle - Runs every 30s"]
        A[Start Poll] --> B[scanForRunningArms]
        B --> C{API Server Available?}
        C -->|Yes| D[Get Idle Arms]
        C -->|No| E[Skip API Arms]
        D --> F[promptIdleArms]
        F --> G[checkIdleArmStuckLoops]
        G --> S8[syncPlanTasks<br/>reads .project/plan.md]
        S8 --> S8a[processInbox<br/>reads .project/inbox.md]
        S8a --> S8b[checkDocUpdateTrigger]
        S8b --> S8c[reEvaluatePlanProgress]
        S8c --> H[End Poll]
        E --> H
    end

    subgraph SCAN["Arm Detection - scanForRunningArms()"]
        B --> B1[Query DB for known arms]
        B1 --> B2[For each known arm]
        B2 --> B3{Process alive?}
        B3 -->|No| B4[Mark stopped via state machine]
        B3 -->|Yes| B5[Check harness type]
        B5 --> B6{API Harness + Server OK?}
        B6 -->|No| B6a[Skip arm]
        B6 -->|Yes| B7[Add to tracking]
        B7 --> B8["Record detection time<br/>armDetectionTimes.set(arm.id, now)"]
        B8 --> B9[Initialize state machine as idle]
    end

    subgraph IDLE["Idle Arm Prompting - promptIdleArms()"]
        F --> F1[Get all idle arms]
        F1 --> F2[For each idle arm]
        F2 --> F3{Grace period active?<br/>detected < armGracePeriodMinutes?}
        F3 -->|Yes| F3a[Skip - recently detected<br/>prevents interrupting autonomous work<br/>Config: brain.arm_grace_period_minutes<br/>Default: 5 minutes]
        F3 -->|No| F4{Health check - harness responsive?}
        F4 -->|No| F4a[Skip arm]
        F4 -->|Yes| F5[Get available tasks]
        F5 --> F6{Has tasks?}
        F6 -->|Yes| F7[Send prompt: get_full_briefing...]
        F6 -->|No| F8[Log: waiting for file changes]
        F7 --> F9[Record activity: arm_prompted]
        F3a --> F2
        F4a --> F2
    end

    subgraph STUCK["Stuck Loop Detection - checkIdleArmStuckLoops()"]
        G --> G1[Get idle arms]
        G1 --> G2[For each idle arm]
        G2 --> G3{Recent activity exists?<br/>>= 5 entries in 15min?}
        G3 -->|No < 5 entries| G3a[Skip - need more data]
        G3 -->|Yes| G4{New tracker?}
        G4 -->|Yes| G5[Check DB for productive activity<br/>last 60 min]
        G5 --> G6{Has productive activity?}
        G6 -->|Yes| G6a[Set lastProductiveAt, skip arm<br/>arm was working autonomously]
        G6 -->|No| G7[Initialize tracker: lastProductiveAt=null]
        G4 -->|No| G8[Check for productive activity since last prompt]
        G8 --> G9{Has productive?}
        G9 -->|Yes| G10[Reset promptCount, update lastProductiveAt]
        G9 -->|No| G11[Increment promptCount if just received prompt]
        G10 --> G2
        G11 --> G12[Calculate stuckMinutes<br/>time since lastProductiveAt]
        G12 --> G13{promptCount >= 3 OR<br/>stuckMinutes >= 5?}
        G13 -->|No| G2
        G13 -->|Yes| G14[handleIdleArmStuck - escalate]
    end

    subgraph INTERVENE["Escalation Interventions - handleIdleArmStuck()"]
        G14 --> I1{escalationLevel}
        I1 -->|0| I2[Interrupt + different prompt]
        I1 -->|1| I3[Force context compaction]
        I1 -->|2| I4[Kill and respawn arm]
        I1 -->|3| I5[Notify human via email]
        I2 --> I6[increment escalationLevel]
        I3 --> I6
        I4 --> I6
        I5 --> I6
        I6 --> G2
    end

    class A,B,D,G1,G2,F1,F2,B1,B2,F5,G4,G8,G12,S8,S8a,S8b,S8c process
    class C,F3,F4,F6,F9,G3,G4,G6,G9,G13,I1 decision
    class state,idle,blocked,disconnected,stopped state
    class External,DB,Arm external
    class arm arm
```

## File Reading Steps

After checking arm status, the brain reads markdown files to sync tasks:

| Step | Function | File(s) Read | Purpose |
|------|----------|--------------|---------|
| 8 | `syncPlanTasks()` | `.project/plan.md` | Extracts `- [ ]` checkboxes as tasks |
| 8a | `processInbox()` | `.project/inbox.md` | Parses `## headers` and `- [ ]` items, creates tasks, clears inbox |
| 8b | `checkDocUpdateTrigger()` | (various) | Checks if docs need updating |
| 8c | `reEvaluatePlanProgress()` | (various) | Creates verification tasks for issues |

**Inbox processing:**
- `## Header` creates task with header as title, following paragraph as description
- `- [ ] Text` creates task with Text as title
- Deduplicates against existing tasks by title similarity
- Clears inbox after processing (goal: inbox always empty after brain poll)

## Arm State Machine

```mermaid
stateDiagram-v2
    direction TB
    state "disconnected<br/>(not tracked)" as disconnected
    state "idle<br/>(ready for work)" as idle
    state "task assigned<br/>(awaiting ack)" as task_assigned
    state "working<br/>(processing a task)" as working
    state "stuck detection" as stuck
    state "intervention" as intervention
    state "stopped" as stopped

    [*] --> disconnected
    disconnected --> idle: process found
    idle --> task_assigned: assign task
    task_assigned --> working: acknowledge
    working --> idle: complete
    idle --> stuck: no activity
    stuck --> working: activity found
    stuck --> intervention: confirmed
    intervention --> idle: recover
    working --> stopped: dies
    idle --> stopped: dies
    task_assigned --> stopped: dies
    stopped --> disconnected: restart
```

## State Machine Truth Table

| From State | Event | To State | Notes |
|------------|-------|----------|-------|
| spawning | PROCESS_STARTED | starting | Process is running |
| starting | HARNESS_CONNECTED | idle | Harness ready |
| idle | TASK_ASSIGNED | task_assigned | Brain assigns task |
| task_assigned | TASK_ACKNOWLEDGED | working | Arm accepts task |
| task_assigned | TIMEOUT (3min) | idle | Arm didn't ack, release task |
| working | TASK_COMPLETED | idle | Task done |
| working | TASK_FAILED | idle | Task failed |
| idle/working | CONNECTION_LOST | disconnected | Network issue |
| disconnected | CONNECTION_RESTORED | previous | Reconnected |
| any | STOP | stopped | Intentional stop |

**Key insight:** The brain assigns tasks to arms in `idle` state, transitioning them to `task_assigned`. The arm must then explicitly acknowledge (via `acknowledge_task` or `claim_task` tool) to transition to `working`. This two-step process ensures both brain and arm agree on task ownership.

## Autonomous Arm Protection Sequence

This diagram shows the correct task assignment flow:

```mermaid
flowchart TD
    Discover["Arm reports idle; Brain announces available work"] --> Briefing["Arm requests a full briefing and receives task context"]
    Briefing --> Claim["Arm claims the task; state becomes task_assigned"]
    Claim --> PersistClaim["SQLite records the claim and marks the arm busy"]
    PersistClaim --> Acknowledge["Brain queues the assignment; the arm acknowledges it"]
    Acknowledge --> Working["State becomes working; SQLite marks the task in progress"]
    Working --> Ready["Arm works on the task"]
```

## Autonomous Arm Protection Flow

When the brain starts up and finds arms that were working autonomously:

```mermaid
flowchart TD
    Start["Brain starts<br/>Scan SQLite for busy arms"] --> Probe["Check whether the arm's process is alive"]
    Probe --> Alive{"Process alive?"}
    Alive -->|No| Stop["Mark the arm stopped"]
    Alive -->|Yes| Grace["Mark idle, record detection time,<br/>and honor the configured grace period"]
    Grace --> Check["Inspect recent activity<br/>and productive actions"]
    Check --> FoundWork{"Recent work found?"}
    FoundWork -->|No| Monitor["Resume normal health monitoring"]
    FoundWork -->|Yes| Protect["Record last productive time<br/>and skip stuck detection"]
    Protect --> Continue["Arm continues without interruption"]
```

## Configuration

The grace period and other brain settings are configurable via:

1. **TOML config file** (`~/.coleo/config.toml`):
```toml
[brain]
poll_interval_ms = 30000        # Poll cycle interval (ms)
max_arms = 8                    # Maximum concurrent arms
arm_grace_period_minutes = 5    # Grace period before prompting newly detected arms
```

2. **Environment variables**:
```bash
OCTOPAI_POLL_INTERVAL_MS=30000
OCTOPAI_MAX_ARMS=8
OCTOPAI_ARM_GRACE_PERIOD_MINUTES=5
```

3. **Database config table**:
```sql
INSERT INTO config (key, value) VALUES
  ('brain_poll_interval_ms', '30000'),
  ('brain_max_arms', '8'),
  ('brain_arm_grace_period_minutes', '5');
```

**Default values:**
- `brain_poll_interval_ms`: 30000 (30 seconds)
- `brain_max_arms`: 8
- `brain_arm_grace_period_minutes`: 5 (minutes)

## Key Design Decisions

### 1. Grace Period for Newly Detected Arms
- Arms detected during `scanForRunningArms()` are not prompted for a configurable grace period
- Default: **5 minutes**
- This prevents interrupting arms that were working autonomously
- Timer starts when `armDetectionTimes.set()` is called
- Config via: `brain.arm_grace_period_minutes` in config.toml, or `OCTOPAI_ARM_GRACE_PERIOD_MINUTES` env var

### 2. Database-Backed Productive Activity Check
- When a new stuck-loop tracker is created, query DB for activity in last 60 minutes
- If productive activity found (heartbeat, claim_task, complete_task, file changes)
- Set `lastProductiveAt` and skip stuck detection
- This prevents false positives for arms that were doing real work

### 3. Productive Actions List
```typescript
const productiveActions = [
  "heartbeat",
  "claim_task",
  "acknowledge_task",
  "complete_task",
  "get_my_instructions",
  "task_progress",
  "file_changed",
  "file_created",
  "file_deleted",
  "tool_call",
];
```

### 4. Escalation Levels
| Level | Action | When Used |
|-------|--------|-----------|
| 0 | Interrupt + different prompt | First stuck detection |
| 1 | Force context compaction | Still stuck after interrupt |
| 2 | Kill and respawn arm | Still stuck after compaction |
| 3 | Notify human via email | Cannot recover automatically |
