---
title: Arms
description: How interchangeable general-purpose agents receive temporary roles, context, and tools.
outline: [2,3]
banner:
  src: /coleo-architecture-components.png
  alt: Five distinct underwater habitats for coordination, gateways, agent work, message flow, and shared data surround a central orange octopus and connect with luminous paths.
  eyebrow: General-Purpose Workers
  position: center 48%
---

# Arms

Each arm is a semi-autonomous **general-purpose** AI agent. Its behavior is determined by the **task classification** it is executing (architect, development, QA, documentation, etc.), not by a permanently assigned domain.

## Arm Profile

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

## MCP Server Catalog

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

## Observability MCP Server

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

## Alerts MCP Server

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

## Legacy: Arm Domain Definition

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
