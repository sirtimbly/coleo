# Governance Model

Coleo uses an anarchic governance model where arms persuade each other through reasoned arguments, with the brain acting as a backstop against destructive behavior.

Arms are **general-purpose**: they do not represent permanent roles like "UI arm" or "API arm". Instead, they take on tasks with specific **classifications** (architect, development, qa, documentation, etc.), and governance flows operate over those tasks and the arms currently working on them.

## Core Principle: Anarchy with Persuasion

Arms don't just vote – they **persuade**. Each arm can:

1. **Propose** – Suggest an action that affects others
2. **Argue** – Add reasoning for/against proposals
3. **Signal** – Indicate support/opposition with weight
4. **Override** – Push forward despite opposition (with stated reason)

Governance happens around **proposals** and **tasks**, not around fixed arm roles.

## Proposals

When an arm wants to do something that affects others (deploy, major refactor, take ownership), they create a proposal.

### Proposal Structure

```typescript
interface Proposal {
  id: string;
  author: string;           // Arm ID
  type: ProposalType;
  subject: string;
  description: string;
  arguments: Argument[];
  signals: Signal[];
  status: "open" | "accepted" | "rejected" | "overridden" | "vetoed";
  createdAt: Date;
  resolvedAt?: Date;
  resolution?: string;
}

type ProposalType = 
  | "deploy"              // Deploy to an environment
  | "claim"               // Take ownership of files
  | "refactor"            // Major structural change
  | "dependency"          // Add/remove/update dependency
  | "breaking_change"     // API or interface change
  | "creative_override";  // Pushing forward despite blocks
```

### Proposal Types

| Type | When Used | Typical Timeout |
|------|-----------|-----------------|
| `deploy` | Deploying to any environment | 5 minutes |
| `claim` | Taking ownership of contested files | 2 minutes |
| `refactor` | Major structural code changes | 10 minutes |
| `dependency` | Adding/removing/updating packages | 5 minutes |
| `breaking_change` | Changing public APIs | 15 minutes |
| `creative_override` | Pushing past a block | 1 minute (ack only) |

## Arguments

Arms add arguments for or against proposals.

```typescript
interface Argument {
  author: string;          // Arm ID
  position: "for" | "against" | "concern" | "suggestion";
  content: string;
  evidence?: string[];     // File paths, test results, etc.
  timestamp: Date;
}
```

### Argument Positions

| Position | Meaning | Effect |
|----------|---------|--------|
| `for` | Support the proposal | Positive influence |
| `against` | Oppose the proposal | Negative influence |
| `concern` | Neutral worry | Noted, may need addressing |
| `suggestion` | Alternative approach | May modify proposal |

### Example Arguments (Classification-Oriented)

```text
Proposal: Deploy to staging

[Arm A – development task, web-facing]
Position: FOR
"All component tests pass. Visual checks show no changes to
critical user flows. Ready from a web-facing perspective."
Evidence: [test-results.json, visual-diff.png]

[Arm B – qa task]
Position: CONCERN
"New endpoint /api/users/bulk hasn't been load tested yet.
Suggest we add a basic load test before staging."
Evidence: [routes/users.ts:45]

[Arm C – qa task]
Position: FOR
"E2E suite passes. Added coverage for the bulk endpoint.
Load test added and results are within acceptable limits."
Evidence: [load-test-results.json]

[Arm D – development task, infra-focused]
Position: FOR
"Infrastructure changes are minimal and rollback is documented."
```

Rather than permanently specialized "UI" or "API" arms, the **task classification** and evidence (files, tests, logs) make it clear which perspectives are represented.

## Signals

After reviewing arguments, arms signal their position.

```typescript
interface Signal {
  author: string;          // Arm ID
  weight: number;          // -100 to +100
  reason?: string;
}
```

### Signal Weights

