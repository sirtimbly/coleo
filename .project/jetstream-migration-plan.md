# JetStream Event Sourcing Migration Plan

## Overview

Migrate from SQLite-based event storage to NATS JetStream for event persistence, enabling event sourcing patterns for state reconstruction and audit trails.

## Current State

- Events stored in SQLite `arm_events` table
- Events published by harnesses via `emitEvent()`
- Events queried via API endpoints
- No event sourcing patterns implemented

## Target State

- Events persisted in NATS JetStream streams
- State derived from event streams (event sourcing)
- Comprehensive API for event querying and state reconstruction
- Real-time event processing and historical analysis

## Phase 1: Infrastructure & Client Setup

### 1.1 Enable JetStream on NATS Server
```yaml
# docker-compose.yml
services:
  nats:
    image: nats:2.10-alpine
    command: [
      "--jetstream",
      "--http_port", "8222",
      "--js-max_mem", "1GB",
      "--js-max_file", "10GB",
      "--js-max_bytes_required"
    ]
    volumes:
      - ./nats-data:/tmp/nats/jetstream
```

### 1.2 JetStream Client Integration
```typescript
// src/nats/jetstream.ts
import { JetStreamManager, JetStreamClient } from 'nats';

export class EventStore {
  private js: JetStreamClient;
  private jsm: JetStreamManager;

  async initialize(connection: NatsConnection) {
    this.js = connection.jetstream();
    this.jsm = await connection.jetstreamManager();
  }

  async ensureStream() {
    // Create stream if it doesn't exist
    await this.jsm.streams.add({
      name: 'octopai-events',
      subjects: ['octopai.events.arm.*.*'],
      retention: RetentionPolicy.Limits,
      max_age: 7 * 24 * 60 * 60 * 1000,  // 7 days
      max_msgs: 100000,                   // 100K events
      max_bytes: 500 * 1024 * 1024,      // 500MB
      storage: StorageType.File,
    });
  }

  async publishEvent(subject: string, data: any) {
    await this.js.publish(subject, JSON.stringify({
      ...data,
      timestamp: new Date().toISOString(),
    }));
  }
}
```

## Phase 2: Event Publishing Migration

### 2.1 Update Harness Event Publishing
Currently harnesses call `emitEvent(armId, eventType, data)`. Update to publish to JetStream:

```typescript
// src/harness/opencode-api.ts
private async publishEvent(eventType: string, data: any) {
  const subject = `octopai.events.arm.${this.armId}.${eventType}`;
  await this.eventStore?.publishEvent(subject, {
    ...data,
    armId: this.armId,
    harness: 'opencode-api',
  });
}
```

### 2.2 Event Type Standardization
Define comprehensive event schema:

```typescript
// State Transition Events
"arm.spawned" | "arm.status_changed" | "arm.killed" | "arm.heartbeat"
"task.assigned" | "task.claimed" | "task.completed" | "task.blocked"
"status_report.submitted" | "status_report.processed"

// Activity Events
"message.sent" | "message.received"
"tool.invoked" | "tool.completed" | "tool.failed"
"file.created" | "file.modified" | "file.deleted"
"session.compacted" | "session.created" | "session.error"

// Question/Decision Events (CRITICAL for Brain Decision Handling)
"question.asked" | "question.replied" | "question.rejected"

// System Events
"brain.task_determined" | "brain.status_analyzed"
"discovery.created" | "plan.updated"
```

### 2.3 Question Event Format (Critical for Brain Decision Handling)

When arms ask questions requiring human decision, they emit `question.asked` events with this structure:

```typescript
interface QuestionAskedEvent {
  type: "question.asked";
  properties: {
    id: string;        // Question request ID (starts with "que")
    sessionID: string; // OpenCode session ID (starts with "ses")
    questions: QuestionInfo[]; // Array of questions to ask
    tool?: {           // Optional: links to MCP tool call
      messageID: string;
      callID: string;
    };
  };
}

interface QuestionInfo {
  question: string;     // The actual question text
  header: string;       // Short label (max 12 chars)
  options: QuestionOption[]; // Available choices
  multiple?: boolean;   // Allow multiple selections
}

interface QuestionOption {
  label: string;        // Display text (1-5 words, concise)
  description: string;  // Explanation of choice
}
```

**Brain Response Events:**
- `question.replied`: Human answered the question
- `question.rejected`: Question was rejected/ignored

**Brain Action Required:**
When the brain detects a `question.asked` event from any arm, it should:
1. Parse the question content and options
2. Evaluate if it can answer autonomously or needs human input
3. Either respond directly or escalate to human
4. Track the question-response cycle for learning

