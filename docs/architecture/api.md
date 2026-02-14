# API Design

The Observatory exposes a REST API and WebSocket for real-time updates. All endpoints require authentication via a shared API key.

## Authentication

All requests must include the API key in the header:

```
X-API-Key: your-shared-secret
```

## Arm API Isolation

**Critical**: Arms must NOT have direct access to the Observatory API. If arms could call these endpoints with curl, they could:
- Kill other arms (`DELETE /api/arms/:id`)
- Override the brain (`POST /api/brain/stop`)
- Approve their own proposals (`POST /api/approvals/:id/approve`)
- Manipulate reputation scores

### Isolation Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    API ACCESS MODEL                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Human (Browser/CLI)                                         │
│     │                                                        │
│     │ X-API-Key: human-secret                                │
│     ▼                                                        │
│  Observatory API (Full Access)                               │
│     │                                                        │
│     │                                                        │
│  Brain                                                       │
│     │                                                        │
│     │ MCP Protocol (not HTTP)                                │
│     ▼                                                        │
│  Arms (MCP Access Only)                                      │
│     │                                                        │
│     ✗ No HTTP access to Observatory                          │
│     ✗ No API key                                             │
│     ✗ Network blocked to localhost:observatory-port          │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### How Arms Communicate

Arms communicate ONLY through MCP, not HTTP:

```typescript
// Arms use MCP tools, NOT curl
// WRONG - arm should never do this:
// curl -X DELETE http://localhost:8080/api/arms/other-arm

// RIGHT - arm uses MCP to request action:
await mcp.call("brain.request", {
  action: "pause_arm",
  target: "other-arm",
  reason: "Detected conflict in shared file",
});
// Brain validates, logs, and may reject the request
```

### Network Isolation

Arms are blocked from accessing the Observatory:

```typescript
const ARM_BLOCKED_HOSTS = [
  "localhost:8080",           // Observatory API
  "127.0.0.1:8080",
  "observatory",              // Docker network name
  "host.docker.internal:8080",
];

// In Docker, use network policies
// In local dev, use firewall rules or process sandboxing
```

### Scoped API Keys (Future)

For production, implement scoped keys:

```typescript
interface APIKeyScope {
  key: string;
  type: "human" | "service" | "readonly";
  permissions: Permission[];
  armId?: string;              // If service key, which arm
}

type Permission = 
  | "arms:read" | "arms:write" | "arms:kill"
  | "proposals:read" | "proposals:write" | "proposals:resolve"
  | "deploy:read" | "deploy:request" | "deploy:approve"
  | "brain:control"
  | "*";                       // Human admin only

const HUMAN_KEY: APIKeyScope = {
  key: "human-admin-key",
  type: "human",
  permissions: ["*"],
};

const READONLY_KEY: APIKeyScope = {
  key: "dashboard-readonly",
  type: "readonly",
  permissions: ["arms:read", "proposals:read", "deploy:read"],
};
```

### Request Validation

All arm-affecting requests are validated:

```typescript
async function validateArmAction(
  request: Request,
  action: string,
  targetArmId?: string
): Promise<ValidationResult> {
  const key = request.headers.get("X-API-Key");
  const scope = await getKeyScope(key);
  
  // Check if this is an arm trying to act on itself or others
  if (scope.type === "service" && scope.armId) {
    // Arms cannot kill other arms directly
    if (action === "arms:kill" && targetArmId !== scope.armId) {
      return { allowed: false, reason: "Arms cannot kill other arms" };
    }
    // Arms cannot approve proposals
    if (action === "proposals:resolve") {
      return { allowed: false, reason: "Arms cannot resolve proposals" };
    }
  }
  
  return { allowed: scope.permissions.includes(action) || scope.permissions.includes("*") };
}
```

## REST Endpoints

### System

```http
GET /api/status
```
Returns overall system status.

```json
{
  "brain": { "status": "running", "uptime": 3600 },
  "arms": { "total": 5, "active": 3, "paused": 1 },
  "proposals": { "open": 2, "pending_human": 1 },
  "garden": { "files": 1234, "conflicts": 0 }
}
```

```http
GET /api/health
```
Health check endpoint (no auth required).

---

### Brain

```http
GET /api/brain
```
Get brain state.

```http
POST /api/brain/start
```
Start the brain if stopped.

```http
POST /api/brain/stop
```
Stop the brain gracefully.

#### Brain inbox/message endpoints