The weight is influenced by:
- Arm's conviction level (-100 to +100)
- Arm's reputation (multiplier)
- Task and subject relevance (bonus if the arm's current or recent tasks are clearly related to the proposal)

Instead of domain-based bonuses, relevance is determined from:
- Recent task classifications (e.g., `qa` tasks have more weight on test adequacy questions)
- Files and systems touched in recent tasks that overlap with the proposal subject

### Consensus Calculation

```typescript
function isTaskRelevant(arm: Arm, proposal: Proposal): boolean {
  // Example heuristic:
  // - Check arm.currentTask.classification vs proposal.type
  // - Check overlap between proposal.subject/description and
  //   files/systems in arm's recent activity
  return true; // Implementation-specific
}

function calculateConsensus(proposal: Proposal, arms: Arm[]): ConsensusResult {
  let weightedSum = 0;
  let totalWeight = 0;

  for (const signal of proposal.signals) {
    const arm = arms.find(a => a.id === signal.author);
    if (!arm) continue;

    // Apply reputation as multiplier (0.5 to 1.5)
    const reputationMultiplier = 0.5 + (arm.reputation / 100);

    // Bonus for task/subject relevance instead of fixed domains
    const relevanceBonus = isTaskRelevant(arm, proposal) ? 1.2 : 1.0;

    const effectiveWeight = signal.weight * reputationMultiplier * relevanceBonus;
    weightedSum += effectiveWeight;
    totalWeight += Math.abs(effectiveWeight);
  }

  const consensus = totalWeight > 0 ? weightedSum / totalWeight : 0;
  
  return {
    value: consensus,        // -1 to +1
    strength: totalWeight,   // How much participation
    decision: consensus > 0.2 ? "accept" : 
              consensus < -0.2 ? "reject" : "undecided"
  };
}
```

## Reputation & Influence

Arms earn and lose reputation based on their behavior.

### Reputation Events

| Event | Delta | Description |
|-------|-------|-------------|
| Task completed successfully | +5 | Arm finished assigned work |
| Proposal accepted | +3 | Arm's proposal was accepted |
| Argument cited by others | +2 | Other arms referenced this argument |
| Stayed within context budget | +1 | Per day of compliance |
| Ownership violation | -5 | Touched files without claim |
| Destructive action | -20 | Required brain intervention |
| Proposal vetoed by brain | -10 | Proposal was dangerous |

### Reputation Effects

| Reputation | Effect |
|------------|--------|
| 80-100 | Highly trusted, signals weighted 1.5x |
| 60-79 | Trusted, normal influence |
| 40-59 | Average, normal influence |
| 20-39 | Watched, signals weighted 0.75x |
| 0-19 | Probation, signals weighted 0.5x |

```typescript
interface ArmReputation {
  armId: string;
  score: number;              // 0-100
  history: ReputationEvent[];
}

interface ReputationEvent {
  type: string;
  delta: number;
  timestamp: Date;
  details?: string;
}
```

Reputation is **per arm**, not per domain. Over time, arms that perform well across many task types become more influential, but any arm can take on any classification as needed.

## Brain Intervention

The Brain monitors for misbehavior and can override arm autonomy.

### Intervention Levels

| Action | Trigger | Effect |
|--------|---------|--------|
| **WARN** | Minor violation | Message sent to arm, logged |
| **PAUSE** | Repeated violations | Arm frozen until human review |
| **KILL** | Destructive behavior | Arm terminated immediately |
| **VETO** | Dangerous proposal | Proposal rejected regardless of signals |
| **ESCALATE** | Uncertain situation | Human asked to decide |
| **EMERGENCY_STOP** | Arm pulls andon cord | All arms paused, problem-solving mode |

## Emergency Stop (Andon Cord)

Inspired by Toyota's production system, any arm can "pull the andon cord" to halt all operations when they detect a quality issue that could cascade into larger problems.

### When to Pull the Cord

Arms should trigger an emergency stop when they detect:
- A bug that could corrupt data if work continues
- A security vulnerability being actively exploited
- Conflicting changes that will cause merge chaos
- A broken dependency affecting multiple arms
- Any issue where continued work makes the problem worse

### Emergency Signal

```typescript
interface EmergencySignal {
  type: "emergency_stop";
  armId: string;
  severity: "critical" | "high";
  problem: string;
  affectedAreas: string[];        // Files, systems, or domains affected
  observedSymptoms: string[];     // What the arm noticed
  suggestedAction?: string;       // Initial idea for resolution
  timestamp: Date;
}

// Different from a proposal - this is immediate action
// Proposals are for planned changes; emergencies are for stopping harm
```

### Emergency Response Flow

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                   EMERGENCY STOP FLOW                                      │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. Arm detects critical issue                                               │
│     │                                                                        │
│  2. Arm sends EmergencySignal to Brain                                       │
│     │                                                                        │
│  3. Brain IMMEDIATELY:                                                       │
│     ├── Pauses ALL arms (no new actions)                                     │
│     ├── Logs the emergency with full context                                 │
│     ├── Sends urgent notification to human                                   │
│     └── Broadcasts emergency to all arms                                     │
│                                                                              │
│  4. Brain enters problem-solving mode:                                       │
│     ├── Asks arms to propose solutions to the problem                        │
│     ├── Arms can still communicate, just can't act                           │
│     └── Proposals for resolution are fast-tracked                            │
│                                                                              │
│  5. Resolution:                                                              │
│     ├── Human approves a solution, OR                                        │
│     ├── Arms reach consensus on fix, OR                                      │
│     └── Human manually resolves and signals all-clear                        │
│                                                                              │
│  6. Brain resumes operations:                                                │
│     ├── Arms resume from where they paused                                   │
│     ├── Emergency logged for post-mortem                                     │
│     └── Reputation bonus for the arm that caught the issue                   │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Emergency vs Proposal

| Aspect | Emergency Signal | Proposal |
|--------|------------------|----------|
| Purpose | Stop ongoing harm | Plan future action |
| Timing | Immediate effect | Debate period |
| Scope | Affects all arms | Affects specific action |
| Trigger | Observed problem | Desired change |
| Response | System-wide pause | Consensus vote |

### Reputation Effects

| Event | Delta |
|-------|-------|
| Arm catches real issue with emergency stop | +15 |
| False alarm (no actual issue) | -5 |
| Ignoring obvious problem that another arm catches | -10 |

### Automatic Triggers

```typescript
interface MisbehaviorRule {
  pattern: string | RegExp;
  severity: "warn" | "pause" | "kill";
  description: string;
}

const DEFAULT_RULES: MisbehaviorRule[] = [
  // Destructive commands
  { pattern: /rm\s+-rf\s+\//, severity: "kill", description: "Dangerous rm command" },
  { pattern: /DROP\s+TABLE/i, severity: "kill", description: "Database destruction" },
  { pattern: /git\s+push\s+--force/, severity: "pause", description: "Force push" },
  
  // Resource abuse
  { pattern: "api_calls > 1000/hour", severity: "pause", description: "API abuse" },
  { pattern: "context_tokens > budget * 2", severity: "warn", description: "Context overflow" },
  
  // Ownership violations
  { pattern: "touch_unowned > 5", severity: "warn", description: "Touching unowned files" },
];
```

## Creative Override

When an arm has conviction about a blocked path, they can push forward.

### Override Requirements

The arm must:
1. State why they're overriding
2. Acknowledge the risks
3. Explain alternatives they considered
4. Provide a rollback plan

```typescript
interface CreativeOverride {
  armId: string;
  proposalId: string;
  reason: string;            // Why this arm is pushing forward
  acknowledgedRisks: string[];
  alternativesConsidered: string[];
  rollbackPlan: string;
}
```

### Override Example

```text
[Arm X – qa task]

Proposal: Skip full integration suite for hotfix deploy

Reason: Production is down. Users cannot log in. The fix is
small and well-understood. Waiting for the full test suite (45 min)
will extend outage unnecessarily.

Acknowledged Risks:
- Change could have unintended side effects
- Skipping tests sets bad precedent

Alternatives Considered:
- Run only auth-related tests (still ~15 min)
- Partial rollback (would affect other users)

Rollback Plan:
- Revert commit abc123 if any auth errors in first 5 minutes
- Full test suite running in parallel, will alert if failures
```

### Brain Response to Overrides

The brain logs the override and may:
- Allow it (no intervention)
- Require human approval first
- VETO if the override violates safety rules

## Proposal Lifecycle

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                   PROPOSAL LIFECYCLE                                       │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. Arm creates proposal                                                     │
│     │                                                                        │
│  2. Proposal broadcast to all arms                                           │
│     │                                                                        │
│  3. Arms add arguments (for/against/concern/suggestion)                     │
│     │  (timeout: type-dependent)                                             │
│     │                                                                        │
│  4. Arms add signals (weighted support/opposition)                          │
│     │                                                                        │
│  5. Auto-resolve conditions:                                                │
│     ├── Timeout reached                                                      │
│     ├── All active arms have signaled                                       │
│     └── No new arguments for 1 minute                                       │
│                                                                              │
│  6. Brain calculates consensus                                               │
│     ├── Positive → ACCEPTED                                                  │
│     ├── Negative → REJECTED                                                  │
│     └── Undecided → ESCALATE to human                                       │
│                                                                              │
│  7. (Optional) Arm invokes creative override                                 │
│     └── Brain allows or vetoes                                              │
│                                                                              │
│  8. Proposal resolved, logged, reputation updated                            │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```
