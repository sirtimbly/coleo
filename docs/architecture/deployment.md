# Deployment Flow

Coleo supports automated deployments with arm consensus and optional human approval.

For local-process development outside Docker, `coleo serve` is the matching single-host runtime entrypoint.
When `COLEO_NATS_URL` is unset, it will try to bootstrap a local standalone `nats-server` into the active `.coleo/` directory.

## Self-Hosted Runtime Topologies

The repository also includes a practical self-host deployment path under `deploy/self-host/`.
That path is intentionally staged so a developer can start simple and only add edge complexity later.

### Default Topology: Local or Private Network

The default file is:

- `deploy/self-host/docker-compose.hosting.yml`

It runs:

- `observatory` (web app + API)
- `brain`
- `nats`
- `qdrant`

By default it binds only to loopback:

- web UI on `http://localhost`
- API on `http://localhost:8080`
- NATS on `nats://localhost:4222`

When serving the Observatory through `coleo web`, it must serve a built Vite bundle from
`src/web/dist` or `dist/web`. If the browser ever loads `/src/main.tsx`, the server is
serving source HTML instead of the built app and the UI will fail to boot.

This is the intended first step for:

- local Docker/OrbStack testing on a laptop or Mac mini
- a home server used only from the same machine
- a private host reached through Tailscale, WireGuard, or another VPN

### Home Server over LAN, Tailscale, or VPN

For a private home-server deployment, keep using the same base Compose file and set:

```bash
COLEO_BIND_HOST=0.0.0.0
COLEO_PUBLIC_ORIGIN=http://<private-hostname-or-tailscale-name>
```

Examples:

- `http://macmini.local`
- `http://macmini.tailnet-name.ts.net`

The preferred progression is:

1. Start with the base stack only.
2. Verify the UI/API work over your private network or VPN.
3. Add a public reverse proxy/auth layer only if you actually need internet exposure.

### Optional Public Edge Overlay

Traefik, Authelia, and the optional Tailscale sidecar are not part of the default stack.
They live in a separate example overlay:

- `deploy/self-host/docker-compose.hosting.edge.example.yml`

Use that overlay only when you want:

- public DNS hostnames
- TLS termination
- browser auth in front of the Observatory/API

### Bootstrap Behavior

The helper script:

- `deploy/self-host/bin/bootstrap-host.sh`

is designed to support the staged model above.

It will:

- create `.env.hosting` if missing
- fill missing local/private defaults
- generate bootstrap/API/auth secrets only when they are missing or still placeholders
- preserve existing secrets on rerun
- render the optional Authelia and Tailscale config templates when `envsubst` is available

It does not require Traefik or Authelia to be part of the default operator workflow.

## Environment Tiers

Each environment has its own rules for deployment:

```typescript
interface Environment {
  name: "local" | "dev" | "staging" | "prod";
  type: "development" | "deployment";  // Dev servers vs deployed instances
  strategy?: "rolling" | "blue_green"; // Deployment strategy
  autoDeployable: boolean;             // Can arms deploy without human?
  consensusRequired: boolean;          // Need arm consensus?
  humanApproval: boolean;              // Need human approval?
}
```

### Environment Types

**Development environments** run dev servers that auto-reload on code changes. "Deployment" here means restarting the dev server, not shipping code.

**Deployment environments** are actual deployed instances where code ships.

### Default Configuration

| Environment | Type        | Strategy   | Auto Deploy | Consensus | Human Approval |
| ----------- | ----------- | ---------- | ----------- | --------- | -------------- |
| `local`     | development | N/A        | Yes         | No        | No             |
| `dev`       | development | N/A        | Yes         | No        | No             |
| `staging`   | deployment  | blue_green | No          | Yes       | Yes            |
| `prod`      | deployment  | blue_green | No          | Yes       | Yes            |

```typescript
const DEFAULT_ENVIRONMENTS: Environment[] = [
  {
    name: "local",
    type: "development",
    autoDeployable: true,
    consensusRequired: false,
    humanApproval: false
  },
  {
    name: "dev",
    type: "development",
    autoDeployable: true,
    consensusRequired: false,
    humanApproval: false
  },
  {
    name: "staging",
    type: "deployment",
    strategy: "blue_green",
    autoDeployable: false,
    consensusRequired: true,
    humanApproval: true
  },
  {
    name: "prod",
    type: "deployment",
    strategy: "blue_green",
    autoDeployable: false,
    consensusRequired: true,
    humanApproval: true
  },
];
```

