# Context Management

Each arm has a limited context budget to prevent cognitive overload. This page describes how context is managed at a high level and how file ownership works.

## Context Budget

Every arm operates within a context budget that limits how much information they hold at once.

### Budget Configuration (Conceptual)

The exact mechanics of context budgeting and pruning are handled by the harness (`opencode-api`) and the underlying model. Coleo treats these as **conceptual constraints** rather than implementing its own token-level pruning logic.

We think about budgets in terms of:

- **How many files** it is reasonable for an arm to consider at once
- **How much text** (roughly, tokens) those files represent
- **Which areas** of the repo are most relevant to the current task

In code, this is represented as a simple configuration shape that higher-level logic can reference when deciding what to show or emphasize to arms:

```typescript
interface ContextBudget {
  mode: "auto" | "manual";

  // Hints for manual/advanced use; not a hard tokenizer
  maxFiles?: number;         // Max files that should be considered
  maxTokens?: number;        // Rough guidance for prompt size
  maxDirectories?: number;   // Max directories before work should be narrowed
}
```

### Mode: Auto vs Manual

| Mode | Description | Use Case |
|------|-------------|----------|
| **Auto** | Harness/model manage context pruning internally | Default, hands-off |
| **Manual** | Humans give high-level hints (e.g., "focus only on these dirs") | Advanced, debugging or constrained work |

In practice, **auto** is the default: we trust `opencode-api` and the model to manage token budgets. Coleo focuses on passing **good, focused context** (relevant files, plan excerpts, decisions) rather than micromanaging token counts.

### Context Snapshot (Conceptual)

When we talk about an arm's "current context" in the Observatory or status reports, we mean a soft snapshot like:

```typescript
interface ContextSnapshot {
  files: string[];           // Files the arm is currently focused on
  estimatedTokens?: number;  // Optional rough estimate from harness
  utilization?: number;      // 0-1, rough sense of fullness (if available)
  lastUpdated?: Date;        // When this snapshot was last refreshed
}
```

This is primarily for **observability** and **human understanding**, not for driving a home-grown pruning algorithm.

## Ownership Protocol

Arms can optionally claim files before modifying them. Claims can be disabled for speed, with automatic detection when conflicts arise.

### Claim Modes

```typescript
interface ClaimConfig {
  mode: "strict" | "lazy" | "disabled";
  thrashingDetection: boolean;     // Auto-enable claims on conflict
  thrashingThreshold: number;      // Overwrites before triggering (default: 2)
}
```

| Mode | Behavior | Use Case |
|------|----------|----------|
| `strict` | Must claim before any write | High-conflict codebases, many arms |
| `lazy` | Claims optional, detected on conflict | Default - balance speed and safety |
| `disabled` | No claims, parallel writes allowed | Solo arm, trusted coordination |

### Lazy Mode with Thrashing Detection (Design)

In `lazy` mode, arms can work in parallel without claiming files. The long-term design is for the system to monitor for **thrashing** – when one arm's changes repeatedly get overwritten by another arm during their work session.

The following types describe the intended shape of such events and responses; they are **design-level**, not fully implemented behavior:

```typescript
interface ThrashingEvent {
  path: string;
  victimArm: string;           // Arm whose changes were lost
  overwriterArm: string;       // Arm that overwrote
  victimChangeAt: Date;
  overwriteAt: Date;
  linesLost: number;           // Estimate of lost work
}

interface ThrashingResponse {
  action: "notify" | "enable_claims" | "pause_arm";
  message: string;
  suggestedClaim?: FileClaim;
}
```

At a high level, repeated thrashing should:

- Notify affected arms and log the event
- Encourage or auto-enable claims for the affected file(s)
- Potentially pause an arm that is repeatedly overwriting others without coordination

### Requesting a Claim After Thrashing

When an arm experiences thrashing, it can request a claim:

```typescript
interface ClaimRequest {
  type: "claim_request";
  armId: string;
  path: string;
  reason: "thrashing" | "exclusive_work" | "long_task";
  duration?: number;           // Minutes, if temporary
  thrashingContext?: {
    overwrittenBy: string;
    changesSummary: string;
  };
}
```

