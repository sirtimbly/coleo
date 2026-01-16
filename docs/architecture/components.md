# Components

The Octopai system consists of five major components that work together.

## Brain (Coordinator)

The Brain is the central nervous system of Octopai.

```
┌─────────────────────────────────────────────────────────────┐
│                         BRAIN                                │
├─────────────────────────────────────────────────────────────┤
│  Responsibilities:                                           │
│  ├── Arm Lifecycle      - Spawn, monitor, kill arms         │
│  ├── Conflict Resolution - Mediate ownership disputes        │
│  ├── Governance         - Process proposals, enforce rules   │
│  ├── Human Interface    - Route approvals, notifications     │
│  ├── State Management   - Persist system state               │
│  └── Misbehavior Detection - Identify and stop bad actors   │
├─────────────────────────────────────────────────────────────┤
│  Powers:                                                     │
│  ├── PAUSE arm          - Temporarily halt an arm            │
│  ├── KILL arm           - Terminate destructive arm          │
│  ├── VETO proposal      - Override arm consensus             │
│  └── ESCALATE to human  - Require human decision             │
└─────────────────────────────────────────────────────────────┘
```

### Misbehavior Detection

The Brain monitors arms for problematic behavior:

| Behavior | Detection | Response |
|----------|-----------|----------|
| Touching files outside task scope/claims | Pattern matching on file paths vs. claims | WARN, then PAUSE |
| Ignoring consensus without override | Proposal tracking | WARN, reputation penalty |
| Destructive changes | Pattern matching (rm -rf, DROP, etc.) | KILL immediately |
| Resource exhaustion | Token/API call counters | PAUSE, notify human |
| Stuck in loop | Action repetition detection | PAUSE with exponential backoff |

### Loop Detection & Backoff Throttling (Design)

When an arm gets stuck in a loop (repeating the same actions, hitting the same errors, or consuming tokens without progress), the brain intervenes with an escalating backoff strategy:

```typescript
interface LoopDetection {
  armId: string;
  detectedAt: Date;
  loopType: "action_repeat" | "error_loop" | "token_burn" | "thrashing";
  consecutiveLoops: number;      // How many times we've caught this arm looping
  backoffMinutes: number;        // Current pause duration
}

const BACKOFF_SCHEDULE = [
  1,    // First loop: 1 minute pause
  5,    // Second: 5 minutes
  15,   // Third: 15 minutes
  30,   // Fourth: 30 minutes
  60,   // Fifth+: 1 hour
];
```

**Loop Response Protocol:**

1. **Detect**: Brain notices arm repeating actions or burning tokens without progress
2. **Pause**: Arm is immediately paused (cannot consume more tokens)
3. **Instruct**: Brain sends message: "You appear stuck. Compact your session and reassess."
4. **Wait**: Arm remains paused for backoff duration
5. **Resume**: After backoff, arm is resumed with instruction to compact context and retry
6. **Check Relevance**: If original task is no longer relevant, arm is reassigned

```typescript
interface LoopRecoveryMessage {
  type: "loop_recovery";
  armId: string;
  instruction: string;
  actions: ("compact_session" | "reassess_task" | "request_help")[];
  originalTaskStillRelevant: boolean;
  pauseDuration: number;
}
```

**Token Budget Protection (Design):**

```typescript
interface TokenThrottle {
  windowMinutes: number;         // Rolling window (default: 10)
  maxTokensPerWindow: number;    // Hard cap (default: 50000)
  warningThreshold: number;      // Warn at 70%
}
```

### Brain State

```typescript
interface BrainState {
  status: "running" | "stopped" | "paused";
  startedAt: Date;
  lastPollAt: Date;
  pollIntervalMs: number;
  activeArms: string[];
  pendingProposals: number;
  pendingApprovals: number;
}
```

---

## Arms (General-Purpose Agents)

Each arm is a semi-autonomous **general-purpose** AI agent. Its behavior is determined by the **task classification** it is executing (architect, development, QA, documentation, etc.), not by a permanently assigned domain.

### Arm Profile

```typescript
interface ArmProfile {
  id: string;
  name: string;
  agent: "opencode-api" | "custom";

  // Task execution
  supportedClassifications: string[]; // e.g., ["architect", "development", "qa"]

  // Context Management
  contextBudget: ContextBudget;
  currentContext: ContextSnapshot;

  // Ownership
  claims: FileClaim[];         // Files/dirs this arm is tending

  // Governance
  reputation: number;          // 0-100, affects persuasion weight
  activeProposals: Proposal[];

  // State
  status: "idle" | "working" | "blocked" | "proposing" | "paused" | "dead";
  currentTask?: Task;
}
```

Arms can be used for different task classifications over time. The same arm might run an architect task for one assignment, then a development or QA task for the next.

### MCP Server Catalog

Arms access the garden through MCP servers. Each provides specialized capabilities:

