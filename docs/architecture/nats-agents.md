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
│  - octopai.agents.register      (agent registration)         │
│  - octopai.agents.heartbeat     (agent liveness)             │
│  - octopai.agents.{id}.commands (commands to specific agent) │
│  - octopai.arms.events          (arm lifecycle events)       │
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
- **JetStream** (optional): For persistent message queues

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
octopai agent start --nats-url nats://localhost:4222
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

Topic: `octopai.agents.register`

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

Topic: `octopai.agents.heartbeat`

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

Topic: `octopai.agents.{agentId}.commands`

### Arm Events (Pub/Sub)

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

Topic: `octopai.arms.events`

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
| `OCTOPAI_NATS_URL` | `nats://localhost:4222` | NATS server URL |

### API Server Config

NATS connection is optional. If NATS is not available, the server falls back to local-only arm management:

```
NATS not available - distributed arm management disabled
```

### Agent Config

```bash
octopai agent start \
  --nats-url nats://localhost:4222 \  # NATS server URL
  --max-arms 10 \                       # Max concurrent arms
  --heartbeat-interval 30000 \          # Heartbeat interval (ms)
  --verbose                             # Debug logging
```

## Running the System

### Local Development (No Distribution)

```bash
# Just start the server - NATS is optional
octopai serve
```

### With Distributed Arms

```bash
# Terminal 1: Start NATS
docker compose up -d nats

# Terminal 2: Start API server
octopai serve

# Terminal 3: Start agent (same or different host)
octopai agent start --nats-url nats://localhost:4222
```

### Multi-Host Setup

```bash
# On server (192.168.1.100):
docker compose up -d nats
octopai serve

# On laptop:
octopai agent start --nats-url nats://192.168.1.100:4222

# On desktop:
octopai agent start --nats-url nats://192.168.1.100:4222
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
| Persistence | None (stateless) | Local state file |
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

The agent doesn't persist arm state. If an agent restarts, running OpenCode processes become orphaned.

**Solution**: Kill orphaned processes manually, or implement arm recovery (future enhancement).

## Future Enhancements

1. **Agent State Persistence**: Save running arm info to recover after restart
2. **Arm Migration**: Move arms between agents
3. **Resource Limits**: CPU/memory limits per agent
4. **Encrypted Transport**: TLS for NATS connections
5. **Agent Groups**: Logical grouping for placement policies