## Local Development Actions

For `local` and `dev` environments, "deployment" means different things:

### Dev Server Actions

| Action        | Description                           | Consensus | Human |
| ------------- | ------------------------------------- | --------- | ----- |
| `dev.restart` | Restart the dev server                | No        | No    |
| `dev.rebuild` | Full rebuild (clear cache, reinstall) | No        | No    |
| `dev.seed`    | Reset and seed local database         | No        | No    |
| `dev.reset`   | Full reset (rebuild + seed + restart) | Yes*      | No    |

*Consensus only if multiple arms are actively working

```typescript
interface DevAction {
  type: "restart" | "rebuild" | "seed" | "reset";
  environment: "local" | "dev";
  reason: string;
  force: boolean;              // Skip waiting for file saves
}

// Dev actions are different from deployments
// They don't ship code, just refresh the local environment
```

### Why This Distinction Matters

Arms working locally shouldn't need to "propose a deployment" just to restart a dev server. But they should coordinate on full resets that could interrupt other arms' testing.

## Deployment Strategies

### Rolling Deployment (Default)

Replace instances one at a time:

```typescript
interface RollingStrategy {
  type: "rolling";
  batchSize: number;           // Instances to update at once
  waitBetweenBatches: number;  // Seconds between batches
  healthCheckPath: string;     // Endpoint to verify health
  healthCheckTimeout: number;  // Seconds to wait for healthy
}
```

### Blue/Green Deployment

Run two identical environments, switch traffic atomically:

```typescript
interface BlueGreenStrategy {
  type: "blue_green";
  activeSlot: "blue" | "green";
  healthCheckPath: string;
  warmupSeconds: number;       // Time to warm up before switching
  keepPreviousMinutes: number; // How long to keep old version running
}
```

**Blue/Green Flow:**

```
┌─────────────────────────────────────────────────────────────┐
│                   BLUE/GREEN DEPLOYMENT                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Current: BLUE (serving traffic)                             │
│                                                              │
│  1. Deploy new version to GREEN                              │
│  2. Run health checks on GREEN                               │
│  3. Warm up GREEN (pre-load caches, etc.)                    │
│  4. Switch load balancer: BLUE → GREEN                       │
│  5. GREEN now serves traffic                                 │
│  6. Keep BLUE running for quick rollback                     │
│  7. After keepPreviousMinutes, tear down BLUE                │
│                                                              │
│  Rollback: Just switch back to BLUE (instant)                │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Deployment Request

An arm or human can request a deployment:

```typescript
interface DeploymentRequest {
  id: string;
  environment: string;
  ref: string;                 // Git ref to deploy
  requestedBy: string;         // Arm ID or "human"
  reason: string;
  status: "pending_consensus" | "pending_approval" | "deploying" | "completed" | "failed" | "cancelled";
  proposalId?: string;         // If consensus required
  approvalId?: string;         // If human approval required
  createdAt: Date;
  resolvedAt?: Date;
}
```

## Consensus Flow

```
┌─────────────────────────────────────────────────────────────┐
│                  DEPLOYMENT CONSENSUS                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. Arm proposes deployment to ENV                           │
│     │                                                        │
│  2. Is consensusRequired for ENV?                            │
│     ├── NO  → Skip to step 5                                 │
│     └── YES → Continue                                       │
│                                                              │
│  3. Arms debate (argue, signal)                              │
│     ├── Timeout: 5 minutes                                   │
│     └── Auto-resolve: No new arguments for 1 minute          │
│                                                              │
│  4. Brain tallies weighted signals                           │
│     ├── Positive sum → Consensus reached                     │
│     ├── Negative sum → Deployment rejected                   │
│     └── Tie → Escalate to human                              │
│                                                              │
│  5. Is humanApproval required for ENV?                       │
│     ├── NO  → Proceed to deploy                              │
│     └── YES → Wait for human (push notification sent)        │
│                                                              │
│  6. Execute deployment                                       │
│     ├── Success → Log, notify                                │
│     └── Failure → Rollback, notify, log                      │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Example Deployment Debate

