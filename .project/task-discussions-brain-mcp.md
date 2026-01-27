# Task: Brain Integration and MCP Tools for Task Discussions

## Overview
You are integrating task discussions into the Brain and MCP server. This is the FOURTH task (after database migration, CLI/API, and Web UI). You will enable agents to participate in task discussions via MCP tools and handle mail-based discussions.

## Prerequisites

**MUST BE COMPLETED FIRST**:
1. Database migration task (task-discussions-db-migration.md)
2. CLI/API task (task-discussions-cli-api.md)
3. Web UI task (task-discussions-web-ui.md) - optional but helpful for testing

This task depends on:
- `task_comments` table exists
- REST API endpoints at `/api/tasks/:id/discussions`
- TypeScript types in `src/types/index.ts`
- Database helper functions in `src/db/state.ts`

## What You're Building

### 1. MCP Tools for Task Discussions

Add two new tools to `src/mcp/server.ts`:

#### Tool 1: `add_task_discussion`

```typescript
server.registerTool(
  "add_task_discussion",
  {
    description: "Add a comment or update to a task discussion. Use this to share progress, ask questions, provide context, or collaborate with humans and other arms on a task.",
    inputSchema: {
      taskId: z.string().describe("ID of the task to comment on (e.g., 'task-abc123')"),
      content: z.string().describe("The discussion content. Markdown is supported. Be concise but informative."),
      parentId: z.string().optional().describe("ID of the comment you're replying to (for threading). Leave empty for top-level comments."),
      type: z.enum(["update", "question", "decision", "blocker", "note", "completion"]).describe(
        "Type of discussion: update=progress report, question=need input, decision=made a choice, blocker=need help, note=general info, completion=task done"
      ),
    },
  },
  async ({ taskId, content, parentId, type }) => {
    // 1. Validate task exists
    const database = getDatabase();
    const task = database.query("SELECT id, subject, assigned_to FROM tasks WHERE id = ?").get(taskId) as 
      { id: string; subject: string; assigned_to: string | null } | null;
    
    if (!task) {
      return {
        content: [{ type: "text" as const, text: `Task ${taskId} not found` }],
        isError: true,
      };
    }

    // 2. Create the comment via API call or direct DB insert
    // Use the API endpoint: POST /api/tasks/:id/discussions
    // Or use database helper: createTaskComment()
    
    // 3. Return success with context
    return {
      content: [{
        type: "text" as const,
        text: `Added ${type} to task "${task.subject}" (${taskId}).\n\n${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`,
      }],
    };
  }
);
```

#### Tool 2: `get_task_discussions`

```typescript
server.registerTool(
  "get_task_discussions",
  {
    description: "Get recent discussions on a task to understand context, previous decisions, and current status. Call this when starting work on a task or when you need context.",
    inputSchema: {
      taskId: z.string().describe("ID of the task to get discussions for"),
      limit: z.number().optional().default(10).describe("Number of recent comments to retrieve (default: 10)"),
      includeReplies: z.boolean().optional().default(true).describe("Whether to include threaded replies (default: true)"),
    },
  },
  async ({ taskId, limit, includeReplies }) => {
    // 1. Validate task exists
    const database = getDatabase();
    const task = database.query("SELECT id, subject FROM tasks WHERE id = ?").get(taskId) as
      { id: string; subject: string } | null;
    
    if (!task) {
      return {
        content: [{ type: "text" as const, text: `Task ${taskId} not found` }],
        isError: true,
      };
    }

    // 2. Fetch discussions
    // Use API endpoint: GET /api/tasks/:id/discussions?limit=X&threaded=true
    // Or use database helper: getTaskComments()
    
    // 3. Format for agent consumption
    const formatted = formatDiscussionsForAgent(discussions);
    
    return {
      content: [{
        type: "text" as const,
        text: `Discussions for task "${task.subject}" (${taskId}):\n\n${formatted}`,
      }],
    };
  }
);
```

### 2. Helper Function for Formatting

Add to `src/mcp/server.ts`:

```typescript
function formatDiscussionsForAgent(comments: TaskComment[]): string {
  if (comments.length === 0) {
    return "No discussions yet.";
  }
  
  return comments.map(comment => {
    const author = comment.authorType === 'arm' 
      ? `Arm ${comment.authorId}` 
      : comment.authorType === 'human'
        ? `Human (${comment.authorName || comment.authorId})`
        : 'Brain';
    
    const time = new Date(comment.createdAt).toLocaleString();
    const prefix = comment.parentId ? '  ↳ ' : ''; // Indent replies
    
    return `${prefix}[${time}] ${author}:\n${prefix}${comment.content.split('\n').join('\n' + prefix)}`;
  }).join('\n\n');
}
```

### 3. Brain Mail Integration

Update `src/brain/brain.ts` to handle mail replies as task discussions:

#### Add New Intent Type

In the `MailProcessor` class, add a new intent type:

```typescript
// In the system prompt for mail processing:
8. **task_discussion** - Human is replying to a task notification or adding a comment to an existing task
   USE THIS when:
   - The subject contains a task ID (e.g., "[octopai] Task task-abc123...")
   - The In-Reply-To header references a task notification email
   - The human explicitly mentions "task-xxx" in the subject or body
   - The human is providing feedback, asking questions, or discussing a specific task
```

#### Handle task_discussion Intent

In the brain's message processing (around line 884 in brain.ts):

```typescript
case "task_discussion": {
  // Extract task ID from intent or parse from subject
  const taskId = intent.taskId || extractTaskIdFromSubject(message.subject);
  
  if (!taskId) {
    await this.sendToHuman({
      subject: `[octopai] Could not add comment`,
      body: `I couldn't determine which task you're commenting on. Please include the task ID in your subject (e.g., "Re: [octopai] Task task-abc123...") or reply to a task notification email.`,
      inReplyTo: message.id,
    });
    return;
  }
  
  // Verify task exists
  const task = await this.getTask(taskId);
  if (!task) {
    await this.sendToHuman({
      subject: `[octopai] Task not found`,
      body: `Task ${taskId} was not found. It may have been deleted or the ID may be incorrect.`,
      inReplyTo: message.id,
    });
    return;
  }
  
  // Add as discussion comment
  await this.addTaskDiscussion(taskId, {
    content: message.body,
    authorType: "human",
    authorId: message.from,
    authorName: message.fromName,
    mailRef: message.id,
    client: "mail",
  });
  
  // Store mail thread mapping for future replies
  await this.storeMailThreadMap({
    mailMessageId: message.id,
    mailThreadId: message.threadId,
    taskId,
  });
  
  // Notify assigned arm if any
  if (task.assignedTo) {
    await this.notifyArmOfDiscussion(task.assignedTo, taskId, message.from);
  }
  
  // Send confirmation to human (optional, can be silent)
  // await this.sendToHuman({
  //   subject: `[octopai] Comment added to ${task.subject}`,
  //   body: `Your comment has been added to the task discussion.`,
  //   inReplyTo: message.id,
  // });
  
  break;
}
```

#### Helper Methods

Add to `Brain` class:

```typescript
/**
 * Extract task ID from email subject
 * Patterns: "task-abc123", "[task-abc123]", "Task task-abc123"
 */
private extractTaskIdFromSubject(subject: string): string | null {
  // Pattern 1: task-xxx anywhere in subject
  const match1 = subject.match(/task-[a-z0-9]+/i);
  if (match1) return match1[0];
  
  // Pattern 2: [octopai] Task task-xxx...
  const match2 = subject.match(/Task (task-[a-z0-9]+)/i);
  if (match2) return match2[1];
  
  return null;
}

/**
 * Add a discussion comment to a task
 */
private async addTaskDiscussion(
  taskId: string,
  comment: Omit<TaskComment, 'id' | 'createdAt' | 'updatedAt'>
): Promise<TaskComment> {
  // Use database helper to create comment
  const id = `comment-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  
  createTaskComment(this.db!, {
    id,
    taskId,
    ...comment,
    createdAt: now,
    updatedAt: now,
  });
  
  // Update task stats
  updateTaskCommentStats(this.db!, taskId);
  
  // Broadcast WebSocket event
  broadcast("tasks", "discussion.created", {
    taskId,
    commentId: id,
    authorType: comment.authorType,
  });
  
  this.log(`Added discussion comment to ${taskId} from ${comment.authorType}:${comment.authorId}`);
  
  return {
    id,
    taskId,
    ...comment,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  } as TaskComment;
}

