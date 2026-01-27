# Task: Web UI for Task Discussions

## Overview
You are building the Web UI components for task discussions. This is the THIRD task (after database migration and CLI/API). You will consume the REST API endpoints built by the CLI/API task.

## Prerequisites

**MUST BE COMPLETED FIRST**:
1. Database migration task (task-discussions-db-migration.md)
2. CLI/API task (task-discussions-cli-api.md)

This task depends on:
- `task_comments` table exists with data
- REST API endpoints at `/api/tasks/:id/discussions`
- WebSocket events for real-time updates
- TypeScript types in `src/types/index.ts`

## What You're Building

### 1. API Client Extensions

Add discussion methods to `src/web/src/lib/api.ts`:

```typescript
// Add these methods to the ApiClient class

async getTaskDiscussions(
  taskId: string, 
  params?: { 
    limit?: number; 
    offset?: number;
    threaded?: boolean;
  }
) {
  const query = new URLSearchParams();
  if (params?.limit) query.set('limit', params.limit.toString());
  if (params?.offset) query.set('offset', params.offset.toString());
  if (params?.threaded) query.set('threaded', 'true');
  const queryStr = query.toString();
  return this.request<{
    discussions: TaskComment[];
    totalCount: number;
  }>(`/tasks/${taskId}/discussions${queryStr ? `?${queryStr}` : ''}`);
}

async createTaskDiscussion(
  taskId: string, 
  data: {
    content: string;
    parentId?: string;
    authorType: 'human' | 'arm' | 'brain';
    authorId: string;
    authorName?: string;
    client: 'web';
  }
) {
  return this.request<{ comment: TaskComment }>(`/tasks/${taskId}/discussions`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

async updateTaskDiscussion(
  taskId: string,
  commentId: string,
  data: { content: string }
) {
  return this.request<{ comment: TaskComment }>(`/tasks/${taskId}/discussions/${commentId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

async deleteTaskDiscussion(taskId: string, commentId: string) {
  return this.request<{ deleted: boolean }>(`/tasks/${taskId}/discussions/${commentId}`, {
    method: 'DELETE',
  });
}

async markTaskDiscussionsRead(taskId: string, lastReadCommentId: string) {
  return this.request<{ marked: boolean }>(`/tasks/${taskId}/discussions/mark-read`, {
    method: 'POST',
    body: JSON.stringify({ lastReadCommentId }),
  });
}

async getUnreadDiscussionCount(taskId: string) {
  return this.request<{ unreadCount: number }>(`/tasks/${taskId}/discussions/unread`);
}
```

### 2. Task Discussion Panel Component

Create: `src/web/src/components/TaskDiscussionPanel.tsx`

```typescript
interface TaskDiscussionPanelProps {
  taskId: string;
  className?: string;
}

// Features to implement:
// 1. Discussion list with threading support
// 2. Real-time updates via WebSocket
// 3. Markdown rendering for content
// 4. Author badges (Human, Arm, Brain)
// 5. Reply functionality
// 6. Edit/delete own comments (within 24h)
// 7. Unread indicators
// 8. Auto-scroll to new comments
// 9. Load more pagination
```

**Component Structure**:
```tsx
export function TaskDiscussionPanel({ taskId, className }: TaskDiscussionPanelProps) {
  // State:
  // - discussions: TaskComment[]
  // - isLoading: boolean
  // - hasMore: boolean
  // - replyTo: string | null (comment ID being replied to)
  // - editing: string | null (comment ID being edited)
  // - unreadCount: number
  
  // Effects:
  // - Fetch discussions on mount
  // - WebSocket listener for real-time updates
  // - Mark as read when viewing
  
  // Render:
  // - Header: "Discussions (N)" + unread badge
  // - Scrollable discussion list
  // - Composer input at bottom
}
```

### 3. Discussion Item Component

Create: `src/web/src/components/DiscussionItem.tsx`

```typescript
interface DiscussionItemProps {
  comment: TaskComment;
  depth?: number; // for indentation in threads
  onReply: (commentId: string) => void;
  onEdit: (comment: TaskComment) => void;
  onDelete: (commentId: string) => void;
  isUnread?: boolean;
}

// Features:
// - Author avatar/badge (Human=👤, Arm=🤖, Brain=🧠)
// - Timestamp with relative time (e.g., "2 hours ago")
// - Markdown content rendering
// - Reply button
// - Edit/Delete buttons (only for own comments, within 24h)
// - "Edited" indicator
// - Thread indentation (using margin-left based on depth)
// - Replies list (recursive)
```

### 4. Discussion Composer Component

Create: `src/web/src/components/DiscussionComposer.tsx`

```typescript
interface DiscussionComposerProps {
  taskId: string;
  replyTo?: { id: string; authorName: string } | null;
  onCancelReply?: () => void;
  onSubmit?: () => void;
}

// Features:
// - Textarea with auto-resize
// - Markdown preview toggle
// - Submit button (disabled if empty)
// - Cancel reply button (when replyTo is set)
// - Keyboard shortcut: Cmd/Ctrl + Enter to submit
// - Loading state during submission
```

### 5. Update Task Detail View

Modify existing task view to include discussions:

**Option A: Add to existing TaskModal**
Update `src/web/src/components/TaskModal.tsx`:
- Add tabs: "Details" | "Discussions" | "History"
- Discussions tab shows TaskDiscussionPanel

**Option B: Create new TaskDetailView**
Create `src/web/src/components/TaskDetailView.tsx`:
- Full-page view (not modal)
- Sidebar with task info
- Main area with discussion panel
- Better for complex discussions

Choose based on what works better for the UX.

### 6. WebSocket Integration

Update `src/web/src/hooks/useWebSocket.ts`:

Add handling for discussion events:
```typescript
// In the WebSocket message handler:
case 'discussion.created':
  // Add new comment to state if it's for current task
  break;
case 'discussion.updated':
  // Update existing comment in state
  break;
case 'discussion.deleted':
  // Remove or mark as deleted in state
  break;
```

### 7. Task List Updates

Update `src/web/src/components/TaskGrid.tsx` or `TaskGridRow.tsx`:

Show discussion indicators:
- Comment count badge on task rows
- Unread indicator (if user has unread comments)
- Last activity timestamp

### 8. Styling

Use the existing Tailwind CSS patterns:
- Background: `bg-zinc-900` for dark theme
- Borders: `border-zinc-700`
- Text: `text-white`, `text-zinc-300`, `text-zinc-400`
- Accents: `bg-blue-600`, `text-blue-400`
- Spacing: Consistent with existing components

Example discussion item styling:
```tsx
<div className="p-3 bg-zinc-800/50 border border-zinc-700 rounded-lg">
  <div className="flex items-center gap-2 mb-2">
    <span className="text-lg">{authorIcon}</span>
    <span className="font-medium text-white">{authorName}</span>
    <span className="text-zinc-500 text-sm">{relativeTime}</span>
    {isEdited && <span className="text-zinc-500 text-xs">(edited)</span>}
  </div>
  <div className="prose prose-in prose-sm max-w-none text-zinc-300">
    {markdownContent}
  </div>
  {/* Actions */}
</div>
```

## Implementation Details

### Markdown Rendering

Use a markdown library (likely already in dependencies):
```typescript
import ReactMarkdown from 'react-markdown';

// In component:
<ReactMarkdown className="prose prose-invert prose-sm">
  {comment.content}
</ReactMarkdown>
```

### Relative Time

Create a helper function:
```typescript
function formatRelativeTime(date: Date): string {
  // Return "2 hours ago", "yesterday", etc.
  // Use Intl.RelativeTimeFormat or a library
}
```

### Author Badges

```typescript
function getAuthorBadge(authorType: string) {
  switch (authorType) {
    case 'human': return { icon: '👤', label: 'Human', color: 'text-blue-400' };
    case 'arm': return { icon: '🤖', label: 'Arm', color: 'text-green-400' };
    case 'brain': return { icon: '🧠', label: 'Brain', color: 'text-purple-400' };
    default: return { icon: '❓', label: 'Unknown', color: 'text-gray-400' };
  }
}
```

### Threading Logic

When `threaded=true` in API call, discussions come back nested:
```typescript
interface TaskComment {
  // ... other fields
  replies?: TaskComment[];
}

// Render recursively:
function renderThread(comments: TaskComment[], depth = 0) {
  return comments.map(comment => (
    <div key={comment.id} style={{ marginLeft: depth * 20 }}>
      <DiscussionItem comment={comment} depth={depth} />
      {comment.replies && renderThread(comment.replies, depth + 1)}
    </div>
  ));
}
```

### WebSocket Event Handling

```typescript
useEffect(() => {
  const ws = new WebSocket(wsUrl);
  
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    
    if (data.type === 'discussion.created' && data.taskId === taskId) {
      // Fetch new comment or add to list
      refetchDiscussions();
    }
    // Handle other events...
  };
  
  return () => ws.close();
}, [taskId]);
```

### Current User Detection

Get current user email from:
- API endpoint (add if needed)
- Local storage
- Environment config

```typescript
const currentUserEmail = localStorage.getItem('user_email') || 'unknown';
const isOwnComment = comment.authorType === 'human' && comment.authorId === currentUserEmail;
```

## Testing with Chrome DevTools MCP

Since this is a UI task, use the Chrome DevTools MCP for testing:

1. **Start the development server**:
   ```bash
   bun run dev:web
   ```

2. **Use Chrome DevTools to**:
   - Navigate to task list
   - Open a task
   - Verify discussion panel loads
   - Test adding a comment
   - Test replying to a comment
   - Test editing/deleting
   - Verify real-time updates

3. **Test scenarios**:
   - Empty discussion state
   - Many comments (pagination)
   - Threaded replies
   - Different author types
   - Mobile responsiveness

## Critical Requirements

1. **Real-time updates**: WebSocket events must update UI immediately
2. **Threading**: Support nested replies with visual indentation
3. **Markdown**: Render content as markdown
4. **Author attribution**: Show different badges for Human/Arm/Brain
5. **Permissions**: Only show edit/delete for own comments
6. **Time limits**: Disable edit after 24 hours
7. **Unread tracking**: Show unread indicators and counts
8. **Responsive**: Work on mobile and desktop

## Files to Create/Modify

**Create:**
1. `src/web/src/components/TaskDiscussionPanel.tsx` - Main discussion panel
2. `src/web/src/components/DiscussionItem.tsx` - Individual comment
3. `src/web/src/components/DiscussionComposer.tsx` - Input area

**Modify:**
1. `src/web/src/lib/api.ts` - Add API methods
2. `src/web/src/components/TaskModal.tsx` - Add discussions tab (or create TaskDetailView)
3. `src/web/src/components/TaskGrid.tsx` - Add comment count badges
4. `src/web/src/hooks/useWebSocket.ts` - Handle discussion events

## Success Criteria

- [ ] Discussion panel displays comments correctly
- [ ] Threaded replies show with proper indentation
- [ ] Markdown content renders properly
- [ ] Author badges show correctly (Human/Arm/Brain)
- [ ] Can add new comments
- [ ] Can reply to existing comments
- [ ] Can edit own comments (within 24h)
- [ ] Can delete own comments
- [ ] Real-time updates via WebSocket work
- [ ] Unread indicators show correctly
- [ ] Task list shows comment counts
- [ ] Works on mobile and desktop
- [ ] `bun run typecheck` passes

## Integration Notes

This UI consumes:
- **API endpoints** from CLI/API task
- **WebSocket events** from server
- **Database** via API

After this task, humans can:
1. View task discussions in the Web UI
2. Add comments and replies
3. See real-time updates from agents
4. Track unread messages

The UI should be intuitive and feel like a modern chat/discussion interface!