These are internal API endpoints used by the Brain worker and API bridge:

```http
POST /api/brain/internal/messages/queue
GET /api/brain/internal/messages/pending?to=brain
POST /api/brain/internal/messages/:id/status
POST /api/brain/internal/messages/cleanup
```

Notes:
- Only allowlisted brain message types are accepted for `to=brain`.
- Invalid/unsupported messages are dead-lettered (`to_id = brain.deadletter`) instead of silently dropped.
- Brain workers acquire processing leases (`success: true|false`) before handling messages.

---

### Arms

```http
GET /api/arms
```
List all arms.

```json
{
  "arms": [
    {
      "id": "ui-arm",
      "name": "UI Specialist",
      "domain": "ui",
      "status": "working",
      "reputation": 75,
      "contextUtilization": 0.65
    }
  ]
}
```

```http
POST /api/arms
```
Spawn a new arm.

```json
{
  "name": "Test Runner",
  "agent": "opencode",
  "domain": "testing",
  "workdir": "/path/to/project"
}
```

```http
GET /api/arms/:id
```
Get arm details.

```http
DELETE /api/arms/:id
```
Kill an arm.

```http
PATCH /api/arms/:id
```
Update arm configuration.

```http
GET /api/arms/:id/context
```
Get arm's current context (files, tokens).

```http
GET /api/arms/:id/activity
```
Get arm's activity log.

### Activity endpoint semantics

The API has two different "activity" surfaces:

- `/api/arms/:id/activity`: arm-scoped activity history (single arm timeline).
- `/api/activity/*`: cross-arm/system activity and transcript views from JetStream.

Use arm-scoped activity for per-arm debugging and `/api/activity` for global analysis dashboards.

```http
POST /api/arms/:id/pause
```
Pause an arm.

```http
POST /api/arms/:id/resume
```
Resume a paused arm.

---

### Tasks

```http
GET /api/tasks
```
List all tasks.

Query params:
- `status`: "pending" | "claimed" | "in_progress" | "completed" | "failed" | "blocked" | "cancelled" (comma-separated for multiple)
- `priority`: "critical" | "high" | "normal" | "low"
- `domain`: filter by domain
- `assignedTo`: filter by assigned arm
- `phase`: filter by phase
- `limit`: max results (default 100)
- `offset`: pagination offset

```http
POST /api/tasks
```
Create a new task.

```http
GET /api/tasks/:id
```
Get task details.

Query params:
- `include`: "discussions" to include task comments.

```http
PATCH /api/tasks/:id
```
Update task fields.

```http
DELETE /api/tasks/:id
```
Delete a task.

```http
POST /api/tasks/reorder
```
Reorder a task to a specific position.

```json
{
  "taskId": "task-123",
  "toSortOrder": 0
}
```

```http
POST /api/tasks/:id/remove-from-plan
```
Remove a task from its source `plan.md` file and delete it from the database.

## Task Discussions

Task Discussions provide threaded commenting functionality for tasks, allowing humans and arms to collaborate on task implementation. Each comment is associated with a specific task and can be a top-level comment or a reply to another comment.

```http
GET /api/tasks/:id/discussions
```
List all comments for a task.

Query params:
- `limit`: max results (default 50)
- `offset`: pagination offset
- `threaded`: "true" to return comments in a nested tree structure.

Response:
```json
{
  "discussions": [
    {
      "id": "comment-123",
      "taskId": "task-456",
      "content": "This task is blocked by PR-789",
      "authorType": "human",
      "authorId": "user-1",
      "authorName": "Tim",
      "client": "web",
      "edited": false,
      "deleted": false,
      "createdAt": "2024-01-15T10:30:00Z",
      "updatedAt": "2024-01-15T10:30:00Z"
    }
  ],
  "totalCount": 1
}
```

```http
POST /api/tasks/:id/discussions
```
Add a new comment to a task discussion.

Body:
```json
{
  "content": "This task is blocked by PR-456",
  "parentId": "comment-789",
  "authorType": "human",
  "authorId": "user-1",
  "authorName": "Tim",
  "client": "web"
}
```

```http
PATCH /api/tasks/:id/discussions/:commentId
```
Edit a comment (24-hour window, author only).

Body:
```json
{
  "content": "Updated comment content",
  "authorId": "user-1"
}
```

```http
DELETE /api/tasks/:id/discussions/:commentId
```
Soft delete a comment (author only).

Body:
```json
{
  "authorId": "user-1"
}
```

