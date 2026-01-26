import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Plus, Clock, CheckCircle2, XCircle, AlertTriangle, Pause, RefreshCw, ChevronUp, ChevronDown, MessageSquareText, Send, Sparkles, Tag, X } from 'lucide-react';
import { api, type Task, cn } from '@/lib';
import { TaskModal } from '@/components';
import { useWebSocket } from '@/hooks/useWebSocket';
import { TaskGrid } from '@/components/TaskGrid';
import type { TaskUpdate } from '@/components/TaskGridRow';

interface TaskEventData {
  task?: Task;
  taskId?: string;
  changes?: Partial<Task>;
}

type TaskLlmMessage = {
  role: 'user' | 'assistant';
  content: string;
  at: string;
};

type TaskLlmMeta = {
  originalPrompt?: string;
  generatedDescription?: string;
  history?: TaskLlmMessage[];
};

type TaskUiMeta = {
  tags?: string[];
  color?: string;
  bold?: boolean;
  llm?: TaskLlmMeta;
};


// Status configuration
const STATUS_CONFIG: Record<Task['status'], { color: string; bgColor: string; icon: React.ComponentType<{ className?: string }>; label: string }> = {
  in_progress: { color: 'text-yellow-500', bgColor: 'bg-yellow-500/10', icon: Clock, label: 'In Progress' },
  claimed: { color: 'text-blue-500', bgColor: 'bg-blue-500/10', icon: Clock, label: 'Claimed' },
  pending: { color: 'text-gray-500', bgColor: 'bg-gray-500/10', icon: Clock, label: 'Pending' },
  blocked: { color: 'text-orange-500', bgColor: 'bg-orange-500/10', icon: Pause, label: 'Blocked' },
  completed: { color: 'text-green-500', bgColor: 'bg-green-500/10', icon: CheckCircle2, label: 'Completed' },
  failed: { color: 'text-red-500', bgColor: 'bg-red-500/10', icon: XCircle, label: 'Failed' },
  cancelled: { color: 'text-gray-400', bgColor: 'bg-gray-400/10', icon: XCircle, label: 'Cancelled' },
};

// Priority configuration
const PRIORITY_CONFIG: Record<Task['priority'], { color: string; bgColor: string; label: string }> = {
  critical: { color: 'text-red-500', bgColor: 'bg-red-500/20', label: 'Critical' },
  high: { color: 'text-orange-500', bgColor: 'bg-orange-500/20', label: 'High' },
  normal: { color: 'text-blue-500', bgColor: 'bg-blue-500/20', label: 'Normal' },
  low: { color: 'text-gray-500', bgColor: 'bg-gray-500/20', label: 'Low' },
};