```
┌─────────────────────────────────────────────────────────────┐
│  PROPOSAL: Deploy to staging                                 │
│  Author: DevOps Arm                                          │
│  Status: Open                                                │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ARGUMENTS:                                                  │
│                                                              │
│  [DevOps Arm - FOR]                                          │
│  "All CI checks pass. Docker image built successfully.       │
│   Rollback procedure tested and documented."                 │
│  Evidence: [ci-results.json, rollback-test.log]              │
│                                                              │
│  [Test Arm - FOR]                                            │
│  "E2E suite passes on staging-like environment.              │
│   Load test shows acceptable performance."                   │
│  Evidence: [e2e-results.json, load-test.png]                 │
│                                                              │
│  [API Arm - CONCERN]                                         │
│  "New /users/bulk endpoint hasn't been tested with           │
│   real-world data volumes. Suggest limiting rate initially." │
│                                                              │
│  [UI Arm - FOR]                                              │
│  "All visual regression tests pass. Accessibility audit      │
│   complete with no new issues."                              │
│  Evidence: [visual-diff.html, a11y-report.json]              │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│  SIGNALS:                                                    │
│                                                              │
│  DevOps Arm:  +90  "Ready to go"                             │
│  Test Arm:    +80  "Tests look good"                         │
│  API Arm:     +40  "Okay with rate limiting suggestion"      │
│  UI Arm:      +75  "UI is solid"                             │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│  CONSENSUS: +73.2 (ACCEPTED)                                 │
│  → Proceeding to human approval                              │
└─────────────────────────────────────────────────────────────┘
```

## Human Approval

When human approval is required:

1. Push notification sent to subscribed devices
2. Approval appears in Observatory "Approvals" view
3. Human can approve, reject, or request changes
4. Decision is logged and deployment proceeds or stops

### Approval UI

```
┌─────────────────────────────────────────────────────────────┐
│  APPROVAL REQUIRED                                           │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Deploy to: staging                                          │
│  Ref: main (abc1234)                                         │
│  Requested by: DevOps Arm                                    │
│  Reason: Weekly release                                      │
│                                                              │
│  Consensus: +73.2 (4 arms agreed)                            │
│                                                              │
│  Changes included:                                           │
│  - feat: Add bulk user endpoint                              │
│  - fix: Resolve auth timeout issue                           │
│  - chore: Update dependencies                                │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐              │
│  │ Approve  │  │  Reject  │  │ Request Info  │              │
│  └──────────┘  └──────────┘  └───────────────┘              │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Rollback

Every deployment includes a rollback plan:

```typescript
interface RollbackPlan {
  strategy: "revert_commit" | "deploy_previous" | "blue_green_switch" | "manual";
  previousRef?: string;        // Git ref of previous deploy
  previousSlot?: "blue" | "green"; // For blue/green
  commands?: string[];         // Manual rollback steps
  estimatedTime: number;       // Minutes
  testedAt?: Date;             // When rollback was last tested
}
```

### Automatic Rollback

If deployment fails or errors spike post-deploy:

1. Brain detects the problem (via monitoring integration)
2. Creates urgent proposal: "Rollback due to [error]"
3. Arms can signal quickly (30 second timeout)
4. Rollback executed automatically if consensus positive
5. Human notified of rollback

### Rollback Pause Mode

When a rollback occurs, optionally pause all activity to prevent compounding problems:

```typescript
interface RollbackConfig {
  pauseOnRollback: boolean;        // Pause all arms during rollback?
  pauseDurationMinutes: number;    // How long to pause (default: 5)
  requirePostMortem: boolean;      // Must discuss before resuming?
  reputationPunishment: boolean;   // Penalize responsible arm?
  reputationPenalty: number;       // Points to deduct (default: -15)
}

