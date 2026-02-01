# Distributed Architecture

Coleo supports distributed deployment where the Brain, API server, and Gardens can run on separate machines. This enables working on the same project from multiple locations (laptop, desktop, cloud server) while maintaining a single coordinated system.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           CONTROL PLANE                                  │
│                    (Can run anywhere - cloud, NAS, always-on server)     │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────┐  ┌─────────────────────────────────────────┐   │
│  │       BRAIN         │  │              API SERVER                  │   │
│  │  - Task assignment  │  │  - REST + WebSocket endpoints           │   │
│  │  - Conflict resolve │  │  - SQLite persistence                   │   │
│  │  - Human interface  │  │  - Observatory web UI                   │   │
│  │  - Stuck detection  │  │  - Garden registry                      │   │
│  └─────────┬───────────┘  └─────────────────┬───────────────────────┘   │
│            │                                │                            │
│            └────────────────┬───────────────┘                            │
│                             │                                            │
└─────────────────────────────┼────────────────────────────────────────────┘
                              │ HTTPS/WSS
          ┌───────────────────┼───────────────────┐
          │                   │                   │
          ▼                   ▼                   ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│   GARDEN: Home  │  │  GARDEN: Office │  │  GARDEN: Cloud  │
│   Laptop        │  │  Desktop        │  │  Dev Server     │
├─────────────────┤  ├─────────────────┤  ├─────────────────┤
│ - Filesystem    │  │ - Filesystem    │  │ - Filesystem    │
│ - MCP servers   │  │ - MCP servers   │  │ - MCP servers   │
│ - Arms (PTY)    │  │ - Arms (PTY)    │  │ - Arms (PTY)    │
│ - Env vars      │  │ - Env vars      │  │ - Env vars      │
│ - Garden daemon │  │ - Garden daemon │  │ - Garden daemon │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

## Key Concepts

### Control Plane

The **Control Plane** consists of:
- **Brain**: Central coordinator that assigns tasks, resolves conflicts, and interfaces with humans
- **API Server**: REST/WebSocket server hosting the Observatory UI and persistence layer
- **Database**: SQLite database storing arms, tasks, proposals, activity

The Control Plane can run on any always-available machine: a home server, NAS, cloud VM, or even a Raspberry Pi. It doesn't need access to the project codebase - it only coordinates.

### Gardens

A **Garden** is a compute environment where arms actually run and do work. Each garden has:
- A local copy of the project (git clone)
- MCP servers providing tools (git, env, docs, etc.)
- A **Garden Daemon** that manages arm processes
- Environment variables and secrets for that environment

Gardens are tied to specific machines because:
1. Arms need local filesystem access for code editing
2. MCP servers may need local tools (git, node, docker)
3. Environment variables may differ per machine
4. PTY sessions are inherently local

### Garden Daemon

Each garden runs a lightweight daemon that:
- Registers with the Control Plane on startup
- Receives arm spawn/kill commands from Brain
- Manages PTY sessions for arms
- Streams arm logs back to Control Plane
- Reports heartbeats and arm status
- Handles local MCP server lifecycle

```typescript
interface GardenDaemon {
  gardenId: string;
  controlPlaneUrl: string;
  token: string;               // Auth token from Control Plane
  
  // Local state
  workdir: string;             // Project root
  arms: Map<string, ArmProcess>;
  mcpServers: McpServerConfig[];
  
  // Connection to Control Plane
  websocket: WebSocket;        // For real-time commands
  heartbeatInterval: number;   // ms between heartbeats
}
```

## Joining a Garden to the Control Plane

The join flow is inspired by Docker Swarm's simplicity:

### 1. Generate a Join Token (Control Plane)

```bash
# On the machine running the Control Plane
octopai garden token create --name "home-laptop"

# Output:
# Garden join token created for "home-laptop"
# 
# To join this garden, run on the target machine:
#
#   octopai garden join \
#     --token SWMTKN-1-abc123xyz... \
#     --control-plane https://octopai.example.com:8080
#
# Token expires in 24 hours. Run 'octopai garden token refresh' to extend.
```

