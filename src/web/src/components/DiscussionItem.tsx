/**
 * DiscussionItem - Individual comment in a task discussion
 */
import { useState, type ReactNode } from 'react';
import { Reply, Edit2, Trash2, MoreHorizontal, User, Bot, Brain } from 'lucide-react';
import { Button, Dropdown, Chip } from '@heroui/react';
import { cn } from '@/lib/utils';
import type { TaskComment } from '@/lib/api';

interface DiscussionItemProps {
  comment: TaskComment;
  depth?: number;
  currentUserId: string;
  onReply: (commentId: string) => void;
  onEdit: (comment: TaskComment) => void;
  onDelete: (commentId: string) => void;
  isUnread?: boolean;
}

// Author configuration
const AUTHOR_CONFIG = {
  human: { 
    icon: User,
    label: 'Human', 
    bgClass: 'bg-accent/10',
    textClass: 'text-accent',
    iconClass: 'text-accent',
  },
  arm: { 
    icon: Bot,
    label: 'Arm', 
    bgClass: 'bg-success/10',
    textClass: 'text-success',
    iconClass: 'text-success',
  },
  brain: { 
    icon: Brain,
    label: 'Brain', 
    bgClass: 'bg-secondary/10',
    textClass: 'text-secondary',
    iconClass: 'text-secondary',
  },
} as const;

/**
 * Format a date as relative time (e.g., "2 hours ago", "yesterday")
 */
function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) {
    return 'just now';
  } else if (diffMinutes < 60) {
    return `${diffMinutes} ${diffMinutes === 1 ? 'minute' : 'minutes'} ago`;
  } else if (diffHours < 24) {
    return `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'} ago`;
  } else if (diffDays === 1) {
    return 'yesterday';
  } else if (diffDays < 7) {
    return `${diffDays} days ago`;
  } else {
    return date.toLocaleDateString();
  }
}

/**
 * Check if a comment can be edited (within 24 hours)
 */
function canEditComment(comment: TaskComment, currentUserId: string): boolean {
  if (comment.authorType !== 'human' || comment.authorId !== currentUserId) {
    return false;
  }
  const createdAt = new Date(comment.createdAt);
  const now = new Date();
  const hoursSinceCreation = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60);
  return hoursSinceCreation <= 24;
}

/**
 * Simple markdown-like rendering for comments
 * Supports: **bold**, `code`, and line breaks
 */
function renderMarkdown(content: string): ReactNode {
  const lines = content.split('\n');
  const lineCounts = new Map<string, number>();

  return (
    <>
      {lines.map((line, lineIndex) => {
        const seenCount = lineCounts.get(line) ?? 0;
        lineCounts.set(line, seenCount + 1);

        return (
          <span key={`line-${line}-${seenCount}`}>
            {renderMarkdownLine(line, lineIndex)}
            {lineIndex < lines.length - 1 && <br />}
          </span>
        );
      })}
    </>
  );
}