const DEFAULT_ROLLBACK_CONFIG: RollbackConfig = {
  pauseOnRollback: true,           // Pause to prevent cascade
  pauseDurationMinutes: 5,
  requirePostMortem: false,        // Optional post-mortem
  reputationPunishment: true,      // Enabled by default
  reputationPenalty: -15,
};
```

### Rollback Flow with Pause

```
┌─────────────────────────────────────────────────────────────┐
│                   ROLLBACK WITH PAUSE                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. Problem detected (errors, latency, alerts)               │
│     │                                                        │
│  2. Brain initiates rollback                                 │
│     │                                                        │
│  3. If pauseOnRollback enabled:                              │
│     ├── PAUSE all arms immediately                           │
│     ├── Broadcast: "Rollback in progress, all work paused"   │
│     └── Arms freeze current state                            │
│                                                              │
│  4. Execute rollback (switch blue/green, revert, etc.)       │
│     │                                                        │
│  5. Verify rollback successful                               │
│     │                                                        │
│  6. Identify responsible arm (who proposed the deploy?)      │
│     │                                                        │
│  7. If reputationPunishment enabled:                         │
│     ├── Apply penalty to arm's reputation                    │
│     └── Log: "Reputation -15: Deployment required rollback"  │
│                                                              │
│  8. If requirePostMortem:                                    │
│     ├── Brain asks arms: "What went wrong?"                  │
│     ├── Wait for analysis proposals                          │
│     └── Human can review and resume when ready               │
│     │                                                        │
│  9. Else after pauseDurationMinutes:                         │
│     └── Resume all arms automatically                        │
│                                                              │
│ 10. Post-mortem logged for future reference                  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Reputation Effects for Deployments

| Event                                | Delta | Notes                |
| ------------------------------------ | ----- | -------------------- |
| Successful deployment                | +5    | Arm that proposed    |
| Deployment required rollback         | -15   | Configurable penalty |
| Arm caught issue pre-deploy          | +10   | Prevented bad deploy |
| False positive (blocked good deploy) | -3    | Overcautious         |

### Disabling Reputation Punishment

Some teams prefer blameless post-mortems:

```typescript
// In config
const rollbackConfig: RollbackConfig = {
  pauseOnRollback: true,
  pauseDurationMinutes: 10,
  requirePostMortem: true,       // Focus on learning
  reputationPunishment: false,   // No blame
  reputationPenalty: 0,
};
```

## Deployment Hooks

Arms can register hooks to run at various stages:

```typescript
interface DeploymentHooks {
  preDeploy?: HookAction[];    // Before deployment starts
  postDeploy?: HookAction[];   // After successful deployment
  onFailure?: HookAction[];    // If deployment fails
  onRollback?: HookAction[];   // If rollback executed
}

interface HookAction {
  armId: string;
  action: string;              // MCP tool to call
  params: Record<string, unknown>;
}
```

### Example Hooks

```typescript
const deploymentHooks: DeploymentHooks = {
  preDeploy: [
    { armId: "test-arm", action: "run_smoke_tests", params: {} },
    { armId: "devops-arm", action: "check_infra_health", params: {} },
  ],
  postDeploy: [
    { armId: "test-arm", action: "run_e2e_tests", params: { quick: true } },
    { armId: "devtools-arm", action: "take_screenshots", params: { pages: ["home", "login"] } },
  ],
  onFailure: [
    { armId: "devops-arm", action: "collect_logs", params: { since: "5m" } },
  ],
};
```

## Deployment MCP Tools

Arms use these MCP tools for deployment:

| Tool              | Description               |
| ----------------- | ------------------------- |
| `deploy.request`  | Request a deployment      |
| `deploy.status`   | Check deployment status   |
| `deploy.cancel`   | Cancel pending deployment |
| `deploy.rollback` | Initiate rollback         |
| `deploy.logs`     | Get deployment logs       |

## Environment Variables & Secrets

Deployments can access environment-specific secrets via `env-mcp`:

```typescript
interface EnvConfig {
  environment: string;
  variables: Record<string, string>;
  secrets: string[];           // Names only, values fetched at deploy time
}
```

Secrets are never stored in logs, proposals, or visible in the UI. They're fetched from a secret manager (Vault, AWS Secrets Manager, etc.) at deployment time.

## Monitoring Integration

Post-deployment monitoring can trigger alerts:

```typescript
interface MonitoringConfig {
  provider: "datadog" | "prometheus" | "custom";
  errorThreshold: number;      // Error rate to trigger alert
  latencyThreshold: number;    // P95 latency to trigger alert
  rollbackOnAlert: boolean;    // Auto-rollback if thresholds exceeded
  checkInterval: number;       // Seconds between checks post-deploy
  checkDuration: number;       // How long to monitor post-deploy
}
```