| MCP Server | Purpose | Key Tools |
|------------|---------|-----------|
| `git-mcp` | Version control | `commit`, `push`, `branch`, `diff`, `log` |
| `env-mcp` | Environment variables | `get`, `set`, `list` (filtered for secrets) |
| `docs-mcp` | Library documentation | `search`, `fetch`, `summarize` |
| `devtools-mcp` | Browser automation | `screenshot`, `console`, `network`, `lighthouse` |
| `deploy-mcp` | Deployment operations | `request`, `status`, `rollback`, `logs` |
| `db-mcp` | Database operations | `query`, `migrate`, `seed`, `backup` |
| `pkg-mcp` | Package management | `install`, `update`, `audit`, `outdated` |
| `observability-mcp` | Logs & metrics | `logs.search`, `metrics.query`, `traces.find` |
| `alerts-mcp` | Alert management | `list`, `ack`, `silence`, `escalate` |

### Observability MCP Server

For production operations, arms need visibility into running systems:

```typescript
interface ObservabilityMCP {
  // Log operations
  "logs.search": (params: {
    service: string;
    environment: string;
    query: string;
    timeRange: { start: Date; end: Date };
    limit?: number;
  }) => LogEntry[];
  
  "logs.tail": (params: {
    service: string;
    environment: string;
    follow: boolean;
  }) => AsyncIterable<LogEntry>;
  
  // Metrics
  "metrics.query": (params: {
    query: string;              // PromQL or similar
    timeRange: { start: Date; end: Date };
    step?: string;             // e.g., "1m", "5m"
  }) => MetricSeries[];
  
  "metrics.dashboard": (params: {
    name: string;
  }) => DashboardSnapshot;
  
  // Traces (distributed tracing)
  "traces.find": (params: {
    service?: string;
    traceId?: string;
    minDuration?: number;
    error?: boolean;
    limit?: number;
  }) => Trace[];
  
  // Health
  "health.check": (params: {
    service: string;
    environment: string;
  }) => HealthStatus;
}

interface LogEntry {
  timestamp: Date;
  level: "debug" | "info" | "warn" | "error";
  service: string;
  message: string;
  metadata: Record<string, unknown>;
}

interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  checks: { name: string; status: string; message?: string }[];
  lastCheck: Date;
}
```

### Alerts MCP Server

For incident response and on-call operations:

```typescript
interface AlertsMCP {
  "alerts.list": (params: {
    status?: "firing" | "resolved" | "silenced";
    severity?: "critical" | "warning" | "info";
    service?: string;
  }) => Alert[];
  
  "alerts.ack": (params: {
    alertId: string;
    message: string;
  }) => void;
  
  "alerts.silence": (params: {
    matchers: { label: string; value: string }[];
    duration: string;         // e.g., "2h", "1d"
    reason: string;
  }) => Silence;
  
  "alerts.escalate": (params: {
    alertId: string;
    reason: string;
  }) => void;
  
  "runbook.fetch": (params: {
    alertName: string;
  }) => Runbook;
}

interface Alert {
  id: string;
  name: string;
  severity: "critical" | "warning" | "info";
  status: "firing" | "resolved" | "silenced";
  service: string;
  summary: string;
  firedAt: Date;
  resolvedAt?: Date;
  labels: Record<string, string>;
}
```

### Legacy: Arm Domain Definition

```typescript
interface ArmDomain {
  name: string;
  description: string;
  defaultPatterns: string[];   // Glob patterns for auto-claiming
  mcpServers: string[];        // Which MCP servers this arm can use
}

// Note: ArmDomain reflects an earlier design that relied on static domains.
// In the current design, arms are general-purpose and behavior is primarily
// guided by task classifications, task history, and configuration templates.
```

---

## Garden (Shared Environment)

The Garden is the workspace that arms tend. It's represented as a 3D space for visualization.

### Layers

```
┌─────────────────────────────────────────────────────────────┐
│                       THE GARDEN                             │
├─────────────────────────────────────────────────────────────┤
│  Physical Layer (files, dirs, repos):                        │
│  ├── Source code                                             │
│  ├── Configuration                                           │
│  ├── Documentation                                           │
│  ├── Tests                                                   │
│  └── Build artifacts                                         │
├─────────────────────────────────────────────────────────────┤
│  Logical Layer (exposed via MCP):                            │
│  ├── git-mcp        - VCS operations                         │
│  ├── env-mcp        - Environment variables                  │
│  ├── runtime-mcp    - Node/Python/Bun versions               │
│  ├── docs-mcp       - Library documentation                  │
│  ├── nx-mcp         - Monorepo orchestration                 │
│  ├── devtools-mcp   - Browser automation                     │
│  ├── deploy-mcp     - Deployment per environment             │
│  └── pkg-mcp        - Package management                     │
├─────────────────────────────────────────────────────────────┤
│  Ownership Layer:                                            │
│  ├── Who owns what (claims)                                  │
│  ├── Who touched what recently (activity)                    │
│  └── Conflict zones (multiple claims)                        │
└─────────────────────────────────────────────────────────────┘
```