### 2. Join from the Garden Machine

```bash
# On the laptop/desktop/server that will host arms
cd /path/to/my-project

octopai garden join \
  --token SWMTKN-1-abc123xyz... \
  --control-plane https://octopai.example.com:8080

# Output:
# Connecting to control plane...
# Registering garden "home-laptop"...
# Starting garden daemon...
# 
# ✓ Garden "home-laptop" joined successfully!
# 
# This garden is now available for arm deployment.
# The daemon will start automatically on boot.
#
# Status: octopai garden status
# Logs:   octopai garden logs
# Leave:  octopai garden leave
```

### 3. What Happens on Join

1. Garden daemon starts and connects to Control Plane via WebSocket
2. Sends registration with garden metadata (hostname, OS, available MCP servers)
3. Control Plane stores garden in database with status "connected"
4. Garden appears in Observatory UI under "Gardens" view
5. Brain can now assign arms to this garden

## Garden Registration

```typescript
interface GardenRegistration {
  gardenId: string;
  name: string;
  hostname: string;
  platform: "darwin" | "linux" | "windows";
  workdir: string;
  
  // Capabilities
  mcpServers: string[];        // Available MCP servers
  maxArms: number;             // Concurrent arm limit
  
  // Connection
  connectedAt: Date;
  lastHeartbeat: Date;
  status: "connected" | "disconnected" | "draining";
}
```

## Arm Placement

When spawning an arm, the Brain decides which garden to use:

```typescript
interface ArmPlacement {
  // Explicit placement
  gardenId?: string;           // If specified, use this garden
  
  // Or automatic placement based on:
  preferLocal?: boolean;       // Prefer garden on same machine as requestor
  requireMcp?: string[];       // Must have these MCP servers
  // Legacy: domainAffinity assumed static domains. Future implementations
  // should use task classifications or capability tags instead.
  domainAffinity?: string;
}
```

### Placement Strategies

| Strategy | Description |
|----------|-------------|
| `explicit` | User specifies garden by name/ID |
| `local-first` | Prefer garden on same machine as CLI/UI |
| `round-robin` | Distribute evenly across gardens |
| `least-loaded` | Place on garden with fewest active arms |
| `capability-match` | Place on garden with required MCP servers |

## Communication Flow

### Spawning an Arm

```
Human (CLI)                Control Plane              Garden Daemon
    │                           │                          │
    │ octopai arm spawn         │                          │
    │ ─────────────────────────>│                          │
    │                           │                          │
    │                           │ Select garden            │
    │                           │ (placement strategy)     │
    │                           │                          │
    │                           │ spawn_arm command        │
    │                           │ ────────────────────────>│
    │                           │                          │
    │                           │                          │ Start PTY
    │                           │                          │ Load MCP
    │                           │                          │ Send initial prompt
    │                           │                          │
    │                           │     arm_started          │
    │                           │ <────────────────────────│
    │                           │                          │
    │     arm spawned           │                          │
    │ <─────────────────────────│                          │
    │                           │                          │
```

### Arm Activity Streaming

```
Arm (PTY)                 Garden Daemon              Control Plane
    │                          │                          │
    │ output                   │                          │
    │ ────────────────────────>│                          │
    │                          │                          │
    │                          │ log_stream (batched)     │
    │                          │ ────────────────────────>│
    │                          │                          │
    │                          │                          │ Store in DB
    │                          │                          │ Broadcast to UI
    │                          │                          │
```

## Security

### Token-Based Authentication

- Join tokens are single-use and time-limited (default: 24 hours)
- After join, garden daemon receives a long-lived API key
- All communication uses HTTPS/WSS
- Tokens can be revoked from Control Plane

### Network Requirements

