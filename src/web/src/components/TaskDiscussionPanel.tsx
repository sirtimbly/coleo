import { useState, useEffect, useCallback, useRef } from 'react';
import { MessageSquare, ChevronDown, Sparkles } from 'lucide-react';
import { Button } from '@heroui/react';
import { api, isJsonObject, type TaskComment } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useWebSocket, type WebSocketMessage } from '@/hooks/useWebSocket';
import { DiscussionItem } from './DiscussionItem';
import { DiscussionComposer } from './DiscussionComposer';
import { PreparedTaskModal } from './PreparedTaskModal';

interface TaskDiscussionPanelProps {
  taskId: string;
  className?: string;
  onCommentCountChange?: (count: number) => void;
}

function getCurrentUserId(): string {
  return localStorage.getItem('coleo_user_email') || 'human@local';
}

function getCurrentUserName(): string {
  return localStorage.getItem('coleo_user_name') || 'You';
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
  
  const [replyTo, setReplyTo] = useState<{ id: string; authorName: string } | null>(null);

  const [editing, setEditing] = useState<TaskComment | null>(null);

  const [unreadCount, setUnreadCount] = useState(0);
  const [lastReadCommentId, setLastReadCommentId] = useState<string | null>(null);

  const [isPrepareOpen, setIsPrepareOpen] = useState(false);
  const [preparedTask, setPreparedTask] = useState<import('@/lib/api').PreparedTaskDefinition | null>(null);
  const [isPreparing, setIsPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);

  const discussionListRef = useRef<HTMLDivElement>(null);
  const currentUserId = getCurrentUserId();
  const currentUserName = getCurrentUserName();

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

      onCommentCountChange?.(result.totalCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load discussions');
    } finally {
      setIsLoading(false);
    }
  }, [taskId, discussions.length, onCommentCountChange]);

  const fetchUnreadCount = useCallback(async () => {
    try {
      const result = await api.getUnreadDiscussionCount(taskId, currentUserId);
      setUnreadCount(result.unreadCount);
    } catch {
      setUnreadCount(0);
    }
  }, [taskId, currentUserId]);

  const handleWSMessage = useCallback((msg: WebSocketMessage) => {
    if (msg.channel !== 'tasks' || !isJsonObject(msg.data)) return;
    
    const data = msg.data;
    const taskIdValue = data.taskId;
    if (typeof taskIdValue !== 'string' || taskIdValue !== taskId) return;
    
    switch (msg.event) {
      case 'discussion.created':
      case 'discussion.updated':
      case 'discussion.deleted':
        fetchDiscussions();
        break;
    }
  }, [taskId, fetchDiscussions]);

  useWebSocket({
    channels: ['tasks'],
    onMessage: handleWSMessage,
  });

  useEffect(() => {
    setIsLoading(true);
    fetchDiscussions();
    fetchUnreadCount();
  }, [taskId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (discussions.length > 0 && unreadCount > 0) {
      const latestComment = discussions[0];
      if (latestComment && latestComment.id !== lastReadCommentId) {
        api.markTaskDiscussionsRead(taskId, currentUserId, latestComment.id)
          .then(() => {
            setUnreadCount(0);
            setLastReadCommentId(latestComment.id);
          })
          .catch(() => {});
      }
    }
  }, [discussions, unreadCount, taskId, currentUserId, lastReadCommentId]);

  const handleSubmit = async (content: string, parentId?: string) => {
    const result = await api.createTaskDiscussion(taskId, {
      content,
      parentId,
      authorType: 'human',
      authorId: currentUserId,
      authorName: currentUserName,
      client: 'web',
    });

    if (!parentId) {
      setDiscussions(prev => [result.comment, ...prev]);
    } else {
      setDiscussions(prev => addReplyToDiscussions(prev, parentId, result.comment));
    }

    setTotalCount(prev => prev + 1);
    onCommentCountChange?.(totalCount + 1);

    setReplyTo(null);

    discussionListRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleEditSubmit = async (content: string) => {
    if (!editing) return;
    
    const result = await api.updateTaskDiscussion(taskId, editing.id, {
      content,
      authorId: currentUserId,
    });

    setDiscussions(prev => updateCommentInDiscussions(prev, editing.id, result.comment));

    setEditing(null);
  };

  const handleDelete = async (commentId: string) => {
    if (!confirm('Are you sure you want to delete this comment?')) return;
    
    try {
      await api.deleteTaskDiscussion(taskId, commentId, currentUserId);

      setDiscussions(prev => removeCommentFromDiscussions(prev, commentId));
      setTotalCount(prev => prev - 1);
      onCommentCountChange?.(totalCount - 1);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete comment');
    }
  };

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

  const handleEdit = (comment: TaskComment) => {
    setEditing(comment);
    setReplyTo(null);
  };

  const handlePrepareTask = async () => {
    setIsPrepareOpen(true);
    setIsPreparing(true);
    setPrepareError(null);
    setPreparedTask(null);

    try {
      const result = await api.prepareTaskFromDiscussion(taskId);
      setPreparedTask(result.prepared);
    } catch (err) {
      setPrepareError(err instanceof Error ? err.message : 'Failed to prepare task');
    } finally {
      setIsPreparing(false);
    }
  };

  const displayDiscussions = [...discussions].reverse();

  return (
    <div className={cn('flex flex-col h-full', className)}>
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-700 bg-zinc-800/30">
        <h3 className="text-sm font-medium text-zinc-300">Discussion</h3>
        <Button
          size="sm"
          variant="ghost"
          onPress={handlePrepareTask}
          isDisabled={isPreparing}
          className="text-amber-400 hover:text-amber-300 hover:bg-amber-950/20"
        >
          <Sparkles className="h-3.5 w-3.5 mr-1.5" />
          Prepare task
        </Button>
      </div>

      {error && (
        <div className="px-4 py-2 bg-red-500/10 border-b border-red-500/30">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      <div 
        ref={discussionListRef}
        className="flex-1 overflow-y-auto p-4 space-y-3"
      >
        {isLoading ? (
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
          <div className="flex flex-col items-center justify-center h-full text-center py-8">
            <MessageSquare className="h-12 w-12 text-zinc-600 mb-3" />
            <p className="text-zinc-400 text-sm">No discussions yet</p>
            <p className="text-zinc-500 text-xs mt-1">
              Start a conversation about this task
            </p>
          </div>
        ) : (
          <>
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

      <PreparedTaskModal
        isOpen={isPrepareOpen}
        onClose={() => setIsPrepareOpen(false)}
        taskId={taskId}
        prepared={preparedTask}
        isLoading={isPreparing}
        error={prepareError}
      />
    </div>
  );
}

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