### 3D Coordinate System (Radial)

Files are positioned in a radial 3D space where **distance from center indicates activity** - frequently touched files appear closer to the center, making the visualization naturally focus attention on what's actively being worked on.

```typescript
interface GardenCoordinate {
  // Radial coordinates
  category: number;    // Angle in degrees (0-360) - which "slice" of the pie
  activity: number;    // Distance from center (0-100) - 0=hot, 100=cold
  depth: number;       // Vertical position (0-100) - stack layer
}

interface GardenNode {
  path: string;
  type: "file" | "directory";
  coords: GardenCoordinate;
  owner?: string;           // Arm ID
  lastTouchedBy?: string;   // Arm ID
  lastTouchedAt?: Date;
  conflictZone: boolean;
}
```

| Axis | Heuristic | Meaning |
|------|-----------|---------|
| **Category (angle)** | File type/category | Each file category gets a slice: UI (0-60°), API (60-120°), DB (120-180°), Infra (180-240°), Tests (240-300°), Docs (300-360°) |
| **Activity (radius)** | Recency & frequency | 0=center=very active, 100=edge=dormant. Based on touches in last 7 days |
| **Depth (vertical)** | Stack layer | 0=frontend/surface, 100=infrastructure/deep |

### Activity Calculation

```typescript
function calculateActivity(path: string, touches: Touch[]): number {
  const now = Date.now();
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  
  // Only consider touches in last 7 days
  const recentTouches = touches.filter(t => 
    now - t.timestamp.getTime() < weekMs
  );
  
  if (recentTouches.length === 0) return 100; // Edge - dormant
  
  // Score based on recency and frequency
  let score = 0;
  for (const touch of recentTouches) {
    const ageMs = now - touch.timestamp.getTime();
    const recencyWeight = 1 - (ageMs / weekMs); // 1.0 for now, 0.0 for week ago
    score += recencyWeight;
  }
  
  // Normalize: more touches + more recent = closer to center
  // Cap at 20 touches for max activity
  const normalized = Math.min(score / 20, 1);
  return Math.round((1 - normalized) * 100); // Invert: 0=active, 100=dormant
}
```

### Visual Effect

In the 3D Garden view:
- **Center cluster**: Files being actively worked on right now
- **Middle ring**: Recently touched, part of ongoing work
- **Outer ring**: Stable files, not recently modified
- **Colored by owner**: Each arm has a color, files glow with owner's color
- **Pulsing**: Files with active claims pulse gently
- **Conflict zones**: Red highlight when multiple arms are contending

---

## Observatory (Web UI + API)

The Observatory is how humans observe and control the system.

### Server Components

```
┌─────────────────────────────────────────────────────────────┐
│                      OBSERVATORY                             │
├─────────────────────────────────────────────────────────────┤
│  Web Server (Hono):                                          │
│  ├── REST API          - CRUD operations, queries            │
│  ├── WebSocket         - Real-time updates                   │
│  ├── Static files      - React SPA                           │
│  └── Push endpoint     - Browser notifications               │
└─────────────────────────────────────────────────────────────┘
```

### UI Views

| View | Purpose |
|------|---------|
| **Dashboard** | System overview, arm status at a glance |
| **Garden** | 3D visualization of workspace with ownership |
| **Arms** | Arm details, context, activity log |
| **Proposals** | Active debates, arguments, signals |
| **Approvals** | Pending human decisions |
| **Activity** | Timeline of all system actions |
| **Config** | System settings, arm configuration |

### Available Actions

- Spawn/Kill arms
- Approve/Reject proposals
- Override arm decisions
- Configure context budgets
- Reassign file ownership
- Trigger deployments

---

## Nerve System (Communication Layer)

All communication flows through the Nerve System.

### Message Flow

```
Human ◄──────► Observatory ◄──────► Brain ◄──────► Arms
         │                    │              │
         │ WebSocket          │ Internal     │ MCP
         │ Push Notifications │ Event Bus    │ Protocol
         │ REST API           │              │
```

### Message Types

| Message | Direction | Description |
|---------|-----------|-------------|
| `arm.spawn` | Brain → All | New arm created |
| `arm.status` | Arm → Brain | Arm status change |
| `arm.activity` | Arm → Brain | Arm performed action |
| `proposal.new` | Arm → All | Arm proposed something |
| `proposal.argue` | Arm → All | Arm added argument |
| `proposal.resolve` | Brain → All | Proposal decided |
| `claim.request` | Arm → Brain | Arm wants to own file |
| `claim.granted` | Brain → Arm | Ownership granted |
| `claim.conflict` | Brain → All | Multiple claims detected |
| `deploy.request` | Arm → Brain | Deployment requested |
| `deploy.consensus` | Brain → All | Arms reached consensus |
| `human.approval` | Brain → Human | Human decision needed |
| `human.notify` | Brain → Human | Notification for human |
| `brain.intervene` | Brain → Arm | Brain taking action |