### The Protocol (Conceptual)

```
┌─────────────────────────────────────────────────────────────┐
│                   OWNERSHIP PROTOCOL                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. Arm wants to touch file F                               │
│  2. Check: Is F claimed by another arm?                     │
│  3. If unclaimed or shared, proceed                         │
│  4. If claimed and write is needed, request handoff         │
│  5. If handoff fails, escalate to Brain / human             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

The exact mechanics of detection and enforcement live in the Brain and database layers, not in this document.

### File Claims

```typescript
interface FileClaim {
  id: string;
  armId: string;
  path: string;              // File or directory path
  pattern?: string;          // Glob pattern (for directory claims)
  claimedAt: Date;
  expiresAt?: Date;          // Optional auto-expiry
  exclusive: boolean;        // Can others read?
}
```

### Claim Types

| Type | Scope | Exclusive | Use Case |
|------|-------|-----------|----------|
| File claim | Single file | Yes | Active editing |
| Directory claim | All files matching pattern | No (read ok) | Domain ownership |
| Temporary claim | Time-limited | Yes | Quick fix |

### Conflict Resolution (Design)

When two arms want the same file, the Brain should consider:

1. **Task priority**: Higher priority task wins
2. **Reputation**: Higher reputation arm wins ties
3. **History**: Arm with more recent relevant work wins ties
4. **Escalation**: Ask a human if still unclear

## Context Pruning

Coleo does **not** implement its own token-level pruning algorithm. Instead, it relies on the harness (`opencode-api`) and the underlying model to manage context windows safely.

Coleo's responsibility is to:

- Select and pass **relevant** files, plan excerpts, decisions, and status information
- Avoid flooding arms with unnecessary or low-signal context
- Expose a high-level view of what an arm is currently focused on (for humans)

In other words, **we shape the inputs; the harness enforces the limits.**

## Handoff Protocol (Design)

When one arm needs a file that another owns, we model a simple handoff:

### Request Message

```typescript
interface HandoffRequest {
  type: "handoff_request";
  fromArm: string;
  toArm: string;
  path: string;
  reason: string;
  priority: "normal" | "high" | "urgent";
}
```

### Response Options

```typescript
interface HandoffResponse {
  type: "handoff_response";
  fromArm: string;
  toArm: string;
  path: string;
  decision: "granted" | "denied" | "busy" | "collaborate";
  reason?: string;
  estimatedAvailable?: Date;  // If busy
}
```

### Collaboration Mode (Conceptual)

If both arms need the file at the same time:

```typescript
interface CollaborationAgreement {
  path: string;
  participants: string[];     // Arm IDs
  mode: "sequential" | "parallel";
  coordinator: string;        // Arm ID of lead
  protocol: "lock" | "merge"; // How to handle conflicts
}
```

| Mode | Description |
|------|-------------|
| `sequential` | Arms take turns, one edits at a time |
| `parallel` | Both edit, merge conflicts later |

These shapes describe how a future governance/coordination layer might reason about shared files; they are **not** a promise that such workflows are fully implemented today.

## Monitoring Context (Future UI)

The Observatory is intended to provide views into arm context and ownership over time.

### Context Dashboard (Planned)

- **Utilization gauge**: Rough sense of how much context an arm is using (if harness exposes it)
- **File list**: What files the arm is currently focused on
- **Claim map**: Who (if anyone) currently claims what
- **Conflict alerts**: Where ownership disputes or thrashing have been detected

### API Endpoints (Design)

These endpoints describe the intended surface once context/claims are wired through the Brain and database:

```
GET /api/arms/:id/context      # Get arm's current context snapshot
GET /api/arms/:id/claims       # Get arm's file claims
POST /api/arms/:id/prune       # Hint that an arm may want to prune context (optional)
POST /api/claims/:id/transfer  # Transfer claim to another arm
DELETE /api/claims/:id         # Release claim
```

Until these exist in code, treat this section as **forward-looking design**, not current behavior.