/**
 * Store mail thread mapping for reply detection
 */
private async storeMailThreadMap(mapping: {
  mailMessageId: string;
  mailThreadId?: string;
  taskId: string;
}): Promise<void> {
  storeMailThreadMap(this.db!, {
    ...mapping,
    createdAt: new Date().toISOString(),
  });
}

/**
 * Notify an arm that a human added a discussion comment
 */
private async notifyArmOfDiscussion(
  armId: string,
  taskId: string,
  humanEmail: string
): Promise<void> {
  // Send message to arm via NATS or queue
  await this.sendToArm(armId, {
    type: "task_discussion_notification",
    payload: {
      taskId,
      humanEmail,
      message: `Human ${humanEmail} added a comment to task ${taskId}`,
    },
  });
}
```

### 4. Mail Thread Detection

Enhance mail processing to detect replies to task notifications:

```typescript
// In the mail processing loop, before intent detection:

// Check if this is a reply to a task notification
if (message.inReplyTo) {
  const mapping = getMailThreadMap(this.db!, message.inReplyTo);
  if (mapping) {
    // This is a reply to a task email - treat as task discussion
    await this.addTaskDiscussion(mapping.taskId, {
      content: message.body,
      authorType: "human",
      authorId: message.from,
      authorName: message.fromName,
      mailRef: message.id,
      client: "mail",
    });
    return; // Skip normal intent processing
  }
}
```

### 5. Update Brain Message Types

Add to `src/types/index.ts`:

```typescript
// Extend QueueMessage type
type QueueMessageType = 
  | "claim_task"
  | "complete_task"
  | "discovery"
  | "share_note"
  | "tool_discovery"
  | "heartbeat"
  | "doc_update"
  | "file_subscription"
  | "file_change"
  | "bug_report"
  | "status_report"
  | "request_approval"
  | "approval_response"
  | "prompt_response"
  | "task_discussion_added" // NEW
  | "task_discussion_request"; // NEW

