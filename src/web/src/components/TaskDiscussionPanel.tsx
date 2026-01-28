/**
 * TaskDiscussionPanel - Main panel for task discussions with threading support
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { MessageSquare, ChevronDown } from 'lucide-react';
import { Button } from '@heroui/react';
import { api, type TaskComment } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useWebSocket } from '@/hooks/useWebSocket';
import { DiscussionItem } from './DiscussionItem';
import { DiscussionComposer } from './DiscussionComposer';

interface TaskDiscussionPanelProps {
  taskId: string;
  className?: string;
  onCommentCountChange?: (count: number) => void;
}

// Get current user ID from localStorage or default
function getCurrentUserId(): string {
  return localStorage.getItem('octopai_user_email') || 'human@local';
}

// Get current user name
function getCurrentUserName(): string {
  return localStorage.getItem('octopai_user_name') || 'You';
}

export function TaskDiscussionPanel({
  taskId,
  className,
  onCommentCountChange,
}: TaskDiscussionPanelProps) {
  const [discussions, setDiscussions] = useState<TaskComment[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Reply state
  const [replyTo, setReplyTo] = useState<{ id: string; authorName: string } | null>(null);
  
  // Edit state
  const [editing, setEditing] = useState<TaskComment | null>(null);
  
  // Unread tracking
  const [unreadCount, setUnreadCount] = useState(0);
  const [lastReadCommentId, setLastReadCommentId] = useState<string | null>(null);
  
  // Refs
  const discussionListRef = useRef<HTMLDivElement>(null);
  const currentUserId = getCurrentUserId();
  const currentUserName = getCurrentUserName();

  // Fetch discussions
  const fetchDiscussions = useCallback(async (loadMore = false) => {
    try {
      const offset = loadMore ? discussions.length : 0;
      const result = await api.getTaskDiscussions(taskId, {
        limit: 50,
        offset,
        threaded: true,
      });
      
      if (loadMore) {
        setDiscussions(prev => [...prev, ...result.discussions]);
      } else {
        setDiscussions(result.discussions);
      }
      
      setTotalCount(result.totalCount);
      setHasMore(offset + result.discussions.length < result.totalCount);
      setError(null);
      
      // Notify parent of comment count
      onCommentCountChange?.(result.totalCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load discussions');
    } finally {
      setIsLoading(false);
    }
  }, [taskId, discussions.length, onCommentCountChange]);

  // Fetch unread count
  const fetchUnreadCount = useCallback(async () => {
    try {
      const result = await api.getUnreadDiscussionCount(taskId, currentUserId);
      setUnreadCount(result.unreadCount);
    } catch {
      // Ignore unread count errors
    }
  }, [taskId, currentUserId]);

  // Handle WebSocket events for real-time updates
  const handleWSMessage = useCallback((msg: { channel?: string; event?: string; data?: unknown }) => {
    if (msg.channel !== 'tasks' || !msg.data) return;
    
    const data = msg.data as { taskId?: string; commentId?: string };
    
    // Only handle events for this task
    if (data.taskId !== taskId) return;
    
    switch (msg.event) {
      case 'discussion.created':
      case 'discussion.updated':
      case 'discussion.deleted':
        // Refresh the discussion list
        fetchDiscussions();
        break;
    }
  }, [taskId, fetchDiscussions]);

  // Subscribe to WebSocket events
  useWebSocket({
    channels: ['tasks'],
    onMessage: handleWSMessage,
  });

  // Initial fetch
  useEffect(() => {
    setIsLoading(true);
    fetchDiscussions();
    fetchUnreadCount();
  }, [taskId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mark as read when viewing
  useEffect(() => {
    if (discussions.length > 0 && unreadCount > 0) {
      const latestComment = discussions[0]; // Discussions are ordered by created_at DESC
      if (latestComment && latestComment.id !== lastReadCommentId) {
        api.markTaskDiscussionsRead(taskId, currentUserId, latestComment.id)
          .then(() => {
            setUnreadCount(0);
            setLastReadCommentId(latestComment.id);
          })
          .catch(() => {
            // Ignore mark-read errors
          });
      }
    }
  }, [discussions, unreadCount, taskId, currentUserId, lastReadCommentId]);

  // Handle new comment submission
  const handleSubmit = async (content: string, parentId?: string) => {
    const result = await api.createTaskDiscussion(taskId, {
      content,
      parentId,
      authorType: 'human',
      authorId: currentUserId,
      authorName: currentUserName,
      client: 'web',
    });
    
    // Add new comment to list (at the beginning since sorted DESC)
    if (!parentId) {
      setDiscussions(prev => [result.comment, ...prev]);
    } else {
      // For replies, we need to add to the parent's replies
      setDiscussions(prev => addReplyToDiscussions(prev, parentId, result.comment));
    }
    
    setTotalCount(prev => prev + 1);
    onCommentCountChange?.(totalCount + 1);
    
    // Clear reply state
    setReplyTo(null);
    
    // Scroll to top to show new comment
    discussionListRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Handle edit submission
  const handleEditSubmit = async (content: string) => {
    if (!editing) return;
    
    const result = await api.updateTaskDiscussion(taskId, editing.id, {
      content,
      authorId: currentUserId,
    });
    
    // Update comment in list
    setDiscussions(prev => updateCommentInDiscussions(prev, editing.id, result.comment));
    
    // Clear edit state
    setEditing(null);
  };

  // Handle delete
  const handleDelete = async (commentId: string) => {
    if (!confirm('Are you sure you want to delete this comment?')) return;
    
    try {
      await api.deleteTaskDiscussion(taskId, commentId, currentUserId);
      
      // Remove from list
      setDiscussions(prev => removeCommentFromDiscussions(prev, commentId));
      setTotalCount(prev => prev - 1);
      onCommentCountChange?.(totalCount - 1);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete comment');
    }
  };

  // Handle reply
  const handleReply = (commentId: string) => {
    const comment = findCommentById(discussions, commentId);
    if (comment) {
      setReplyTo({
        id: comment.id,
        authorName: comment.authorName || comment.authorId,
      });
      setEditing(null);
    }
  };

  // Handle edit
  const handleEdit = (comment: TaskComment) => {
    setEditing(comment);
    setReplyTo(null);
  };

  // Reverse the display order (newest at bottom for chat-like UX)
  const displayDiscussions = [...discussions].reverse();

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* Error state */}
      {error && (
        <div className="px-4 py-2 bg-red-500/10 border-b border-red-500/30">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Discussion list */}
      <div 
        ref={discussionListRef}
        className="flex-1 overflow-y-auto p-4 space-y-3"
      >
        {isLoading ? (
          // Loading skeleton
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="p-3 bg-zinc-800/50 border border-zinc-700 rounded-lg animate-pulse">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-6 h-6 bg-zinc-700 rounded" />
                  <div className="w-24 h-4 bg-zinc-700 rounded" />
                </div>
                <div className="w-full h-12 bg-zinc-700 rounded" />
              </div>
            ))}
          </div>
        ) : displayDiscussions.length === 0 ? (
          // Empty state
          <div className="flex flex-col items-center justify-center h-full text-center py-8">
            <MessageSquare className="h-12 w-12 text-zinc-600 mb-3" />
            <p className="text-zinc-400 text-sm">No discussions yet</p>
            <p className="text-zinc-500 text-xs mt-1">
              Start a conversation about this task
            </p>
          </div>
        ) : (
          <>
            {/* Load more button at top (for older messages) */}
            {hasMore && (
              <Button
                size="sm"
                variant="ghost"
                onPress={() => fetchDiscussions(true)}
                className="w-full mb-3"
              >
                <ChevronDown className="h-3.5 w-3.5 mr-1" />
                Load older messages
              </Button>
            )}
            
            {/* Discussion items */}
            {displayDiscussions.map((comment) => (
              <DiscussionItem
                key={comment.id}
                comment={comment}
                currentUserId={currentUserId}
                onReply={handleReply}
                onEdit={handleEdit}
                onDelete={handleDelete}
              />
            ))}
          </>
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-zinc-700 p-3">
        {editing ? (
          <DiscussionComposer
            replyTo={null}
            editingContent={editing.content}
            isEditing={true}
            onSubmit={handleEditSubmit}
            onCancelEdit={() => setEditing(null)}
          />
        ) : (
          <DiscussionComposer
            replyTo={replyTo}
            onSubmit={handleSubmit}
            onCancelReply={() => setReplyTo(null)}
          />
        )}
      </div>
    </div>
  );
}

