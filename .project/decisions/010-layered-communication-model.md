# ADR-010: Layered Communication Model for Multi-Arm Coordination

## Status

Accepted

## Date

2026-01-24

## Context

Octopai aims to achieve emergent intelligence by running multiple LLM agents (arms) with different perspectives on the same codebase. These arms need to:

1. Share discoveries and learnings with each other
2. Coordinate to avoid conflicts (file contention)
3. Build on each other's work (sequential refinement loops)
4. Stay aware of workspace state without constant polling

We considered several communication patterns:

**A. Hub-and-Spoke (All through Brain)**
- Pros: Full visibility, easier governance, simpler debugging
- Cons: Brain is bottleneck, higher latency, doesn't feel emergent

**B. Direct Messaging (Peer-to-Peer)**
- Pros: Lower latency, more autonomous, scales better
- Cons: Coordination complexity, harder to audit, governance gaps

**C. Shared Context (Read/Write to shared docs)**
- Pros: Asynchronous, persistent, Brain can curate
- Cons: No conversations, polling overhead, race conditions

**D. Proposals Only (Formal governance system)**
- Pros: Structured, auditable, brain-mediated
- Cons: Too formal for questions, slow, only for decisions

## Decision

We adopt a **Layered Communication Model** that combines multiple patterns for different purposes:

### Layer 1: Task Assignment (Hub-and-Spoke)

All task assignments flow through the Brain.

- Brain assigns tasks to arms with full context bundles
- Arms report completion/failure via status reports
- Brain orchestrates sequential refinement loops

### Layer 2: Discoveries (Shared Context, Read-Only During Task)

Arms write discoveries to SQLite. Arms receive discoveries in context bundles at task start.

- Arms do NOT poll discoveries during normal work
- Discoveries are batched into context bundles when Brain assigns tasks
- If Brain sends an interrupt, fresh discoveries are included

### Layer 3: Context Requests (Arm-Initiated, Brain-Mediated)

Arms can request workspace context from Brain via MCP tools.

- `get_workspace_status` - Query what other arms are doing, file claims
- `request_context_update` - Request fresh discoveries mid-task (optional)

### Layer 4: Brain Interrupts (Push, Conflict-Driven)

Brain pushes updates to arms only when necessary.

- Triggered by: file conflicts, critical discoveries, priority changes
- Includes fresh context since task started
- Conservative approach: only on conflicts (not periodic)

### Layer 5: Proposals (Formal Governance)

Major decisions (deploy, breaking changes) go through proposal system.

- Arguments and signals from arms
- Brain calculates consensus
- Human escalation when needed

### What We Explicitly Exclude

**No direct arm-to-arm messaging.** Arms cannot prompt each other directly. All communication is mediated by the Brain or written to shared context (discoveries).

**Rationale:**
- Brain maintains full visibility and control
- Simpler protocol, fewer edge cases
- Arms forced to write clear status reports (observable artifacts)
- Can add direct messaging later if proven necessary

## Communication Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                    LAYERED COMMUNICATION MODEL                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Layer 1: Task Assignment (Hub-and-Spoke)                           │
│  ┌────────┐     task_assignment      ┌────────┐                    │
│  │  Brain │ ─────────────────────────▶│  Arm   │                    │
│  │        │ ◀─────────────────────────│        │                    │
│  └────────┘     status_report        └────────┘                    │
│                                                                     │
│  Layer 2: Discoveries (Shared Context)                              │
│  ┌────────┐                          ┌────────┐                    │
│  │  Arm A │ ──write──▶ ┌──────────┐ ◀──write──│  Arm B │           │
│  └────────┘            │ SQLite   │           └────────┘           │
│       ▲                │Discoveries│                ▲               │
│       │                └──────────┘                │               │
│       └───── context_bundle (at task start) ───────┘               │
│                       ▲                                             │
│                       │                                             │
│                  ┌────────┐                                         │
│                  │  Brain │ (curates, includes in bundles)          │
│                  └────────┘                                         │
│                                                                     │
│  Layer 3: Context Requests (On-Demand)                              │
│  ┌────────┐   get_workspace_status   ┌────────┐                    │
│  │  Arm   │ ─────────────────────────▶│  Brain │                    │
│  │        │ ◀─────────────────────────│        │                    │
│  └────────┘   workspace_summary      └────────┘                    │
│                                                                     │
│  Layer 4: Interrupts (Conflict-Driven Push)                         │
│  ┌────────┐    interrupt + context   ┌────────┐                    │
│  │  Brain │ ─────────────────────────▶│  Arm   │                    │
│  └────────┘  (on conflicts only)     └────────┘                    │
│                                                                     │
│  Layer 5: Proposals (Formal Governance)                             │
│  ┌────────┐      proposal            ┌────────┐                    │
│  │  Arm   │ ─────────────────────────▶│  Brain │                    │
│  │        │ ◀─────────────────────────│        │                    │
│  └────────┘   consensus_result       └────────┘                    │
│                         │                                           │
│                         ▼                                           │
│                   ┌───────────┐                                     │
│                   │  Human    │ (escalation for critical)           │
│                   └───────────┘                                     │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## MCP Tools Required

### `get_workspace_status`

Query what other arms are doing, especially for file conflict detection.

```typescript
interface GetWorkspaceStatusInput {
  filePath?: string;     // Check specific file
  armId?: string;        // Check specific arm
  includeDiscoveries?: boolean;
}

interface GetWorkspaceStatusOutput {
  arms: Array<{
    armId: string;
    status: "idle" | "working";
    currentTask?: {
      subject: string;
      classification: string;
      filesInvolved: string[];
    };
    relevantDiscoveries?: Discovery[];
  }>;
  fileClaims: Array<{
    filePath: string;
    ownedBy: string;
    claimedAt: string;
    taskContext: string;
  }>;
}
```

### `request_context_update`

Request fresh discoveries and context from Brain during work.

```typescript
interface RequestContextUpdateInput {
  reason: string;
  focus?: string;
  includeArmActivity?: string[];
}

interface RequestContextUpdateOutput {
  newDiscoveries: Discovery[];
  relatedActivity: Array<{
    armId: string;
    action: string;
    timestamp: string;
    filesAffected: string[];
  }>;
  contextualNotes: string;
}
```

## Consequences

### Positive

- Brain maintains full visibility and can intervene
- Arms can build on each other's discoveries
- File conflicts detected and communicated
- Simpler than peer-to-peer protocols
- Auditable: all communication visible to Brain
- Room to grow: can add direct messaging later

### Negative

- Brain is still a bottleneck for coordination
- Arms cannot have real-time conversations
- Context requests add latency
- Interrupt mechanism requires session injection capability

### Neutral

- Discoveries filtered by relevance (file path overlap) to reduce noise
- No caching of workspace status (uses event streams for freshness)
- Conservative interrupt policy (conflicts only, not periodic)

## Implementation Notes

1. **Discovery relevance filtering**: Include discoveries that mention files the arm is working on. Start with simple file path matching, add LLM-based relevance later if needed.

2. **Workspace status freshness**: Use existing activity event streams from Brain rather than caching. This ensures real-time accuracy.

3. **Interrupt injection**: Requires ability to inject messages into active OpenCode sessions. May need harness-specific implementation.

## References

- [Architecture Overview](../../docs/architecture/overview.md)
- [Governance Model](../../docs/architecture/governance.md)
- [Components](../../docs/architecture/components.md)