function renderMarkdownLine(content: string, lineIndex: number): ReactNode {
  const parts = content.split(/(`[^`]+`)/g);

  return parts.map((part, partIndex) => {
    const keyBase = `${lineIndex}-${partIndex}`;

    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code
          key={`code-${keyBase}`}
          className="px-1.5 py-0.5 bg-default-100 text-default-700 rounded text-sm font-mono"
        >
          {part.slice(1, -1)}
        </code>
      );
    }

    const boldParts = part.split(/\*\*([^*]+)\*\*/g);
    if (boldParts.length > 1) {
      return (
        <span key={`bold-${keyBase}`}>
          {boldParts.map((boldPart, boldIndex) => {
            const boldKey = `${keyBase}-${boldIndex}`;

            if (boldIndex % 2 === 1 && boldPart) {
              return (
                <strong key={`strong-${boldKey}`} className="font-semibold">
                  {boldPart}
                </strong>
              );
            }

            return <span key={`text-${boldKey}`}>{boldPart}</span>;
          })}
        </span>
      );
    }

    return <span key={`text-${keyBase}`}>{part}</span>;
  });
}

export function DiscussionItem({
  comment,
  depth = 0,
  currentUserId,
  onReply,
  onEdit,
  onDelete,
  isUnread = false,
}: DiscussionItemProps) {
  const [isHovered, setIsHovered] = useState(false);

  const config = AUTHOR_CONFIG[comment.authorType];
  const IconComponent = config.icon;
  const authorName = comment.authorName || comment.authorId;
  const createdAt = new Date(comment.createdAt);
  const canEdit = canEditComment(comment, currentUserId);
  const isOwnComment = comment.authorType === 'human' && comment.authorId === currentUserId;

  // Maximum indentation depth
  const effectiveDepth = Math.min(depth, 4);

  return (
    <div
      className={cn(
        'relative',
        effectiveDepth > 0 && 'ml-4 pl-3 border-l-2 border-divider'
      )}
    >
      <article
        className={cn(
          'p-3 rounded-lg transition-all border group',
          isUnread
            ? 'bg-accent/5 border-accent/30'
            : 'bg-content2 border-divider',
          isHovered && 'bg-content3'
        )}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        aria-label={`Comment by ${authorName}`}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-2 min-w-0">
            {/* Avatar */}
            <div className={cn('w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0', config.bgClass)}>
              <IconComponent className={cn('h-4 w-4', config.iconClass)} />
            </div>
            <div className="flex items-center gap-2 min-w-0 flex-wrap">
              <span className={cn('font-medium', config.textClass)}>
                {authorName}
              </span>
              <Chip size="sm" variant="soft" className={cn('h-5 text-xs', config.bgClass, config.textClass)}>
                {config.label}
              </Chip>
              <span className="text-foreground-400 text-sm">
                {formatRelativeTime(createdAt)}
              </span>
              {comment.edited && (
                <span className="text-foreground-400 text-xs">(edited)</span>
              )}
              {isUnread && (
                <Chip size="sm" variant="soft" className="h-5 text-xs bg-accent text-white">
                  new
                </Chip>
              )}
            </div>
          </div>

          {/* Actions - always rendered but hidden via CSS until hover */}
          <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              onPress={() => onReply(comment.id)}
              aria-label="Reply"
            >
              <Reply className="h-4 w-4" />
            </Button>

            {isOwnComment && (
              <Dropdown>
                <Dropdown.Trigger>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    aria-label="More actions"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </Dropdown.Trigger>
                <Dropdown.Popover>
                  <Dropdown.Menu
                    onAction={(key) => {
                      if (key === 'edit') onEdit(comment);
                      if (key === 'delete') onDelete(comment.id);
                    }}
                  >
                    <Dropdown.Item key="edit" isDisabled={!canEdit}>
                      <span className="flex items-center gap-2">
                        <Edit2 className="h-4 w-4" />
                        {canEdit ? 'Edit' : 'Edit (expired)'}
                      </span>
                    </Dropdown.Item>
                    <Dropdown.Item key="delete" className="text-danger">
                      <span className="flex items-center gap-2">
                        <Trash2 className="h-4 w-4" />
                        Delete
                      </span>
                    </Dropdown.Item>
                  </Dropdown.Menu>
                </Dropdown.Popover>
              </Dropdown>
            )}
          </div>
        </div>
        
        {/* Content */}
        <div className="text-foreground text-sm leading-relaxed whitespace-pre-wrap break-words pl-10">
          {renderMarkdown(comment.content)}
        </div>
        {/* Screenshot (if provided) */}
        {comment.screenshotPath && (
          <div className="pl-10 mt-2">
            <img
              src={comment.screenshotPath}
              alt="Screenshot"
              className="rounded border max-w-full"
            />
          </div>
        )}
      </article>
      
      {/* Replies (recursive) */}
      {comment.replies && comment.replies.length > 0 && (
        <div className="mt-2 space-y-2">
          {comment.replies.map((reply) => (
            <DiscussionItem
              key={reply.id}
              comment={reply}
              depth={depth + 1}
              currentUserId={currentUserId}
              onReply={onReply}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