// Helper functions for managing nested comments

function addReplyToDiscussions(
  discussions: TaskComment[],
  parentId: string,
  reply: TaskComment
): TaskComment[] {
  return discussions.map(comment => {
    if (comment.id === parentId) {
      return {
        ...comment,
        replies: [...(comment.replies || []), reply],
      };
    }
    if (comment.replies && comment.replies.length > 0) {
      return {
        ...comment,
        replies: addReplyToDiscussions(comment.replies, parentId, reply),
      };
    }
    return comment;
  });
}

function updateCommentInDiscussions(
  discussions: TaskComment[],
  commentId: string,
  updated: TaskComment
): TaskComment[] {
  return discussions.map(comment => {
    if (comment.id === commentId) {
      return { ...updated, replies: comment.replies };
    }
    if (comment.replies && comment.replies.length > 0) {
      return {
        ...comment,
        replies: updateCommentInDiscussions(comment.replies, commentId, updated),
      };
    }
    return comment;
  });
}

function removeCommentFromDiscussions(
  discussions: TaskComment[],
  commentId: string
): TaskComment[] {
  return discussions
    .filter(comment => comment.id !== commentId)
    .map(comment => {
      if (comment.replies && comment.replies.length > 0) {
        return {
          ...comment,
          replies: removeCommentFromDiscussions(comment.replies, commentId),
        };
      }
      return comment;
    });
}

function findCommentById(
  discussions: TaskComment[],
  commentId: string
): TaskComment | null {
  for (const comment of discussions) {
    if (comment.id === commentId) {
      return comment;
    }
    if (comment.replies && comment.replies.length > 0) {
      const found = findCommentById(comment.replies, commentId);
      if (found) return found;
    }
  }
  return null;
}
