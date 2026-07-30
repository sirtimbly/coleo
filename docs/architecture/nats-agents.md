# NATS-Based Arm Agent System

This document describes the NATS messaging system used for distributed arm management in Coleo. This allows arms to run on multiple hosts while being coordinated by a central API server.

## Overview

The arm agent system uses [NATS](https://nats.io) as a lightweight message queue for communication between the API server and distributed arm agents. This architecture enables:

- **Server Restart Resilience**: Arms keep running even if the API server restarts
- **Multi-Host Support**: Arms can run on different machines than the API server
- **Decoupled Architecture**: Agents manage local arms independently
- **Real-time Events**: Status changes propagate instantly via pub/sub

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    API Server (Host A)                       │
│  ┌──────────────────┐  ┌──────────────────────────────────┐ │
│  │    ArmClient     │  │         WebSocket Server         │ │
│  │  - Agent tracking│  │  - Dashboard connections         │ │
│  │  - Command send  │  │  - Event broadcasting            │ │
│  │  - Event receive │  │                                  │ │
│  └────────┬─────────┘  └──────────────────────────────────┘ │
└───────────┼─────────────────────────────────────────────────┘
            │
            │ NATS Protocol (nats://host:4222)
            │
┌───────────┴─────────────────────────────────────────────────┐
│                     NATS Server                              │
│              (Docker: nats:2.10-alpine)                      │
│                                                              │
│  Topics:                                                     │
│  - coleo.agent.register       (agent registration)         │
│  - coleo.agent.heartbeat      (agent liveness)             │
│  - coleo.agent.{id}.command   (commands to specific agent) │
│  - coleo.brain.messages       (arm -> brain ingress)       │
│  - coleo.events.*             (JetStream event history)    │
└───────────┬─────────────────────────────────────────────────┘
            │
    ┌───────┴───────┬───────────────────┐
    │               │                   │
┌───▼───────────┐ ┌─▼───────────────┐ ┌─▼───────────────┐
│  ArmAgent     │ │  ArmAgent       │ │  ArmAgent       │
│  (Host A)     │ │  (Host B)       │ │  (Host C)       │
│               │ │                 │ │                 │
│ ┌───────────┐ │ │ ┌───────────┐   │ │ ┌───────────┐   │
│ │ OpenCode  │ │ │ │ OpenCode  │   │ │ │ OpenCode  │   │
│ │  Arm 1    │ │ │ │  Arm 2    │   │ │ │  Arm 3    │   │
│ └───────────┘ │ │ └───────────┘   │ │ └───────────┘   │
│ ┌───────────┐ │ │                 │ │ ┌───────────┐   │
│ │ OpenCode  │ │ │                 │ │ │ OpenCode  │   │
│ │  Arm 4    │ │ │                 │ │ │  Arm 5    │   │
│ └───────────┘ │ │                 │ │ └───────────┘   │
└───────────────┘ └─────────────────┘ └─────────────────┘
```

## Components

### NATS Server

A lightweight, high-performance message broker. We run it in Docker for reliability:

```yaml
# docker-compose.yml
services:
  nats:
    image: nats:2.10-alpine
    command: ["--jetstream", "--http_port", "8222"]
    ports:
      - "4222:4222"  # Client connections
      - "8222:8222"  # Monitoring
```

NATS provides:
- **Pub/Sub**: For broadcasting events to all subscribers
- **Request/Reply**: For sending commands and waiting for responses
- **JetStream**: Durable event and message persistence for replay/recovery

### ArmClient (API Server Side)

Located in `src/nats/arm-client.ts`, the ArmClient runs in the API server and:

1. **Tracks Connected Agents**: Maintains a registry of all connected ArmAgents
2. **Routes Commands**: Sends spawn/kill/prompt commands to the correct agent
3. **Receives Events**: Subscribes to arm events and forwards them to WebSocket clients
4. **Load Balancing**: Selects the best agent for new arm placement

```typescript
// Key methods
armClient.spawnArm(agentId, armId, options)  // Spawn an arm on specific agent
armClient.killArm(armId)                      // Kill an arm (routes to correct agent)
armClient.sendPrompt(armId, prompt)           // Send prompt to an arm
armClient.findBestAgent(harness)              // Find agent with capacity
armClient.getAgents()                         // List all connected agents
```

### ArmAgent (Host Side)

Located in `src/agent/arm-agent.ts`, the ArmAgent runs as a daemon on each host that will run arms:

1. **Manages Local Arms**: Spawns and manages OpenCode processes locally
2. **Executes Commands**: Receives and executes spawn/kill/prompt commands
3. **Reports Status**: Sends heartbeats and arm status updates
4. **Survives Restarts**: Arms keep running if the agent restarts

```bash
# Start an agent daemon
coleo agent start --nats-url nats://localhost:4222
```

## Message Types

### Agent Registration

When an agent starts, it publishes its info:

```typescript
interface AgentInfo {
  agentId: string;        // Unique agent identifier
  hostname: string;       // Machine hostname
  platform: string;       // darwin, linux, windows
  startedAt: string;      // ISO timestamp
  version: string;        // Agent version
  capabilities: string[]; // Supported harnesses: ["opencode", "opencode-api"]
  maxArms: number;        // Maximum concurrent arms
}
```

Topic: `coleo.agent.register`

### Agent Heartbeat

Agents send periodic heartbeats (every 30 seconds by default):

```typescript
interface AgentHeartbeat {
  agentId: string;
  timestamp: string;
  activeArms: string[];   // List of arm IDs currently running
  load: {
    cpu: number;          // CPU usage (0-1)
    memory: number;       // Memory usage (0-1)
  };
}
```

Topic: `coleo.agent.heartbeat`

### Commands (Request/Reply)

Commands are sent to specific agents using request/reply pattern:

```typescript
// Spawn a new arm
interface SpawnArmCommand {
  type: 'spawn';
  requestId: string;
  armId: string;
  name: string;
  domain: string;
  harness: string;
  provider?: string;
  model?: string;
  workDir?: string;
}

// Kill an arm
interface KillArmCommand {
  type: 'kill';
  requestId: string;
  armId: string;
}

// Send prompt to arm
interface SendPromptCommand {
  type: 'prompt';
  requestId: string;
  armId: string;
  prompt: string;
}

// Response format
interface CommandResponse<T = unknown> {
  requestId: string;
  success: boolean;
  error?: string;
  data?: T;
}
```

Topic: `coleo.agent.{agentId}.command`

### Arm Events + Brain Ingress

Agents publish arm lifecycle events:

```typescript
interface ArmSpawnedEvent {
  type: 'arm.spawned';
  armId: string;
  agentId: string;
  state: ArmState;
}

interface ArmKilledEvent {
  type: 'arm.killed';
  armId: string;
  agentId: string;
}

interface ArmStatusChangedEvent {
  type: 'arm.status_changed';
  armId: string;
  agentId: string;
  oldStatus: ArmStatus;
  newStatus: ArmStatus;
}
```

Topics:
- `coleo.arm.{armId}.event` (lifecycle/log style per-arm events)
- `coleo.brain.messages` (validated arm-to-brain operational messages)
- `coleo.events.*` (JetStream-backed event history)

## Communication Flows

### Spawning an Arm

```
CLI/UI              API Server           NATS            ArmAgent
  │                     │                  │                 │
  │ POST /api/arms/spawn│                  │                 │
  │ ───────────────────>│                  │                 │
  │                     │                  │                 │
  │                     │ findBestAgent()  │                 │
  │                     │ (select agent)   │                 │
  │                     │                  │                 │
  │                     │ Request: spawn   │                 │
  │                     │ ────────────────>│                 │
  │                     │                  │ ───────────────>│
  │                     │                  │                 │
  │                     │                  │   spawn arm     │
  │                     │                  │   locally       │
  │                     │                  │                 │
  │                     │                  │ Reply: success  │
  │                     │                  │ <───────────────│
  │                     │ <────────────────│                 │
  │                     │                  │                 │
  │                     │                  │ Pub: arm.spawned│
  │                     │                  │ <───────────────│
  │                     │ <────────────────│                 │
  │                     │                  │                 │
  │                     │ broadcast to     │                 │
  │                     │ WebSocket clients│                 │
  │                     │                  │                 │
  │ 200 OK {armId}      │                  │                 │
  │ <───────────────────│                  │                 │
```

### Sending a Prompt

```
CLI/UI              API Server           NATS            ArmAgent
  │                     │                  │                 │
  │ POST /arms/{id}/prompt                 │                 │
  │ ───────────────────>│                  │                 │
  │                     │                  │                 │
  │                     │ getAgentForArm() │                 │
  │                     │ (lookup mapping) │                 │
  │                     │                  │                 │
  │                     │ Request: prompt  │                 │
  │                     │ ────────────────>│                 │
  │                     │                  │ ───────────────>│
  │                     │                  │                 │
  │                     │                  │  send to PTY    │
  │                     │                  │                 │
  │                     │                  │ Reply: success  │
  │                     │                  │ <───────────────│
  │                     │ <────────────────│                 │
  │                     │                  │                 │
  │ 200 OK              │                  │                 │
  │ <───────────────────│                  │                 │
```

### Agent Failure Detection

```
                    API Server           NATS            ArmAgent
                        │                  │                 │
                        │                  │   heartbeat     │
                        │ <────────────────│ <───────────────│
                        │                  │                 │
                        │ update lastSeen  │                 │
                        │                  │                 │
                        │                  │   heartbeat     │
                        │ <────────────────│ <───────────────│
                        │                  │                 │
                        │        ...       │                 │
                        │                  │                 │
                        │  (no heartbeat   │                 │ (agent dies)
                        │   for 90 sec)    │                 │
                        │                  │                 │
                        │ mark agent stale │                 │
                        │ broadcast        │                 │
                        │ agent.disconnected                 │
                        │                  │                 │
```

## Database Schema

The arms table includes agent tracking columns:

```sql
-- Migration 014: Add agent_id and host for distributed arm management
ALTER TABLE arms ADD COLUMN agent_id TEXT;
ALTER TABLE arms ADD COLUMN host TEXT;
CREATE INDEX idx_arms_agent ON arms(agent_id);
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `COLEO_NATS_HOST` | `127.0.0.1` | Local NATS bind and client host used by the API server and agents. |
| `COLEO_NATS_PORT` | `4222` | Local NATS client port. |
| `COLEO_NATS_HTTP_PORT` | `8222` | Local NATS monitoring port. |
| `COLEO_NATS_URL` | derived from host/port | External NATS URL override. If unset, `coleo serve` bootstraps project-local NATS. |

Use separate NATS and monitoring ports for each local project. Otherwise a second project can connect to an existing
NATS listener and share JetStream events unintentionally. `coleo init` can generate available values and write them to
the project's `mise.toml`.

### API Server Config

For distributed arm orchestration and brain message ingress, NATS + JetStream are required:

- `opencode-api` and `opencode` are daemon-managed and require at least one connected `ArmAgent`
- `opencode-tui` can still be spawned locally for operator-visible sessions
- The Observatory Arms view and the CLI both use `POST /api/arms/:id/spawn`, so a stopped or unspawned arm profile can be started remotely from the browser once an `ArmAgent` is connected

If NATS is unavailable, distributed arm management and stream-backed activity/history are unavailable.

### Agent Config

```bash
coleo agent start \
  --nats-url nats://localhost:4222 \  # NATS server URL
  --max-arms 10 \                       # Max concurrent arms
  --heartbeat-interval 30000 \          # Heartbeat interval (ms)
  --verbose                             # Debug logging
```

## Running the System

### Local Development (Single Host)

```bash
# Start the API server
# If COLEO_NATS_URL is unset, this will auto-start local NATS
coleo serve
```

### With Distributed Arms

```bash
# Terminal 1: Start API server
# If COLEO_NATS_URL is unset, this will auto-start local NATS
coleo serve

# Terminal 2: Start agent (same or different host)
coleo agent start --nats-url nats://localhost:4222
```

### Multi-Host Setup

```bash
# On server (192.168.1.100):
docker compose up -d nats
coleo serve

# On laptop:
coleo agent start --nats-url nats://192.168.1.100:4222

# On desktop:
coleo agent start --nats-url nats://192.168.1.100:4222
```

## Monitoring

### NATS Monitoring

NATS provides a monitoring endpoint at port 8222:

```bash
# Check NATS health
curl http://localhost:8222/healthz

# View connections
curl http://localhost:8222/connz

# View subscriptions
curl http://localhost:8222/subsz
```

### API Endpoints

```bash
# List connected agents
curl http://localhost:8080/api/agents

# Get specific agent
curl http://localhost:8080/api/agents/{agentId}

# List arms on an agent
curl http://localhost:8080/api/agents/{agentId}/arms
```

## Comparison with Garden System

This NATS-based system is a simpler precursor to the full "Garden" concept described in `distributed.md`:

| Feature | NATS Agents | Gardens (Future) |
|---------|-------------|------------------|
| Scope | Arm management only | Full environment |
| Auth | Simple API key | Token-based join flow |
| Features | Spawn, kill, prompt | + MCP servers, env vars |
| Persistence | JetStream-backed events/messages | Local state file |
| Offline mode | No | Yes (buffered) |

The NATS system provides the foundation for distributed arms. The Garden concept builds on top of this to provide a complete remote development environment.

## Troubleshooting

### Agent Can't Connect to NATS

```
[NATS] Connection attempt 1 failed: Error: connect ECONNREFUSED
```

**Solution**: Ensure NATS is running and accessible:
```bash
docker compose up -d nats
curl http://localhost:8222/healthz
```

### Commands Timing Out

```
[ArmClient] Command timed out after 30000ms
```

**Possible causes**:
- Agent is not running or disconnected
- Agent is overloaded
- Network issues between server and agent

**Debug**:
```bash
# Check agent status
curl http://localhost:8080/api/agents

# Check NATS connections
curl http://localhost:8222/connz
```

### Arms Not Appearing After Agent Restart

`ArmAgent` performs best-effort process recovery on startup:

- `opencode-api`: recoverable when process + port are still available
- PTY/TUI harnesses: re-attachment is limited and may require manual restart
- API-initiated `arm recover` will reattach only when the runtime is confirmed by a live agent; otherwise it restarts the arm on a reachable compatible agent.

If recovery fails, restart the affected arm from the API/CLI.

## Future Enhancements

1. **Agent State Persistence**: Save running arm info to recover after restart
2. **Arm Migration**: Move arms between agents
3. **Resource Limits**: CPU/memory limits per agent
4. **Encrypted Transport**: TLS for NATS connections
5. **Agent Groups**: Logical grouping for placement policies