```http
POST /api/tasks/:id/discussions/mark-read
```
Mark comments as read for a user.

Body:
```json
{
  "userId": "user-1",
  "lastReadCommentId": "comment-789"
}
```

```http
GET /api/tasks/:id/discussions/unread
```
Get unread comment count for a user.

Query params:
- `userId`: User ID to check for unread comments

Response:
```json
{
  "unreadCount": 3
}
```

### Comment Structure

```typescript
interface TaskComment {
  id: string;                    // Unique comment identifier
  taskId: string;                // Associated task ID
  parentId?: string;            // Parent comment ID (for replies)
  content: string;               // Comment content
  authorType: "human" | "arm" | "brain";  // Who created the comment
  authorId: string;              // Author identifier
  authorName?: string;           // Display name for author
  client: "web" | "mail" | "mcp" | "cli"; // How the comment was created
  edited: boolean;                // Whether comment was edited
  deleted: boolean;              // Whether comment was soft-deleted
  createdAt: string;             // ISO timestamp
  updatedAt: string;             // ISO timestamp
}
```

### Threaded Discussions

Comments can be organized in a threaded structure where replies are nested under parent comments. The API supports both flat and threaded views of discussions.

### Comment Lifecycle

1. **Creation**: Comments are created with content, author information, and optional parent ID for replies
2. **Editing**: Authors can edit their comments within a 24-hour window
3. **Soft Deletion**: Comments can be deleted by their author but are soft-deleted to preserve context
4. **Read Tracking**: Users can mark comments as read for notification purposes

### Comment Metadata

Comments track additional metadata for better collaboration:
- **Author Information**: Type (human/arm/brain), ID, and display name
- **Client Context**: How the comment was created (web UI, email, MCP tool, CLI)
- **Edit History**: Whether the comment was edited and when
- **Deletion Status**: Soft deletion preserves context while hiding content

---

### Task Discussions

```http
GET /api/tasks/:id/discussions
```
List all comments for a task.

Query params:
- `limit`: max results (default 50)
- `offset`: pagination offset
- `threaded`: "true" to return comments in a nested tree structure.

```http
POST /api/tasks/:id/discussions
```
Add a new comment.

```json
{
  "content": "This task is blocked by PR-456",
  "parentId": "comment-789",
  "authorType": "human",
  "authorId": "user-1",
  "authorName": "Tim",
  "client": "web"
}
```

```http
PATCH /api/tasks/:id/discussions/:commentId
```
Edit a comment (24-hour window, author only).

```http
DELETE /api/tasks/:id/discussions/:commentId
```
Soft delete a comment (author only).

```http
POST /api/tasks/:id/discussions/mark-read
```
Mark comments as read for a user.

```json
{
  "userId": "user-1",
  "lastReadCommentId": "comment-789"
}
```

```http
GET /api/tasks/:id/discussions/unread
```
Get unread comment count for a user.

---

### Garden

```http
GET /api/garden
```
Get full garden topology (3D coordinates for all files).

```json
{
  "nodes": [
    {
      "path": "src/components/Button.tsx",
      "type": "file",
      "coords": { "x": 15, "y": 45, "z": 30 },
      "owner": "ui-arm",
      "lastTouchedBy": "ui-arm",
      "lastTouchedAt": "2024-01-15T10:30:00Z",
      "conflictZone": false
    }
  ]
}
```

```http
GET /api/garden/tree
```
Get file tree with ownership markers.

```http
GET /api/garden/claims
```
Get all active file claims.

```http
GET /api/garden/conflicts
```
Get current conflict zones.

```http
GET /api/garden/activity
```
Get recent file touch activity.

```json
{
  "activity": [
    {
      "path": "src/api/users.ts",
      "armId": "api-arm",
      "action": "write",
      "timestamp": "2024-01-15T10:30:00Z"
    }
  ]
}
```

---

### Proposals

```http
GET /api/proposals
```
List proposals with optional filters.

Query params:
- `status`: "open" | "accepted" | "rejected" | "all"
- `type`: Proposal type
- `author`: Arm ID

```http
POST /api/proposals
```
Create a new proposal (usually done by arms, but can be human-initiated).

```http
GET /api/proposals/:id
```
Get proposal details including arguments and signals.

```http
POST /api/proposals/:id/argue
```
Add an argument to a proposal.

```json
{
  "position": "for",
  "content": "This change improves performance by 40%",
  "evidence": ["benchmark-results.json"]
}
```

