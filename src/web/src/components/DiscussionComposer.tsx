/**
 * DiscussionComposer - Input component for adding comments to task discussions
 */
import { useState, useRef, useEffect } from 'react';
import { Send, X, Eye, EyeOff } from 'lucide-react';
import { Button } from '@heroui/react';
import { cn } from '@/lib/utils';

interface DiscussionComposerProps {
  replyTo?: { id: string; authorName: string } | null;
  editingContent?: string;
  onCancelReply?: () => void;
  onSubmit: (content: string, parentId?: string) => Promise<void>;
  onCancelEdit?: () => void;
  isEditing?: boolean;
  className?: string;
}

export function DiscussionComposer({
  replyTo,
  editingContent,
  onCancelReply,
  onSubmit,
  onCancelEdit,
  isEditing = false,
  className,
}: DiscussionComposerProps) {
  const [content, setContent] = useState(editingContent || '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus textarea on mount or when replying
  useEffect(() => {
    if (replyTo || isEditing) {
      textareaRef.current?.focus();
    }
  }, [replyTo, isEditing]);

  // Initialize with editing content
  useEffect(() => {
    if (editingContent) {
      setContent(editingContent);
    }
  }, [editingContent]);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  }, [content]);

  const handleSubmit = async () => {
    const trimmedContent = content.trim();
    if (!trimmedContent || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await onSubmit(trimmedContent, replyTo?.id);
      setContent('');
      setShowPreview(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Submit on Cmd/Ctrl + Enter
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
    // Cancel on Escape
    if (e.key === 'Escape') {
      if (isEditing && onCancelEdit) {
        onCancelEdit();
      } else if (replyTo && onCancelReply) {
        onCancelReply();
      }
    }
  };

  const handleCancel = () => {
    if (isEditing && onCancelEdit) {
      onCancelEdit();
    } else if (onCancelReply) {
      onCancelReply();
    }
    setContent('');
  };

  // Simple preview rendering
  const renderPreview = () => {
    if (!content.trim()) {
      return <span className="text-foreground-400 italic">Nothing to preview</span>;
    }

    // Basic markdown rendering for preview
    const lines = content.split('\n');
    return lines.map((line, idx) => {
      // Process bold
      const processed = line.split(/\*\*([^*]+)\*\*/g).map((part, partIdx) => {
        if (partIdx % 2 === 1) {
          return <strong key={`bold-${idx}-${partIdx}`}>{part}</strong>;
        }
        // Process code
        return part.split(/`([^`]+)`/g).map((codePart, codeIdx) => {
          if (codeIdx % 2 === 1) {
            return <code key={`code-${idx}-${partIdx}-${codeIdx}`} className="px-1 py-0.5 bg-default-100 text-default-700 rounded text-sm font-mono">{codePart}</code>;
          }
          return codePart;
        });
      });

      return (
        <span key={`line-${idx}`}>
          {processed}
          {idx < lines.length - 1 && <br />}
        </span>
      );
    });
  };

  const canSubmit = content.trim().length > 0 && !isSubmitting;

  return (
    <div className={cn('border border-divider rounded-lg bg-content2', className)}>
      {/* Reply indicator */}
      {replyTo && (
        <div className="flex items-center justify-between px-3 py-2 border-b border-divider bg-content3/50">
          <span className="text-sm text-foreground-400">
            Replying to <span className="text-primary font-medium">{replyTo.authorName}</span>
          </span>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={handleCancel}
            aria-label="Cancel reply"
            className="h-6 w-6"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {/* Edit indicator */}
      {isEditing && (
        <div className="flex items-center justify-between px-3 py-2 border-b border-divider bg-warning/10">
          <span className="text-sm text-warning">
            Editing comment
          </span>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={handleCancel}
            aria-label="Cancel edit"
            className="h-6 w-6"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {/* Preview mode */}
      {showPreview ? (
        <div className="p-3 min-h-[80px] text-foreground text-sm leading-relaxed whitespace-pre-wrap">
          {renderPreview()}
        </div>
      ) : (
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={replyTo ? 'Write a reply...' : 'Add a comment...'}
          className={cn(
            'w-full px-3 py-2 bg-transparent text-foreground placeholder-foreground-400',
            'resize-none focus:outline-none',
            'min-h-[80px] max-h-[200px]'
          )}
          disabled={isSubmitting}
          aria-label={replyTo ? 'Reply content' : 'Comment content'}
        />
      )}

      {/* Footer */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-divider">
        <div className="flex items-center gap-2">
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={() => setShowPreview(!showPreview)}
            aria-label={showPreview ? 'Edit' : 'Preview'}
            className="h-7 w-7"
          >
            {showPreview ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </Button>
          <span className="text-xs text-foreground-400">
            Supports **bold** and `code`
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-foreground-400">
            <kbd className="px-1 py-0.5 bg-default-100 rounded text-foreground-500">Cmd</kbd>+<kbd className="px-1 py-0.5 bg-default-100 rounded text-foreground-500">Enter</kbd>
          </span>
          <Button
            size="sm"
            variant="primary"
            onPress={handleSubmit}
            isDisabled={!canSubmit}
            className="gap-1.5"
          >
            {isSubmitting ? (
              'Sending...'
            ) : (
              <>
                <Send className="h-3.5 w-3.5" />
                {isEditing ? 'Save' : 'Send'}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
