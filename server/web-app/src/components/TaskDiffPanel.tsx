/**
 * TaskDiffPanel - shows the log of unified diffs recorded as arms/brain
 * work on a task, with per-user "viewed" tracking (auto-marks diffs viewed
 * once they've been visible in this panel).
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, Bot, Brain, User, GitCommitHorizontal, ChevronDown, ChevronRight } from 'lucide-react';
import { Button, Chip } from '@heroui/react';
import { api, isJsonObject, type TaskDiff } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useWebSocket, type WebSocketMessage } from '@/hooks/useWebSocket';

interface TaskDiffPanelProps {
  taskId: string;
  className?: string;
  onDiffCountChange?: (count: number) => void;
}

const AUTHOR_CONFIG = {
  human: { icon: User, label: 'Human', textClass: 'text-accent', bgClass: 'bg-accent/10' },
  arm: { icon: Bot, label: 'Arm', textClass: 'text-success', bgClass: 'bg-success/10' },
  brain: { icon: Brain, label: 'Brain', textClass: 'text-secondary', bgClass: 'bg-secondary/10' },
} as const;

function getCurrentUserId(): string {
  return localStorage.getItem('coleo_user_email') || 'human@local';
}

function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  if (diffSeconds < 60) return 'just now';
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function TaskDiffPanel({ taskId, className, onDiffCountChange }: TaskDiffPanelProps) {
  const [diffs, setDiffs] = useState<TaskDiff[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const currentUserId = getCurrentUserId();
  const viewedRef = useRef<string | null>(null);

  const fetchDiffs = useCallback(async () => {
    try {
      const result = await api.getTaskDiffs(taskId, { limit: 100 });
      setDiffs(result.diffs);
      setError(null);
      onDiffCountChange?.(result.totalCount);
      // Auto-expand the most recent diff so the panel isn't empty-looking
      if (result.diffs[0]) {
        setExpanded((prev) => (prev.size === 0 ? new Set([result.diffs[0]!.id]) : prev));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load diffs');
    } finally {
      setIsLoading(false);
    }
  }, [taskId, onDiffCountChange]);

  const handleWSMessage = useCallback(
    (msg: WebSocketMessage) => {
      if (msg.channel !== 'tasks' || !isJsonObject(msg.data)) return;
      const taskIdValue = msg.data.taskId;
      if (typeof taskIdValue !== 'string' || taskIdValue !== taskId) return;
      if (msg.event === 'diff.created') {
        fetchDiffs();
      }
    },
    [taskId, fetchDiffs]
  );

  useWebSocket({ channels: ['tasks'], onMessage: handleWSMessage });

  useEffect(() => {
    setIsLoading(true);
    fetchDiffs();
  }, [taskId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mark the newest diff as viewed once it's rendered in this panel.
  useEffect(() => {
    const newest = diffs[0];
    if (!newest || viewedRef.current === newest.id) return;
    viewedRef.current = newest.id;
    api.markTaskDiffsViewed(taskId, currentUserId, newest.id).catch(() => {});
  }, [diffs, taskId, currentUserId]);

  const toggleExpanded = (diffId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(diffId)) next.delete(diffId);
      else next.add(diffId);
      return next;
    });
  };

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {error && (
        <div className="px-4 py-2 bg-danger/10 border-b border-danger/30">
          <p className="text-sm text-danger">{error}</p>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2].map((i) => (
              <div key={i} className="p-3 bg-content2 border border-divider rounded-lg animate-pulse">
                <div className="w-40 h-4 bg-content3 rounded mb-2" />
                <div className="w-full h-16 bg-content3 rounded" />
              </div>
            ))}
          </div>
        ) : diffs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-8">
            <GitCommitHorizontal className="h-12 w-12 text-foreground-400 mb-3" />
            <p className="text-sm text-foreground-500">No diffs recorded yet</p>
            <p className="text-xs text-foreground-400 mt-1">
              Code changes made while working on this task will appear here.
            </p>
          </div>
        ) : (
          diffs.map((diff) => (
            <DiffCard
              key={diff.id}
              diff={diff}
              isExpanded={expanded.has(diff.id)}
              onToggle={() => toggleExpanded(diff.id)}
            />
          ))
        )}
      </div>

      <div className="border-t border-divider px-4 py-2 flex justify-end">
        <Button size="sm" variant="ghost" onPress={fetchDiffs}>
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          Refresh
        </Button>
      </div>
    </div>
  );
}

function DiffCard({
  diff,
  isExpanded,
  onToggle,
}: {
  diff: TaskDiff;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const config = AUTHOR_CONFIG[diff.authorType];
  const Icon = config.icon;
  const createdAt = new Date(diff.createdAt);

  return (
    <article className="rounded-lg border border-divider bg-content2 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 p-3 text-left hover:bg-content3 transition-colors"
      >
        {isExpanded ? (
          <ChevronDown className="h-4 w-4 text-foreground-400 flex-shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 text-foreground-400 flex-shrink-0" />
        )}
        <div className={cn('w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0', config.bgClass)}>
          <Icon className={cn('h-3.5 w-3.5', config.textClass)} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium truncate">
              {diff.title || diff.filePath || 'Diff'}
            </span>
            <Chip size="sm" variant="soft" className={cn('h-5 text-xs', config.bgClass, config.textClass)}>
              {config.label}
            </Chip>
          </div>
          {diff.filePath && diff.title && (
            <div className="text-xs text-foreground-400 font-mono truncate">{diff.filePath}</div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 text-xs font-mono">
          <span className="text-success">+{diff.additions}</span>
          <span className="text-danger">-{diff.deletions}</span>
        </div>
        <span className="text-xs text-foreground-400 flex-shrink-0" title={createdAt.toLocaleString()}>
          {formatRelativeTime(createdAt)}
        </span>
      </button>

      {isExpanded && (
        <div className="border-t border-divider overflow-x-auto">
          <pre className="text-xs font-mono p-3 leading-relaxed">
            {diff.diff.split('\n').map((line, index) => (
              <div
                key={index}
                className={cn(
                  'px-1',
                  line.startsWith('+') && !line.startsWith('+++') && 'bg-success/10 text-success',
                  line.startsWith('-') && !line.startsWith('---') && 'bg-danger/10 text-danger',
                  (line.startsWith('+++') || line.startsWith('---')) && 'text-foreground-400',
                  line.startsWith('@@') && 'text-accent'
                )}
              >
                {line || ' '}
              </div>
            ))}
          </pre>
        </div>
      )}
    </article>
  );
}