```http
POST /api/proposals/:id/signal
```
Add a signal (support/opposition).

```json
{
  "weight": 75,
  "reason": "Looks good, tests pass"
}
```

```http
POST /api/proposals/:id/resolve
```
Human resolves an undecided proposal.

```json
{
  "decision": "accept",
  "reason": "Approving despite mixed signals"
}
```

---

### Approvals

```http
GET /api/approvals
```
List pending human approvals.

```http
POST /api/approvals/:id/approve
```
Approve a pending request.

```http
POST /api/approvals/:id/reject
```
Reject a pending request.

```json
{
  "reason": "Not ready for production yet"
}
```

---

### Deployments

```http
GET /api/deployments
```
Get deployment history.

```http
POST /api/deployments
```
Request a deployment.

```json
{
  "environment": "staging",
  "ref": "main",
  "reason": "Weekly release"
}
```

```http
GET /api/deployments/:id
```
Get deployment status.

---

### Notifications

```http
POST /api/notifications/subscribe
```
Subscribe to push notifications.

```json
{
  "endpoint": "https://fcm.googleapis.com/...",
  "keys": {
    "p256dh": "...",
    "auth": "..."
  }
}
```

```http
DELETE /api/notifications/subscribe
```
Unsubscribe from push notifications.

```http
GET /api/notifications/vapid
```
Get VAPID public key for push subscription.

---

### Config

```http
GET /api/config
```
Get system configuration.

```http
PATCH /api/config
```
Update system configuration.

---

## WebSocket

Connect to `/ws` for real-time updates.

### Client → Server Messages

```typescript
// Subscribe to channels
{
  "type": "subscribe",
  "channels": ["arms", "garden", "proposals"]
}

// Unsubscribe
{
  "type": "unsubscribe", 
  "channels": ["garden"]
}
```

### Server → Client Messages

```typescript
{
  "channel": "arms",
  "event": "arm.status",
  "data": {
    "armId": "ui-arm",
    "status": "working",
    "task": "Implementing dark mode toggle"
  },
  "timestamp": "2024-01-15T10:30:00Z"
}
```

### Channels

| Channel | Events |
|---------|--------|
| `arms` | `arm.spawned`, `arm.status`, `arm.activity`, `arm.killed`, `arm.paused` |
| `garden` | `garden.claim`, `garden.touch`, `garden.conflict`, `garden.release` |
| `proposals` | `proposal.new`, `proposal.argue`, `proposal.signal`, `proposal.resolved` |
| `activity` | All events (firehose) |
| `approvals` | `approval.new`, `approval.resolved` |
| `deploy` | `deploy.requested`, `deploy.consensus`, `deploy.started`, `deploy.completed`, `deploy.failed` |

---

## Push Notifications

Using the Web Push API with VAPID for browser push notifications.

### Payload Structure

```typescript
interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  tag?: string;           // For replacing/grouping
  data?: {
    url?: string;         // URL to open on click
    proposalId?: string;
    approvalId?: string;
  };
}
```

### Push Triggers

| Event | Priority | Payload |
|-------|----------|---------|
| Human approval needed | High | Link to approval page |
| Deployment to prod ready | High | Link to deployment |
| Arm misbehavior detected | High | Link to arm details |
| Proposal stalled | Medium | Link to proposal |
| Deployment completed | Low | Status summary |

### Example Push

```json
{
  "title": "Approval Needed",
  "body": "Deploy to production requires your approval",
  "icon": "/icons/coleo.png",
  "tag": "approval-123",
  "data": {
    "url": "/approvals/123",
    "approvalId": "123"
  }
}
```

---

## Error Responses

All errors follow this format:

```json
{
  "error": {
    "code": "ARM_NOT_FOUND",
    "message": "Arm with ID 'xyz' not found",
    "details": {}
  }
}
```

### Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `UNAUTHORIZED` | 401 | Invalid or missing API key |
| `FORBIDDEN` | 403 | Action not permitted |
| `NOT_FOUND` | 404 | Resource not found |
| `CONFLICT` | 409 | Resource state conflict |
| `VALIDATION_ERROR` | 422 | Invalid request body |
| `INTERNAL_ERROR` | 500 | Server error |

---

## Rate Limiting

| Endpoint | Limit |
|----------|-------|
| `/api/*` | 100 requests/minute |
| `/ws` | 1 connection per client |
| Push notifications | 10/minute per subscription |
