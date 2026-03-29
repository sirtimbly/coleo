# Task Deletion Workflow

This document describes the workflow for handling task deletion events between the API and Brain, including project plan cleanup and event propagation.

## Overview

When a user deletes a task, the system must ensure that:
1. The task is removed from the database
2. The associated feature is removed from project plan files
3. Other system components are notified of the deletion
4. The process is idempotent and handles failures gracefully

## Architecture

```
┌─────────────┐     DELETE /api/tasks/:id     ┌─────────────┐
│   Client    │ ───────────────────────────▶  │  API Server  │
└─────────────┘                               └──────┬──────┘
                                                     │
                     ┌─────────────────────────────┼─────────────────────────────┐
                     │                             │                             │
                     ▼                             ▼                             ▼
            ┌─────────────────┐          ┌─────────────────┐          ┌─────────────────┐
            │  Remove from    │          │  Delete from    │          │  Queue Brain    │
            │  plan.md        │          │  Database       │          │  Message        │
            └────────┬────────┘          └─────────────────┘          └────────┬────────┘
                     │                                                         │
                     │                                                         ▼
                     │                                               ┌─────────────────┐
                     │                                               │  Brain Message  │
                     │                                               │  Queue          │
                     │                                               └────────┬────────┘
                     │                                                        │
                     └────────────────────────────────────────────────────────┼──────────┐
                                                                              │          │
                                                                              ▼          ▼
                                                                     ┌─────────────────┐
                                                                     │  Brain Handler  │
                                                                     │  (task_deleted) │
                                                                     └────────┬────────┘
                                                                              │
                                                     ┌────────────────────────┼────────────────────────┐
                                                     │                        │                        │
                                                     ▼                        ▼                        ▼
                                            ┌─────────────┐         ┌─────────────────┐      ┌─────────────────┐
                                            │ Verify/Cleanup│       │  Log Activity   │      │ Publish Event   │
                                            │  plan.md      │       │                 │      │                 │
                                            └─────────────┘         └─────────────────┘      └─────────────────┘
```

## Event Schema

### task_deleted Message

When a task is deleted, the API sends a message to the Brain with the following payload:

```typescript
interface TaskDeletedPayload {
  /** The ID of the deleted task */
  taskId: string;
  
  /** Reference to the project/plan file (source_ref) */
  projectId: string;
  
  /** The unique identifier of the feature in plan.md (plan_line_uid) */
  featureId: string;
  
  /** Who initiated the deletion ("user", "api", etc.) */
  deletedBy: string;
  
  /** ISO timestamp of when the deletion occurred */
  timestamp: string;
}
```

Example payload:
```json
{
  "taskId": "task-abc123",
  "projectId": "/path/to/.project/plan.md:42",
  "featureId": "octopai:feature123",
  "deletedBy": "user",
  "timestamp": "2026-03-29T15:09:28.533Z"
}
```

## API Flow

### 1. Task Deletion Endpoint

The `DELETE /api/tasks/:id` endpoint handles task deletion:

1. **Lookup Task**: Fetches the task to get its `plan_line_uid` and `source_ref`
2. **Remove from Plan**: If the task has a `plan_line_uid`, calls `removeTaskLineFromPlan()` to remove the feature from the plan file
3. **Delete from Database**: Removes the task record from SQLite
4. **Queue Brain Message**: Creates a `task_deleted` message and queues it for the Brain
5. **Broadcast Event**: Emits a WebSocket event for real-time UI updates

```typescript
// src/api/routes/tasks.ts
app.delete("/:id", async (c) => {
  // 1. Get task details
  const taskRow = db.query("SELECT ...").get(id);
  
  // 2. Remove from plan.md if applicable
  if (taskRow.plan_line_uid && taskRow.source_ref) {
    const removedFromPlan = await removeTaskLineFromPlan(
      planFilePath, 
      taskRow.plan_line_uid
    );
  }
  
  // 3. Delete from database
  db.run("DELETE FROM tasks WHERE id = ?", [id]);
  
  // 4. Queue message for Brain
  queueMessage(db, {
    type: "task_deleted",
    payload: { taskId: id, projectId, featureId, deletedBy, timestamp }
  });
  
  // 5. Broadcast event
  broadcast("tasks", "task.deleted", { taskId: id, removedFromPlan });
});
```

## Brain Flow

### 1. Message Reception

The Brain receives `task_deleted` messages through the standard message handling pipeline:

```typescript
// src/brain/brain.ts
private async handleArmMessage(message: QueueMessage): Promise<void> {
  switch (message.type) {
    case "task_deleted": {
      const payload = message.payload as TaskDeletedPayload;
      await this.handleTaskDeletion(payload);
      break;
    }
    // ... other cases
  }
}
```

### 2. Deletion Handler

The Brain's deletion handler performs three main operations:

#### a. Idempotent Plan Cleanup

Even though the API attempts to remove the feature from plan files, the Brain verifies this and performs cleanup if needed:

```typescript
private async verifyAndCleanupPlanFeature(
  projectId: string,
  featureId: string
): Promise<boolean> {
  // Parse projectId to get file path
  // (handles both "path:line" format and direct paths)
  
  // Attempt to remove the line by UID
  const removed = await removeTaskLineFromPlan(planFilePath, featureId);
  
  return removed; // true if cleanup was performed, false if already absent
}
```

This is **idempotent**: calling it multiple times for the same deleted task is safe.

#### b. Activity Logging

The handler logs the deletion for observability:

```typescript
this.logActivity("brain", "task_deleted", taskId, {
  projectId,
  featureId,
  deletedBy,
  timestamp,
  planCleanupNeeded: cleanupPerformed,
});
```

#### c. Event Publication

The deletion is published as a system event for other consumers:

```typescript
await this.publishEventViaApi({
  subject: `coleo.events.task.${taskId}.deleted`,
  type: "task.deleted",
  data: { taskId, projectId, featureId, deletedBy, timestamp, planCleaned }
});
```

### 3. Error Handling

The handler is designed to be resilient:

- **Plan file not found**: Logs warning, continues
- **Feature already absent**: Returns successfully (idempotent)
- **Event publishing fails**: Logs error, does not fail the operation
- **Any other error**: Caught and logged, operation continues

```typescript
private async handleTaskDeletion(payload: TaskDeletedPayload): Promise<void> {
  try {
    // ... perform cleanup, logging, event publishing
  } catch (err) {
    // Log error but don't throw - deletion notification should not fail
    this.log(`Error processing task deletion: ${err}`);
    this.logActivity("brain", "task_deletion_failed", taskId, { error: err });
  }
}
```

## Plan File Format

Tasks in plan files are marked with unique identifiers using HTML comments:

```markdown
## Phase 1: Foundation

### Deliverables

- [ ] Implement user authentication <!--octopai:abcd1234-->
- [ ] Add database schema for users <!--octopai:efgh5678-->
- [x] Set up project structure <!--octopai:ijkl9012-->
```

The `removeTaskLineFromPlan()` function:
1. Reads the plan file
2. Finds the line containing `<!--octopai:{featureId}-->`
3. Removes that line
4. Writes the updated content back

## Testing

### Unit Tests

Tests are located in `src/brain/__tests__/task-deletion-handler.test.ts`:

- **Handler Tests**: Verify message processing, activity logging, event publishing
- **Cleanup Tests**: Verify idempotent plan cleanup, file path parsing, error handling
- **Integration Tests**: Verify message routing through `handleArmMessage`

Run tests:
```bash
bun test src/brain/__tests__/task-deletion-handler.test.ts
```

### Manual Testing

1. Create a task from a plan.md file
2. Verify the task has a `plan_line_uid` in the database
3. Delete the task via API
4. Verify:
   - Task removed from database
   - Feature removed from plan.md
   - `task_deleted` message queued
   - Brain processes the message successfully
   - Activity logged
   - Event published

## Related Code

- **API Route**: `src/api/routes/tasks.ts` - DELETE endpoint
- **Brain Handler**: `src/brain/brain.ts` - `handleTaskDeletion()`, `verifyAndCleanupPlanFeature()`
- **Plan Parser**: `src/brain/plan-parser.ts` - `removeTaskLineFromPlan()`
- **Message Types**: `src/types/index.ts` - `MessageType` union, `QueueMessage`
- **Brain Inbox**: `src/types/brain-inbox.ts` - Payload validation

## Future Enhancements

1. **Reindexing**: Trigger search reindexing when tasks are deleted (if search is implemented)
2. **Retry Logic**: Add retry mechanism for failed plan cleanup attempts
3. **Batch Deletion**: Optimize for bulk task deletion scenarios
4. **Undo Support**: Consider adding soft-delete and restore capability
5. **Notifications**: Notify assigned arms when their tasks are deleted

---

*Last updated: 2026-03-29*
