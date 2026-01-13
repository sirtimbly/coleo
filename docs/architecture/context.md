# Context Management

Each arm has a limited context budget to prevent cognitive overload. This page describes how context is managed and how file ownership works.

## Context Budget

Every arm operates within a context budget that limits how much information they hold at once.

### Budget Configuration

```typescript
interface ContextBudget {
  mode: "auto" | "manual";
  
  // Limits (manual mode)
  maxFiles?: number;         // Max files in context
  maxTokens?: number;        // Max estimated tokens
  maxDirectories?: number;   // Max directories claimed
  
  // Auto mode settings
  autoMode?: {
    aggressiveness: "conservative" | "moderate" | "aggressive";
    priorityPatterns: string[];  // Patterns to keep even when pruning
  };
}
```

### Mode: Auto vs Manual

| Mode | Description | Use Case |
|------|-------------|----------|
| **Auto** | System manages context based on activity | Default, hands-off |
| **Manual** | User sets explicit limits | Fine-tuned control |

### Auto Mode Aggressiveness

| Level | Behavior |
|-------|----------|
| `conservative` | Keep context longer, prune slowly |
| `moderate` | Balance between retention and freshness |
| `aggressive` | Frequently prune, focus on immediate task |

### Context Snapshot

```typescript
interface ContextSnapshot {
  files: string[];           // Files currently in context
  estimatedTokens: number;   // Token count estimate
  utilization: number;       // 0-1, how full is the budget
  lastPruned?: Date;         // When context was last trimmed
}
```

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

### Lazy Mode with Thrashing Detection

In `lazy` mode, arms can work in parallel without claiming files. The system monitors for **thrashing** - when an arm's changes get overwritten by another arm during their work session.

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

**Thrashing Detection Flow:**

```
┌─────────────────────────────────────────────────────────────┐
│                  THRASHING DETECTION                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. Arm A writes to file F at time T1                        │
│  2. Arm B writes to file F at time T2 (T2 > T1)              │
│  3. Brain detects: A's changes from T1 are not in T2 write   │
│     │                                                        │
│  4. First occurrence:                                        │
│     └── NOTIFY both arms, log event                          │
│                                                              │
│  5. Second occurrence (same file or same arm pair):          │
│     ├── AUTO-ENABLE claims for that file                     │
│     ├── Arm that was overwritten gets first claim            │
│     └── NOTIFY: "Claims now required for F"                  │
│                                                              │
│  6. Repeated thrashing (3+ times):                           │
│     ├── PAUSE the overwriting arm                            │
│     ├── Request claim before resuming                        │
│     └── Reputation penalty for overwriter                    │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

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

### The Protocol

```
┌─────────────────────────────────────────────────────────────┐
│                   OWNERSHIP PROTOCOL                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. Arm wants to touch file F                                │
│     │                                                        │
│  2. Check: Is F claimed by another arm?                      │
│     ├── NO  → Claim F, proceed                               │
│     └── YES → Go to step 3                                   │
│                                                              │
│  3. Is this a read or write?                                 │
│     ├── READ  → Proceed (no claim needed)                    │
│     └── WRITE → Go to step 4                                 │
│                                                              │
│  4. Request handoff from owner                               │
│     ├── Owner agrees → Claim transferred                     │
│     ├── Owner busy   → Wait or propose collaboration         │
│     └── Owner refuses → Go to step 5                         │
│                                                              │
│  5. Escalate to Brain                                        │
│     ├── Brain mediates based on:                             │
│     │   - Task priority                                      │
│     │   - Arm reputation                                     │
│     │   - File volatility                                    │
│     └── Brain decides: transfer, split, or deny              │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

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

### Conflict Resolution

When two arms want the same file:

1. **Check priority**: Higher priority task wins
2. **Check reputation**: Higher reputation arm wins ties
3. **Check history**: Arm with more recent touch wins ties
4. **Escalate**: Brain asks human if still unclear

## Context Pruning

When an arm's context gets full, old/unused files are pruned.

### Pruning Algorithm

```typescript
function pruneContext(arm: Arm): string[] {
  const { files, estimatedTokens } = arm.currentContext;
  const { maxTokens, autoMode } = arm.contextBudget;
  
  if (estimatedTokens <= maxTokens * 0.9) {
    return []; // Under 90%, no pruning needed
  }

  // Score each file
  const scored = files.map(file => ({
    path: file,
    score: calculateRetentionScore(file, arm, autoMode)
  }));

  // Sort by score (lower = prune first)
  scored.sort((a, b) => a.score - b.score);

  // Remove files until under 70% capacity
  const toPrune: string[] = [];
  let currentTokens = estimatedTokens;
  
  while (currentTokens > maxTokens * 0.7 && scored.length > 0) {
    const file = scored.shift()!;
    toPrune.push(file.path);
    currentTokens -= estimateTokens(file.path);
  }

  return toPrune;
}

function calculateRetentionScore(
  file: string, 
  arm: Arm, 
  autoMode: AutoModeConfig
): number {
  let score = 0;

  // Recency: Recently touched files score higher
  const lastTouch = getLastTouchTime(file, arm.id);
  const hoursSinceTouch = (Date.now() - lastTouch) / (1000 * 60 * 60);
  score += Math.max(0, 100 - hoursSinceTouch * 5);

  // Priority patterns: Files matching priority patterns score higher
  if (autoMode?.priorityPatterns?.some(p => minimatch(file, p))) {
    score += 50;
  }

  // Active task: Files related to current task score higher
  if (arm.currentTask && isRelatedToTask(file, arm.currentTask)) {
    score += 75;
  }

  // Ownership: Files arm owns score higher
  if (arm.claims.some(c => matchesClaim(file, c))) {
    score += 25;
  }

  return score;
}
```

## Handoff Protocol

When one arm needs a file that another owns:

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

### Collaboration Mode

If both arms need the file:

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

## Domain Auto-Claiming

Arms automatically claim files matching their domain patterns.

### Example Domain Patterns

```typescript
const UI_ARM_PATTERNS = [
  "src/components/**",
  "src/pages/**",
  "src/styles/**",
  "*.css",
  "*.scss",
  "*.module.css",
];

const API_ARM_PATTERNS = [
  "src/api/**",
  "src/routes/**",
  "src/services/**",
  "src/middleware/**",
];

const TEST_ARM_PATTERNS = [
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.spec.ts",
  "e2e/**",
  "cypress/**",
  "__tests__/**",
];
```

### Claim Priority

When multiple arms' patterns match a file:

1. More specific pattern wins
2. Higher reputation arm wins ties
3. First to touch wins remaining ties

## Monitoring Context

The Observatory provides views into arm context:

### Context Dashboard

- **Utilization gauge**: How full is each arm's context?
- **File list**: What files are in context?
- **Claim map**: Who owns what?
- **Conflict alerts**: Where are ownership disputes?

### API Endpoints

```
GET /api/arms/:id/context      # Get arm's current context
GET /api/arms/:id/claims       # Get arm's file claims
POST /api/arms/:id/prune       # Force context prune
POST /api/claims/:id/transfer  # Transfer claim to another arm
DELETE /api/claims/:id         # Release claim
```
