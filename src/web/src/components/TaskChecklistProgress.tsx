import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Circle } from 'lucide-react';

import { useWebSocket, type WebSocketMessage } from '@/hooks/useWebSocket';
import { api, isJsonObject, type ChecklistItem } from '@/lib/api';
import { cn } from '@/lib';
import { ProgressBar } from './ProgressBar';

interface TaskChecklistProgressProps {
  taskId: string;
  className?: string;
}

export function TaskChecklistProgress({ taskId, className }: TaskChecklistProgressProps) {
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const response = await api.getTaskChecklist(taskId);
      setItems(response.items);
    } finally {
      setIsLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    setIsLoading(true);
    void refresh();
    const interval = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const onMessage = useCallback((message: WebSocketMessage) => {
    if (message.channel !== 'tasks' || !isJsonObject(message.data)) return;
    if (message.data.taskId === taskId) void refresh();
  }, [refresh, taskId]);
  useWebSocket({ channels: ['tasks'], onMessage, autoConnect: true });

  if (isLoading) {
    return <div className={cn('h-12 animate-pulse rounded-md bg-surface-secondary', className)} />;
  }
  if (items.length === 0) {
    return <p className={cn('text-xs text-muted-foreground', className)}>No sub-tasks defined.</p>;
  }

  const completed = items.filter((item) => item.completed).length;
  const percent = Math.round((completed / items.length) * 100);

  return (
    <section className={cn('rounded-md border border-border/60 bg-surface-secondary/40 p-3', className)} aria-label="Sub-task progress">
      <div className="mb-2 flex items-center justify-between gap-3 text-xs">
        <span className="font-semibold uppercase tracking-wide text-muted-foreground">Sub-tasks</span>
        <span className="tabular-nums text-muted-foreground">{completed}/{items.length} complete</span>
      </div>
      <ProgressBar percent={percent} showLabel={false} size="sm" />
      <ul className="mt-3 space-y-1.5">
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-2 text-xs">
            {item.completed ? (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />
            ) : (
              <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <span className={cn('min-w-0 truncate', item.completed && 'text-muted-foreground line-through')}>
              {item.text}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
