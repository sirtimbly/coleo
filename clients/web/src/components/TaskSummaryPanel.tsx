/**
 * TaskSummaryPanel - shows the running log of work-in-progress summaries
 * that arms/brain record as they work on a task. The most recent entry is
 * highlighted as the "current" summary; older entries form a timeline.
 */
import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Bot, Brain, User, FileText } from 'lucide-react';
import { Button, Chip } from '@heroui/react';
import { api, type TaskSummary } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useWebSocket, type WebSocketMessage } from '@/hooks/useWebSocket';
import { isJsonObject } from '@/lib/api';

interface TaskSummaryPanelProps {
  taskId: string;
  className?: string;
  onSummaryCountChange?: (count: number) => void;
}

const AUTHOR_CONFIG = {
  human: { icon: User, label: 'Human', textClass: 'text-accent', bgClass: 'bg-accent/10' },
  arm: { icon: Bot, label: 'Arm', textClass: 'text-success', bgClass: 'bg-success/10' },
  brain: { icon: Brain, label: 'Brain', textClass: 'text-secondary', bgClass: 'bg-secondary/10' },
} as const;

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

export function TaskSummaryPanel({ taskId, className, onSummaryCountChange }: TaskSummaryPanelProps) {
  const [summaries, setSummaries] = useState<TaskSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSummaries = useCallback(async () => {
    try {
      const result = await api.getTaskSummaries(taskId, { limit: 100 });
      setSummaries(result.summaries);
      setError(null);
      onSummaryCountChange?.(result.summaries.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load summaries');
    } finally {
      setIsLoading(false);
    }
  }, [taskId, onSummaryCountChange]);

  const handleWSMessage = useCallback(
    (msg: WebSocketMessage) => {
      if (msg.channel !== 'tasks' || !isJsonObject(msg.data)) return;
      const taskIdValue = msg.data.taskId;
      if (typeof taskIdValue !== 'string' || taskIdValue !== taskId) return;
      if (msg.event === 'summary.created' || msg.event === 'summary.updated') {
        fetchSummaries();
      }
    },
    [taskId, fetchSummaries]
  );

  useWebSocket({ channels: ['tasks'], onMessage: handleWSMessage });

  useEffect(() => {
    setIsLoading(true);
    fetchSummaries();
  }, [taskId]); // eslint-disable-line react-hooks/exhaustive-deps

  const latest = summaries[0];
  const history = summaries.slice(1);

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {error && (
        <div className="px-4 py-2 bg-danger/10 border-b border-danger/30">
          <p className="text-sm text-danger">{error}</p>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2].map((i) => (
              <div key={i} className="p-3 bg-content2 border border-divider rounded-lg animate-pulse">
                <div className="w-32 h-4 bg-content3 rounded mb-2" />
                <div className="w-full h-12 bg-content3 rounded" />
              </div>
            ))}
          </div>
        ) : summaries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-8">
            <FileText className="h-12 w-12 text-foreground-400 mb-3" />
            <p className="text-sm text-foreground-500">No work summary yet</p>
            <p className="text-xs text-foreground-400 mt-1">
              As arms and the brain work on this task, progress summaries will appear here.
            </p>
          </div>
        ) : (
          <>
            {latest && (
              <div>
                <h5 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-foreground-500">
                  Current summary
                </h5>
                <SummaryCard summary={latest} highlighted />
              </div>
            )}

            {history.length > 0 && (
              <div>
                <h5 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-foreground-500">
                  History
                </h5>
                <div className="space-y-2">
                  {history.map((summary) => (
                    <SummaryCard key={summary.id} summary={summary} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div className="border-t border-divider px-4 py-2 flex justify-end">
        <Button size="sm" variant="ghost" onPress={fetchSummaries}>
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          Refresh
        </Button>
      </div>
    </div>
  );
}

function SummaryCard({ summary, highlighted }: { summary: TaskSummary; highlighted?: boolean }) {
  const config = AUTHOR_CONFIG[summary.authorType];
  const Icon = config.icon;
  const createdAt = new Date(summary.createdAt);

  return (
    <article
      className={cn(
        'p-3 rounded-lg border',
        highlighted ? 'bg-accent/5 border-accent/30' : 'bg-content2 border-divider'
      )}
    >
      <div className="flex items-center gap-2 mb-2">
        <div className={cn('w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0', config.bgClass)}>
          <Icon className={cn('h-3.5 w-3.5', config.textClass)} />
        </div>
        <span className={cn('text-sm font-medium', config.textClass)}>
          {summary.authorName || summary.authorId}
        </span>
        <Chip size="sm" variant="soft" className={cn('h-5 text-xs', config.bgClass, config.textClass)}>
          {config.label}
        </Chip>
        <span className="text-xs text-foreground-400" title={createdAt.toLocaleString()}>
          {formatRelativeTime(createdAt)}
        </span>
        {summary.updatedAt !== summary.createdAt && (
          <span className="text-xs text-foreground-400">(edited)</span>
        )}
      </div>
      <p className="readable-copy whitespace-pre-wrap">{summary.content}</p>
    </article>
  );
}