// Task discussion message payload
export interface TaskDiscussionAddedMessage {
  type: "task_discussion_added";
  payload: {
    taskId: string;
    discussionId: string;
    armId: string;
    content: string;
  };
}
```

### 6. Brain Prompt Integration

Update arm prompts to encourage discussion usage:

In `src/brain/prompt-generator.ts` or arm prompts:

```markdown
## Task Discussion Guidelines

Use the task discussion feature to collaborate effectively:

1. **When starting a task**: Read existing discussions first using `get_task_discussions`
2. **Progress updates**: Share progress every 30 minutes using `add_task_discussion` with type="update"
3. **Questions**: Ask humans for clarification using type="question"
4. **Decisions**: Document important decisions using type="decision"
5. **Blockers**: Report blockers immediately using type="blocker"
6. **Completion**: Mark completion with type="completion" and summary

This keeps humans informed and creates a record of the work.
```

## Implementation Details

### API vs Direct DB Access

You can choose to:
1. **Call REST API** from MCP tools (more decoupled, requires HTTP client)
2. **Use DB helpers directly** (faster, but couples to DB schema)

For MCP tools, direct DB access is fine since they're server-side:
```typescript
import { createTaskComment, getTaskComments } from "../db/state";
```

### Error Handling

Always return user-friendly errors:
```typescript
return {
  content: [{ 
    type: "text" as const, 
    text: `Error: Task ${taskId} not found. Please verify the task ID.` 
  }],
  isError: true,
};
```

### Logging

Use the existing logActivity function:
```typescript
logActivity(ARM_ID, "add_task_discussion", taskId, { 
  commentId: id, 
  type 
});
```

## Files to Create/Modify

**Modify:**
1. `src/mcp/server.ts` - Add MCP tools
2. `src/brain/brain.ts` - Add mail handling and helper methods
3. `src/types/index.ts` - Add message types
4. `src/brain/prompt-generator.ts` - Add discussion guidelines to prompts

## Success Criteria

- [ ] MCP tool `add_task_discussion` works from agent CLI
- [ ] MCP tool `get_task_discussions` returns formatted discussions
- [ ] Mail replies to task notifications are added as discussions
- [ ] Brain correctly extracts task IDs from email subjects
- [ ] Assigned arms are notified of new human comments
- [ ] WebSocket events are broadcast when agents add discussions
- [ ] Task stats (comment_count) are updated
- [ ] `bun run typecheck` passes

## Testing

1. **Test MCP tools**:
   ```bash
   # Start an arm and test the tools
   octopai arm spawn test-arm
   # Use the MCP tools interactively
   ```

2. **Test mail integration**:
   - Send task notification email
   - Reply to it
   - Verify comment appears in task

3. **Test WebSocket**:
   - Open Web UI
   - Add discussion via MCP
   - Verify UI updates in real-time

## Integration Notes

After this task:
- **Agents** can participate in task discussions via MCP tools
- **Humans** can reply to task emails and comments are captured
- **Brain** routes mail discussions to the correct tasks
- **Real-time updates** flow through WebSocket to Web UI

This completes the task discussions feature - all three interfaces (Mail, Web, MCP) are now connected!
