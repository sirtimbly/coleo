# Task: CLI Commands, REST API, and Unit Tests for Task Discussions

## Overview
You are building the CLI interface and REST API for task discussions. This is the SECOND task (after database migration) and provides the foundation that the Web UI and Brain/MCP tasks will consume.

## Prerequisites

**MUST BE COMPLETED FIRST**: Database migration task (task-discussions-db-migration.md)

This task depends on:
- `task_comments` table exists
- `task_comment_reads` table exists
- `mail_thread_map` table exists
- Database helper functions in `src/db/state.ts`
- TypeScript types in `src/types/index.ts`

## What You're Building

### 1. REST API Endpoints

Create a new file: `src/api/routes/task-discussions.ts`

These endpoints will be mounted at `/api/tasks/:id/discussions`:

```typescript
// GET /api/tasks/:id/discussions
// List all discussions for a task
// Query params:
//   - limit: max results (default 50)
//   - offset: pagination offset (default 0)
//   - threaded: if "true", return nested replies structure
// Response:
interface ListDiscussionsResponse {
  discussions: TaskComment[];
  totalCount: number;
}

// POST /api/tasks/:id/discussions
// Add a new comment to a task
// Body:
interface CreateDiscussionRequest {
  content: string;
  parentId?: string; // for replies
  authorType: 'human' | 'arm' | 'brain';
  authorId: string;
  authorName?: string;
  client: 'web' | 'mail' | 'mcp' | 'cli';
}
// Response: { comment: TaskComment }

// PATCH /api/tasks/:id/discussions/:commentId
// Edit a comment (only original author, within 24h)
// Body: { content: string }
// Response: { comment: TaskComment }

// DELETE /api/tasks/:id/discussions/:commentId
// Soft delete a comment (only original author)
// Response: { deleted: true }

// POST /api/tasks/:id/discussions/mark-read
// Mark discussions as read for a human user
// Body: { lastReadCommentId: string }
// Response: { marked: true }

// GET /api/tasks/:id/discussions/unread
// Get unread count for current user
// Response: { unreadCount: number }
```

**WebSocket Events** (broadcast via existing `broadcast()` function):
- `discussion.created` - when a new comment is added
- `discussion.updated` - when a comment is edited
- `discussion.deleted` - when a comment is soft-deleted

### 2. Mount the Routes

Update `src/api/index.ts` to mount the new routes:

```typescript
import { createTaskDiscussionsRoutes } from "./routes/task-discussions";

// In the app setup:
app.route("/api/tasks/:id/discussions", createTaskDiscussionsRoutes());
```

### 3. Update Existing Task Routes

Update `src/api/routes/tasks.ts`:

1. **Include comment count in task list**: When fetching tasks, join with comment count
2. **Include discussions in single task fetch**: Add `?include=discussions` query param to GET /api/tasks/:id

### 4. CLI Commands

Update `src/cli/commands/tasks.ts` to add:

```typescript
// octopai tasks discuss <task-id> <message>
// Add a comment to a task discussion
tasksCmd
  .command("discuss <taskId> <message>")
  .description("Add a comment to a task discussion")
  .option("-r, --reply-to <commentId>", "Reply to a specific comment")
  .action(async (taskId, message, options) => {
    // Call POST /api/tasks/:id/discussions
    // authorType: 'human'
    // authorId: get from git config user.email or env
    // client: 'cli'
  });

// octopai tasks discussions <task-id>
// List discussions for a task
tasksCmd
  .command("discussions <taskId>")
  .description("Show task discussions")
  .option("-n, --limit <n>", "Number of comments to show", "20")
  .option("--json", "Output as JSON")
  .action(async (taskId, options) => {
    // Call GET /api/tasks/:id/discussions
    // Format as readable table or JSON
  });
```

### 5. Unit Tests

Create: `src/api/__tests__/task-discussions.test.ts`

Test coverage required:

```typescript
describe("Task Discussions API", () => {
  // Setup: Create in-memory SQLite DB with required tables
  
  describe("GET /api/tasks/:id/discussions", () => {
    it("should return empty array for task with no discussions", async () => {
      // Test
    });
    
    it("should return discussions ordered by created_at DESC", async () => {
      // Create 3 comments, verify order
    });
    
    it("should respect limit and offset", async () => {
      // Create 5 comments, test pagination
    });
    
    it("should return threaded structure when threaded=true", async () => {
      // Create parent + 2 replies, verify nesting
    });
  });
  
  describe("POST /api/tasks/:id/discussions", () => {
    it("should create a new comment", async () => {
      // Test creation
    });
    
    it("should update task comment_count and last_comment_at", async () => {
      // Verify task stats updated
    });
    
    it("should broadcast discussion.created event", async () => {
      // Verify WebSocket broadcast
    });
    
    it("should reject empty content", async () => {
      // Test validation
    });
    
    it("should support replies with parentId", async () => {
      // Test threading
    });
  });
  
  describe("PATCH /api/tasks/:id/discussions/:commentId", () => {
    it("should update comment content", async () => {
      // Test edit
    });
    
    it("should set edited flag to true", async () => {
      // Verify edited column
    });
    
    it("should reject edit after 24 hours", async () => {
      // Test time window
    });
    
    it("should reject edit by non-author", async () => {
      // Test authorization
    });
  });
  
  describe("DELETE /api/tasks/:id/discussions/:commentId", () => {
    it("should soft delete comment", async () => {
      // Verify deleted flag set, not actually removed
    });
    
    it("should reject delete by non-author", async () => {
      // Test authorization
    });
  });
  
  describe("POST /api/tasks/:id/discussions/mark-read", () => {
    it("should create read receipt", async () => {
      // Test mark read
    });
    
    it("should update existing read receipt", async () => {
      // Test update
    });
  });
});
```

## Implementation Details

### Route Handler Pattern

Follow the exact pattern in `src/api/routes/tasks.ts`:

```typescript
export function createTaskDiscussionsRoutes() {
  const app = new Hono<{ Variables: { db: Database } }>();
  
  app.get("/", (c) => {
    const db = c.get("db");
    const taskId = c.req.param("id");
    // ... implementation
  });
  
  app.post("/", async (c) => {
    const db = c.get("db");
    const taskId = c.req.param("id");
    const body = await c.req.json();
    // ... implementation
  });
  
  return app;
}
```

### Database Helper Usage

Use the helper functions from `src/db/state.ts`:

```typescript
import { 
  createTaskComment, 
  getTaskComments, 
  updateTaskComment,
  deleteTaskComment,
  updateTaskCommentStats,
  markTaskCommentsRead,
  getUnreadCommentCount
} from "../../db/state";
```

### WebSocket Broadcasting

Use the existing `broadcast` function:

```typescript
import { broadcast } from "../websocket";

// After creating a comment:
broadcast("tasks", "discussion.created", { 
  taskId, 
  commentId: comment.id,
  authorType: comment.authorType 
});
```

### ID Generation

Use the existing pattern:

```typescript
const id = `comment-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
```

### Error Handling

Use the existing `HttpError` class:

```typescript
import { HttpError } from "../middleware";

// For not found:
throw HttpError.notFound(`Task not found: ${taskId}`);

// For bad request:
throw HttpError.badRequest("Content is required");

// For forbidden:
throw HttpError.forbidden("Cannot edit comment after 24 hours");
```

### Date Handling

Always use ISO strings:

```typescript
const now = new Date().toISOString();
```

## Critical Requirements

1. **Authorization**: Only original author can edit/delete their comments
2. **Time limits**: Comments can only be edited within 24 hours of creation
3. **Soft deletes**: Set `deleted = 1`, don't actually delete rows
4. **Stats updates**: Always update `tasks.comment_count` and `tasks.last_comment_at` when adding/deleting comments
5. **Validation**: Reject empty content, validate author_type is one of allowed values
6. **Threading**: Support `parent_id` for replies, validate parent exists and belongs to same task

## Testing Requirements

1. **In-memory database**: Use `:memory:` SQLite database for tests
2. **Setup/teardown**: Create fresh DB for each test, clean up after
3. **Test all endpoints**: Every route must have tests
4. **Test edge cases**: Empty content, invalid IDs, authorization failures
5. **Test WebSocket**: Verify broadcast function is called with correct events

## Files to Create/Modify

**Create:**
1. `src/api/routes/task-discussions.ts` - Main route handlers
2. `src/api/__tests__/task-discussions.test.ts` - Unit tests

**Modify:**
1. `src/api/index.ts` - Mount new routes
2. `src/api/routes/tasks.ts` - Include comment counts
3. `src/cli/commands/tasks.ts` - Add CLI commands

## Success Criteria

- [ ] All API endpoints work correctly
- [ ] CLI commands work: `octopai tasks discuss`, `octopai tasks discussions`
- [ ] Unit tests pass: `bun test src/api/__tests__/task-discussions.test.ts`
- [ ] WebSocket events are broadcast
- [ ] Task stats (comment_count, last_comment_at) are updated
- [ ] Authorization rules enforced (only author can edit/delete)
- [ ] Time limits enforced (24h edit window)
- [ ] `bun run typecheck` passes

## Integration Notes

After this task is complete, the following will be possible:

1. **Web Task** will call these endpoints to show discussions in the UI
2. **Brain/MCP Task** will call these endpoints from MCP tools
3. **Humans** can use CLI to participate in discussions
4. **Web UI** will receive real-time updates via WebSocket

Make sure the API is clean and well-documented - it's the contract between all other components!