function TaskPriorityBadge({ priority, taskId, onPriorityChange }: { 
  priority: Task['priority']; 
  taskId: string;
  onPriorityChange: (taskId: string, newPriority: Task['priority']) => void;
}) {
  const config = PRIORITY_CONFIG[priority];
  
  const priorityOrder: Task['priority'][] = ['low', 'normal', 'high', 'critical'];
  const currentIndex = priorityOrder.indexOf(priority);
  const canIncrease = currentIndex < priorityOrder.length - 1;
  const canDecrease = currentIndex > 0;
  
  const handleIncrease = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (canIncrease) {
      onPriorityChange(taskId, priorityOrder[currentIndex + 1]);
    }
  };
  
  const handleDecrease = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (canDecrease) {
      onPriorityChange(taskId, priorityOrder[currentIndex - 1]);
    }
  };
  
  return (
    <div className="inline-flex items-center gap-0.5 group">
      {canIncrease && (
        <button
          type="button"
          onClick={handleIncrease}
          className="p-0.5 hover:bg-secondary rounded transition-colors opacity-0 group-hover:opacity-100"
          title="Increase priority"
        >
          <ChevronUp className="h-3 w-3" />
        </button>
      )}
      <span className={cn('inline-flex items-center px-2 py-0.5 rounded text-xs font-medium', config.bgColor, config.color)}>
        {config.label}
      </span>
      {canDecrease && (
        <button
          type="button"
          onClick={handleDecrease}
          className="p-0.5 hover:bg-secondary rounded transition-colors opacity-0 group-hover:opacity-100"
          title="Decrease priority"
        >
          <ChevronDown className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

export function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [counts, setCounts] = useState<{ total: number; byStatus: Record<string, number> }>({ total: 0, byStatus: {} });
  const [filter, setFilter] = useState<{ status?: string; priority?: string }>({});
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | undefined>(undefined);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [draftMessage, setDraftMessage] = useState('');
  const [isDiscussing, setIsDiscussing] = useState(false);

  const loadTasks = useCallback(async () => {
    try {
      const res = await api.listTasks(filter);
      setTasks(res.tasks);
      setCounts(res.counts);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, [filter]);
  
  const getTaskUiMeta = useCallback((task: Task): TaskUiMeta => {
    const meta = (task.metadata ?? {}) as Record<string, unknown>;
    const ui = (meta.ui ?? {}) as Record<string, unknown>;
    return {
      tags: Array.isArray(ui.tags) ? (ui.tags as string[]) : [],
      color: typeof ui.color === 'string' ? (ui.color as string) : 'slate',
      bold: Boolean(ui.bold),
      llm: (ui.llm ?? {}) as TaskLlmMeta,
    };
  }, []);

  const availableTags = useMemo(() => {
    const tagSet = new Set<string>();
    tasks.forEach((task) => {
      getTaskUiMeta(task).tags?.forEach((tag) => {
        tagSet.add(tag);
      });
    });
    return Array.from(tagSet).sort((a, b) => a.localeCompare(b));
  }, [tasks, getTaskUiMeta]);

  const filteredTasks = useMemo(() => {
    if (tagFilter.length === 0) return tasks;
    return tasks.filter((task) => {
      const tags = getTaskUiMeta(task).tags ?? [];
      return tagFilter.some((tag) => tags.includes(tag));
    });
  }, [tasks, tagFilter, getTaskUiMeta]);

  const handleUpdateTask = useCallback(async (taskId: string, updates: TaskUpdate) => {
    let previousStatus: Task['status'] | null = null;
    setTasks((prev) => prev.map((task) => {
      if (task.id === taskId) {
        previousStatus = task.status;
        return { ...task, ...updates };
      }
      return task;
    }));

    if (updates.status && previousStatus && updates.status !== previousStatus) {
      const fromStatus = previousStatus as Task['status'];
      const toStatus = updates.status as Task['status'];
      setCounts((prev) => {
        const nextByStatus = { ...prev.byStatus };
        nextByStatus[fromStatus] = Math.max(0, (nextByStatus[fromStatus] ?? 0) - 1);
        nextByStatus[toStatus] = (nextByStatus[toStatus] ?? 0) + 1;
        return { total: prev.total, byStatus: nextByStatus };
      });
    }
    try {
      await api.updateTask(taskId, updates);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update task');
      loadTasks();
    }
  }, [loadTasks]);

  const handleUpdateUi = useCallback(async (taskId: string, updates: TaskUiMeta) => {
    const target = tasks.find((task) => task.id === taskId);
    if (!target) return;
    const currentUi = getTaskUiMeta(target);
    const nextUi: TaskUiMeta = {
      ...currentUi,
      ...updates,
      tags: updates.tags ?? currentUi.tags,
      llm: updates.llm ? { ...currentUi.llm, ...updates.llm } : currentUi.llm,
    };
    const nextMetadata = {
      ...(target.metadata ?? {}),
      ui: nextUi,
    } as Record<string, unknown>;

    setTasks((prev) => prev.map((task) => (task.id === taskId ? { ...task, metadata: nextMetadata } : task)));
    try {
      await api.updateTask(taskId, { metadata: nextMetadata });
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update task');
      loadTasks();
    }
  }, [tasks, getTaskUiMeta, loadTasks]);

  const handleCreateTaskAt = useCallback(async (index: number, subject: string) => {
    const now = new Date().toISOString();
    const llmMeta: TaskLlmMeta = {
      originalPrompt: subject,
      generatedDescription: `LLM draft: ${subject}`,
      history: [
        { role: 'user', content: subject, at: now },
        { role: 'assistant', content: 'LLM stub: detailed description will appear here.', at: now },
      ],
    };
    try {
      const result = await api.createTask({
        subject,
        description: llmMeta.generatedDescription ?? subject,
        priority: 'normal',
        metadata: { ui: { tags: [], bold: false, color: 'slate', llm: llmMeta } },
      });
      setTasks((prev) => {
        const next = [...prev];
        next.splice(index, 0, result.task);
        return next;
      });
      setCounts((prev) => ({
        total: prev.total + 1,
        byStatus: {
          ...prev.byStatus,
          [result.task.status]: (prev.byStatus[result.task.status] ?? 0) + 1,
        },
      }));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to create task');
    }
  }, []);

  const handleReorder = useCallback((fromIndex: number, toIndex: number) => {
    setTasks((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      if (!moved) return prev;
      next.splice(toIndex, 0, moved);
      return next;
    });
  }, []);

  const handleOpenDetails = useCallback((task: Task) => {
    setSelectedTask(task);
    setDraftMessage('');
  }, []);

  const toggleTagFilter = useCallback((tag: string) => {
    setTagFilter((prev) => (prev.includes(tag) ? prev.filter((item) => item !== tag) : [...prev, tag]));
  }, []);

  const handleSendDiscussion = useCallback(async () => {
    if (!selectedTask) return;
    const message = draftMessage.trim();
    if (!message) return;

    setIsDiscussing(true);
    const now = new Date().toISOString();
    const currentUi = getTaskUiMeta(selectedTask);
    const history = currentUi.llm?.history ?? [];
    const assistantReply = `LLM stub: expanded notes for "${message}".`;

    const nextLlm: TaskLlmMeta = {
      originalPrompt: currentUi.llm?.originalPrompt ?? selectedTask.subject,
      generatedDescription: currentUi.llm?.generatedDescription ?? selectedTask.description,
      history: [
        ...history,
        { role: 'user', content: message, at: now },
        { role: 'assistant', content: assistantReply, at: now },
      ],
    };

    try {
      await handleUpdateUi(selectedTask.id, { llm: nextLlm });
      setDraftMessage('');
    } finally {
      setIsDiscussing(false);
    }
  }, [selectedTask, draftMessage, getTaskUiMeta, handleUpdateUi]);

  useEffect(() => {
    if (!selectedTask) return;
    const latest = tasks.find((task) => task.id === selectedTask.id) || null;
    setSelectedTask(latest);
  }, [tasks, selectedTask]);

  useEffect(() => {
    if (selectedTask) {
      setDraftMessage('');
    }
  }, [selectedTask]);

  // Handle WebSocket messages for real-time updates
  const handleWSMessage = useCallback((msg: { channel?: string; event?: string; data?: unknown }) => {
    if (msg.channel !== 'tasks' || !msg.event || !msg.data) return;

    const data = msg.data as TaskEventData;

    switch (msg.event) {
      case 'task.created':
        // Reload to get full task with arm name
        loadTasks();
        break;

      case 'task.updated':
        if (data.taskId && data.changes) {
          setTasks((prev) =>
            prev.map((task) => (task.id === data.taskId ? { ...task, ...data.changes } : task))
          );
        } else {
          // Reload if we don't have all the info
          loadTasks();
        }
        break;

      case 'task.deleted':
        if (data.taskId) {
          setTasks((prev) => prev.filter((task) => task.id !== data.taskId));
        }
        break;
    }
  }, [loadTasks]);

  // Subscribe to tasks channel
  useWebSocket({
    channels: ['tasks'],
    onMessage: handleWSMessage,
  });

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  const handlePriorityChange = async (taskId: string, newPriority: Task['priority']) => {
    try {
      await api.updateTask(taskId, { priority: newPriority });
      // Update local state optimistically
      setTasks((prev) =>
        prev.map((task) => (task.id === taskId ? { ...task, priority: newPriority } : task))
      );
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update priority');
      loadTasks(); // Reload on error
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header with filters and actions */}
      <div className="border-b border-border px-4 py-3 bg-muted/50">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center space-x-2">
            <h1 className="text-lg font-semibold">Tasks</h1>
            <span className="text-sm text-muted-foreground">Brain-managed task queue</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => loadTasks()}
              className="inline-flex items-center px-3 py-2 border border-border rounded-md text-sm font-medium text-muted-foreground bg-card hover:bg-secondary hover:text-secondary-foreground"
              title="Refresh"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                setEditingTask(undefined);
                setIsModalOpen(true);
              }}
              className="inline-flex items-center gap-2 px-3 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors text-sm"
            >
              <Plus className="h-4 w-4" />
              New Task
            </button>
          </div>
        </div>

        {/* Compact filter bar */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Total:</span>
            <span className="font-medium">{counts.total}</span>
          </div>
          <div className="h-4 w-px bg-border" />
          <div className="flex items-center gap-2 flex-wrap">
            {Object.entries(counts.byStatus).map(([status, count]) => (
              <button
                type="button"
                key={status}
                onClick={() => setFilter(f => f.status === status ? {} : { ...f, status })}
                className={cn(
                  "inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors",
                  filter.status === status 
                    ? "bg-primary text-primary-foreground" 
                    : "bg-card border border-border hover:bg-secondary"
                )}
              >
                <span className={filter.status === status ? "" : STATUS_CONFIG[status as Task['status']]?.color || 'text-muted-foreground'}>
                  {status.replace('_', ' ')}
                </span>
                <span>{count}</span>
              </button>
            ))}
            {filter.status && (
              <button
                type="button"
                onClick={() => setFilter({})}
                className="text-xs text-muted-foreground hover:text-foreground px-2 py-1"
              >
                Clear filter
              </button>
            )}
          </div>
        </div>

        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Tag className="h-3.5 w-3.5" />
            <span>Tags</span>
          </div>
          {availableTags.length === 0 ? (
            <span className="text-xs text-muted-foreground">No tags yet</span>
          ) : (
            availableTags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => toggleTagFilter(tag)}
                className={cn(
                  'inline-flex items-center px-2 py-0.5 rounded-full text-xs border transition-colors',
                  tagFilter.includes(tag)
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-card border-border text-muted-foreground hover:text-foreground'
                )}
              >
                {tag}
              </button>
            ))
          )}
          {tagFilter.length > 0 && (
            <button
              type="button"
              onClick={() => setTagFilter([])}
              className="text-xs text-muted-foreground hover:text-foreground px-2 py-1"
            >
              Clear tags
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="p-4 bg-destructive/10 text-destructive border-b border-destructive/20">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            <span className="text-sm">{error}</span>
          </div>
        </div>
      )}

      {/* Content area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Task list */}
        <div className="flex-1 overflow-auto">
            {loading ? (
              <div className="p-4 space-y-4">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-24 bg-secondary rounded-lg animate-pulse" />
                ))}
              </div>
            ) : (
              <div className="p-4">
                <TaskGrid 
                  tasks={filteredTasks} 
                  availableTags={availableTags}
                  selectedTaskId={selectedTask?.id} 
                  onOpenDetails={handleOpenDetails}
                  onUpdateTask={handleUpdateTask}
                  onUpdateUi={handleUpdateUi}
                  onCreateTaskAt={handleCreateTaskAt}
                  onReorder={handleReorder}
                />
              </div>
            )}
        </div>

        {/* Task details sidebar */}
        {selectedTask && (
            <aside className="w-80 border-l border-border bg-card overflow-auto">
              <div className="p-4 border-b border-border">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">
                    Task Details
                  </h3>
                  <button
                    type="button"
                    onClick={() => setSelectedTask(null)}
                    className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted"
                    title="Close"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div className="p-4">
                <div className="space-y-4">
                  <div>
                    <h4 className="font-medium mb-2">{selectedTask.subject}</h4>
                    <TaskPriorityBadge 
                      priority={selectedTask.priority}
                      taskId={selectedTask.id}
                      onPriorityChange={handlePriorityChange}
                    />
                  </div>

                  <div>
                    <h5 className="text-sm font-medium text-muted-foreground mb-1">Original one-liner</h5>
                    <p className="text-sm">
                      {getTaskUiMeta(selectedTask).llm?.originalPrompt ?? selectedTask.subject}
                    </p>
                  </div>

                  <div>
                    <h5 className="text-sm font-medium text-muted-foreground mb-1 flex items-center gap-1">
                      <Sparkles className="h-3.5 w-3.5" />
                      LLM-generated description
                    </h5>
                    <p className="text-sm">
                      {getTaskUiMeta(selectedTask).llm?.generatedDescription ?? selectedTask.description}
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-muted-foreground">Status:</span>
                      <div className="flex items-center gap-1 mt-1">
                        {React.createElement(STATUS_CONFIG[selectedTask.status].icon, { className: 'h-3 w-3' })}
                        <span className={STATUS_CONFIG[selectedTask.status].color}>
                          {STATUS_CONFIG[selectedTask.status].label}
                        </span>
                      </div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Priority:</span>
                      <div className="mt-1">
                        <TaskPriorityBadge 
                          priority={selectedTask.priority}
                          taskId={selectedTask.id}
                          onPriorityChange={handlePriorityChange}
                        />
                      </div>
                    </div>
                  </div>

                  <div>
                    <h5 className="text-sm font-medium text-muted-foreground mb-1">Tags</h5>
                    <div className="flex flex-wrap gap-1">
                      {(getTaskUiMeta(selectedTask).tags ?? []).length === 0 ? (
                        <span className="text-xs text-muted-foreground">No tags</span>
                      ) : (
                        (getTaskUiMeta(selectedTask).tags ?? []).map((tag) => (
                          <span key={tag} className="text-xs px-2 py-0.5 bg-muted rounded-full">
                            {tag}
                          </span>
                        ))
                      )}
                    </div>
                  </div>

                  {selectedTask.assignedArmName && (
                    <div>
                      <span className="text-sm text-muted-foreground">Assigned to:</span>
                      <p className="text-sm font-medium">{selectedTask.assignedArmName}</p>
                    </div>
                  )}

                  <div className="border-t border-border pt-3">
                    <div className="flex items-center gap-2 mb-2 text-sm font-medium">
                      <MessageSquareText className="h-4 w-4" />
                      Discussion
                    </div>
                    <div className="space-y-2 max-h-48 overflow-auto">
                      {(getTaskUiMeta(selectedTask).llm?.history ?? []).length === 0 ? (
                        <p className="text-xs text-muted-foreground">No discussion yet.</p>
                      ) : (
                        (getTaskUiMeta(selectedTask).llm?.history ?? []).map((entry, index) => (
                          <div key={`${entry.at}-${index}`} className="text-xs">
                            <span className="font-medium capitalize">{entry.role}:</span>{' '}
                            <span className="text-muted-foreground">{entry.content}</span>
                          </div>
                        ))
                      )}
                    </div>
                    <div className="mt-3 space-y-2">
                      <textarea
                        value={draftMessage}
                        onChange={(event) => setDraftMessage(event.target.value)}
                        placeholder="Ask the LLM to expand or clarify..."
                        rows={3}
                        className="w-full rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                      <button
                        type="button"
                        onClick={handleSendDiscussion}
                        disabled={isDiscussing || !draftMessage.trim()}
                        className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded bg-primary text-primary-foreground disabled:opacity-50"
                      >
                        <Send className="h-3.5 w-3.5" />
                        {isDiscussing ? 'Sending...' : 'Send'}
                      </button>
                    </div>
                  </div>

                  <div className="text-xs text-muted-foreground">
                    Created {new Date(selectedTask.createdAt).toLocaleString()}
                  </div>
                </div>
              </div>
            </aside>
        )}
      </div>

      {/* Task Modal */}
      <TaskModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setEditingTask(undefined);
        }}
        onSaved={() => loadTasks()}
        task={editingTask}
      />
    </div>
  );
}