| Direction | Port | Protocol | Purpose |
|-----------|------|----------|---------|
| Garden → Control Plane | 8080 | HTTPS | REST API calls |
| Garden → Control Plane | 8080 | WSS | Real-time commands, log streaming |
| Control Plane → Garden | N/A | (via WS) | Commands sent over existing connection |

Gardens only need outbound connectivity - no inbound ports required.

## Offline Operation

Gardens can operate in degraded mode when disconnected:

| Feature | Online | Offline |
|---------|--------|---------|
| Arms continue working | ✓ | ✓ |
| New arm spawning | ✓ | ✗ |
| Task assignment | ✓ | ✗ (use cached) |
| Log streaming | ✓ | ✓ (buffered) |
| Proposals/governance | ✓ | ✗ |
| Human notifications | ✓ | ✗ |

When a garden reconnects:
1. Buffered logs are uploaded
2. Arm status is reconciled
3. Pending tasks are re-evaluated
4. Garden resumes normal operation

## CLI Commands

### Control Plane Commands

```bash
# Token management
octopai garden token create --name "my-laptop"
octopai garden token list
octopai garden token revoke <token-id>

# Garden management
octopai garden list                    # List all registered gardens
octopai garden status <garden-id>      # Detailed garden status
octopai garden drain <garden-id>       # Stop new arms, wait for existing
octopai garden remove <garden-id>      # Remove garden from cluster

# Arm placement
octopai arm spawn --garden home-laptop # Spawn on specific garden
octopai arm spawn --local              # Spawn on local garden (if running)
```

### Garden Commands (run on garden machine)

```bash
# Join/leave
octopai garden join --token ... --control-plane ...
octopai garden leave

# Local management
octopai garden status                  # Show local daemon status
octopai garden logs                    # Show daemon logs
octopai garden restart                 # Restart daemon

# MCP server management
octopai garden mcp list                # List available MCP servers
octopai garden mcp enable <server>     # Enable an MCP server
octopai garden mcp disable <server>    # Disable an MCP server
```

## Database Schema

```sql
-- Gardens table (on Control Plane)
CREATE TABLE gardens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  hostname TEXT,
  platform TEXT,
  workdir TEXT,
  
  -- Connection state
  status TEXT DEFAULT 'disconnected',
  connected_at TEXT,
  last_heartbeat TEXT,
  
  -- Capabilities
  mcp_servers TEXT,            -- JSON array
  max_arms INTEGER DEFAULT 4,
  
  -- Auth
  api_key_hash TEXT,
  
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Arms table updated with garden reference
ALTER TABLE arms ADD COLUMN garden_id TEXT REFERENCES gardens(id);
```

## Migration Path

For existing single-machine setups:

1. **No changes required** - Default behavior spawns arms locally
2. **Opt-in distribution** - Add gardens when ready
3. **Gradual migration** - Move arms between gardens as needed

The local machine is automatically registered as a garden named "local" when running `octopai serve`.

## Example Scenarios

### Working from Multiple Locations

```
Home laptop → joins as "home"
  - Used evenings/weekends
  - Has local dev environment

Office desktop → joins as "office"  
  - Used during work hours
  - More powerful, runs more arms

Cloud server → joins as "cloud"
  - Always on
  - Runs CI/testing arms
  - Hosts Control Plane
```

### Team Collaboration (Future)

Multiple developers could share a Control Plane while each running their own garden:

```
Control Plane (shared server)
├── Alice's laptop (garden: alice-mbp)
├── Bob's desktop (garden: bob-linux)
└── CI server (garden: ci-runner)
```

Each developer sees their own arms and can observe others' activity through the Observatory.

## Future Considerations

### Not In Scope (Avoiding Kubernetes Complexity)

- Automatic failover between gardens
- Load-based auto-scaling
- Complex networking (service mesh, etc.)
- Container orchestration
- Multi-region replication

### Potential Enhancements

- Garden groups (assign arms to a pool of gardens)
- Resource limits per garden
- Garden-specific MCP server configuration
- Encrypted log transmission
- Garden health monitoring and alerting