## Phase 3: State Reconstruction Functions

### 3.1 Task State Reconstruction
```typescript
async getTaskState(taskId: string): Promise<TaskState> {
  const events = await this.queryEvents({
    subject: `octopai.events.task.${taskId}.*`,
    limit: 1000
  });

  return events.reduce((state, event) => {
    switch(event.type) {
      case "task.assigned": return { ...state, assignedTo: event.data.armId };
      case "task.claimed": return { ...state, status: "in_progress", claimedAt: event.timestamp };
      case "task.completed": return { ...state, status: "completed", completedAt: event.timestamp };
      case "task.blocked": return { ...state, status: "blocked", blockers: event.data.blockers };
    }
    return state;
  }, { id: taskId, status: "pending" } as TaskState);
}
```

### 3.2 Arm State Reconstruction
```typescript
async getArmState(armId: string): Promise<ArmState> {
  const events = await this.queryEvents({
    subject: `octopai.events.arm.${armId}.*`,
    limit: 500
  });

  const state = events.reduce((state, event) => {
    switch(event.type) {
      case "arm.spawned": return { ...state, ...event.data, status: "idle" };
      case "arm.status_changed": return { ...state, status: event.data.to };
      case "arm.heartbeat": return { ...state, lastHeartbeat: event.timestamp };
      case "arm.killed": return { ...state, status: "stopped" };
    }
    return state;
  }, { id: armId, status: "unknown" } as ArmState);

  // Check if stale
  if (state.lastHeartbeat) {
    const age = Date.now() - new Date(state.lastHeartbeat).getTime();
    if (age > 5 * 60 * 1000) state.status = "stale";
  }

  return state;
}
```

### 3.3 Activity Analysis
```typescript
async getArmActivity(armId: string, since: Date): Promise<ActivitySummary> {
  const events = await this.queryEvents({
    subject: `octopai.events.arm.${armId}.*`,
    since,
  });

  return {
    messageCount: events.filter(e => e.type.startsWith('message.')).length,
    toolUsage: events.filter(e => e.type.startsWith('tool.')).length,
    fileChanges: events.filter(e => e.type.startsWith('file.')).length,
    errors: events.filter(e => e.type === 'session.error').length,
    lastActivity: events[events.length - 1]?.timestamp,
  };
}
```

## Phase 4: API Routes Update

### 4.1 Event Querying Routes
Replace SQLite queries with JetStream queries:

```typescript
// GET /api/arms/:id/events
app.get("/:id/events", async (c) => {
  const armId = c.req.param("id");
  const limit = parseInt(c.req.query("limit") || "50");
  const since = c.req.query("since");

  const events = await eventStore.queryEvents({
    subject: `octopai.events.arm.${armId}.*`,
    limit,
    since: since ? new Date(since) : undefined,
  });

  return c.json({
    armId,
    events: events.map(e => ({
      type: e.type,
      data: e.data,
      timestamp: e.timestamp,
    })),
  });
});
```

### 4.2 State Reconstruction Routes
```typescript
// GET /api/tasks/:id/state-derived
app.get("/tasks/:id/state-derived", async (c) => {
  const taskId = c.req.param("id");
  const state = await eventStore.reconstructTaskState(taskId);
  return c.json(state);
});

// GET /api/arms/:id/state-derived
app.get("/:id/state-derived", async (c) => {
  const armId = c.req.param("id");
  const state = await eventStore.reconstructArmState(armId);
  return c.json(state);
});
```

### 4.3 Analytics Routes
```typescript
// GET /api/events/metrics
app.get("/events/metrics", async (c) => {
  const metrics = await eventStore.getStreamMetrics();
  return c.json(metrics);
});

// GET /api/events/types
app.get("/events/types", async (c) => {
  const eventTypes = await eventStore.getEventTypes();
  return c.json({ eventTypes });
});
```

## Phase 5: Brain Logic Migration

### 5.1 Task State Queries
Replace direct database queries in brain with event-sourced queries:

```typescript
// Current: Database query
const task = this.tasks.find(t => t.id === taskId);

// Future: Event-sourced
const taskState = await eventStore.getTaskState(taskId);
```

### 5.2 Activity Detection
Replace in-memory activity tracking with event queries:

```typescript
// Current: In-memory tracking
const lastEventTime = this.lastArmEventTime.get(arm.id);

// Future: Event query
const activity = await eventStore.getArmActivity(arm.id, lastCheckTime);
const isActive = activity.lastActivity > threshold;
```

### 5.3 Status Report Processing
Replace status report queries with event filtering:

```typescript
// Current: Database query
const reports = this.db.query(`SELECT * FROM status_reports WHERE task_id = ?`);

// Future: Event query
const reports = await eventStore.queryEvents({
  subject: `octopai.events.arm.*.status_report.submitted`,
  filter: event => event.data.taskId === taskId
});
```

## Phase 6: Performance & Scaling

### 6.1 Consumer Strategies
```typescript
// Push consumer for real-time WebSocket updates
const wsConsumer = await jsm.consumers.add(streamName, {
  durable_name: "websocket-broadcaster",
  deliver_policy: DeliverPolicy.Last,
  filter_subject: "octopai.events.arm.*.*",
  ack_policy: AckPolicy.None,
});

// Pull consumer for historical queries
const queryConsumer = await jsm.consumers.add(streamName, {
  durable_name: `query-consumer-${Date.now()}`,
  deliver_policy: DeliverPolicy.ByStartTime,
  ack_policy: AckPolicy.Explicit,
  max_deliver: 1,  // Ephemeral
});
```

### 6.2 Caching Layer
```typescript
class StateCache {
  private taskCache = new Map<string, CachedState<TaskState>>();
  private armCache = new Map<string, CachedState<ArmState>>();

  async getTaskState(taskId: string): Promise<TaskState> {
    const cached = this.taskCache.get(taskId);
    if (cached && !this.isExpired(cached)) {
      return cached.state;
    }

    const state = await eventStore.reconstructTaskState(taskId);
    this.taskCache.set(taskId, { state, cachedAt: Date.now() });
    return state;
  }
}
```

### 6.3 Batch Operations
```typescript
async getMultipleStates(ids: string[], type: 'task' | 'arm') {
  const subjects = ids.map(id => `octopai.events.${type}.${id}.>`);
  const events = await eventStore.queryEvents({
    subjects,  // JetStream supports multiple subject patterns
    limit: ids.length * 100
  });

  // Group and reconstruct
  return this.reconstructStates(events, type);
}
```

## Phase 7: Migration Timeline

### Week 1-2: Foundation
- ✅ JetStream setup and client integration
- ✅ Stream creation and basic publishing
- ✅ Event schema standardization
- ✅ Basic state reconstruction functions

### Week 3-4: API Migration
- ✅ Update API routes to use JetStream queries
- ✅ Add state derivation endpoints
- ✅ Implement real-time consumers
- ✅ Add analytics and monitoring endpoints

### Week 5-6: Brain Migration
- ✅ Migrate brain task state queries to event-sourcing
- ✅ Update activity detection logic
- ✅ Replace status report processing
- ✅ Add caching layer for performance

### Week 7-8: Optimization & Cleanup
- ✅ Performance tuning and batch operations
- ✅ Remove old SQLite event tables
- ✅ Update documentation
- ✅ Add monitoring and alerting

## Key Architectural Decisions

### Stream Partitioning
- **Decision**: Single stream with subject partitioning (`octopai.events.arm.{armId}.{eventType}`)
- **Rationale**: Efficient filtering, scalable, supports cross-arm queries

### Consumer Strategy
- **Push consumers**: Real-time updates (WebSocket broadcasting)
- **Pull consumers**: Historical queries (API endpoints)
- **Hybrid approach**: Best of both worlds

### State Reconstruction
- **Event sourcing pattern**: Current state computed from event history
- **Caching**: Frequently accessed states cached in memory
- **Fallback**: SQLite as backup during migration

## Benefits

1. **Audit Trail**: Complete history of all state changes
2. **Scalability**: Event streams can be partitioned and replicated
3. **Consistency**: Single source of truth for state
4. **Replay Capability**: Reconstruct state at any point in time
5. **Real-time**: Push-based updates instead of polling

## Risks & Mitigations

### Data Loss Risk
- **Mitigation**: Dual-write during migration, JetStream file storage
- **Backup**: Export events periodically to cold storage

### Performance Impact
- **Mitigation**: Caching layer, batch operations, subject filtering
- **Monitoring**: Query performance metrics and alerts

### Complexity Increase
- **Mitigation**: Gradual migration, comprehensive testing
- **Documentation**: Clear event schemas and reconstruction logic

## Success Criteria

- [ ] All brain database queries for state replaced with event queries
- [ ] WebSocket real-time updates working via JetStream consumers
- [ ] API endpoints returning event-sourced data
- [ ] State reconstruction working for tasks and arms
- [ ] Performance benchmarks met (query < 100ms, reconstruction < 500ms)
- [ ] No data loss during migration
- [ ] Backward compatibility maintained during transition