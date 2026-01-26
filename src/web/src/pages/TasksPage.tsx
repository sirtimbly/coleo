import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Plus, Clock, CheckCircle2, XCircle, AlertTriangle, Pause, RefreshCw, ChevronUp, ChevronDown, MessageSquareText, Send, Sparkles, Tag, X } from 'lucide-react';
import { Button, Chip, Card, TextArea } from '@heroui/react';
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
  
  const handleIncrease = () => {
    if (canIncrease) {
      onPriorityChange(taskId, priorityOrder[currentIndex + 1]);
    }
  };
  
  const handleDecrease = () => {
    if (canDecrease) {
      onPriorityChange(taskId, priorityOrder[currentIndex - 1]);
    }
  };
  
  return (
    <div className="inline-flex items-center gap-0.5 group">
      {canIncrease && (
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          onPress={handleIncrease}
          className="opacity-0 group-hover:opacity-100 min-w-unit-6 w-unit-6 h-unit-6"
          aria-label="Increase priority"
        >
          <ChevronUp className="h-3 w-3" />
        </Button>
      )}
      <Chip size="sm" variant="soft" className={cn(config.color)}>
        {config.label}
      </Chip>
      {canDecrease && (
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          onPress={handleDecrease}
          className="opacity-0 group-hover:opacity-100 min-w-unit-6 w-unit-6 h-unit-6"
          aria-label="Decrease priority"
        >
          <ChevronDown className="h-3 w-3" />
        </Button>
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

  const handleRemoveTagFromTask = useCallback((taskId: string, tagToRemove: string) => {
    const target = tasks.find((task) => task.id === taskId);
    if (!target) return;
    const currentTags = getTaskUiMeta(target).tags ?? [];
    const nextTags = currentTags.filter((tag) => tag !== tagToRemove);
    handleUpdateUi(taskId, { tags: nextTags });
  }, [tasks, getTaskUiMeta, handleUpdateUi]);

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
      <div className="border-b px-4 py-3 bg-content2">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center space-x-2">
            <h1 className="text-lg font-semibold">Tasks</h1>
            <span className="text-sm text-foreground-500">Brain-managed task queue</span>
          </div>

          <div className="flex items-center gap-2">
            <Button
              isIconOnly
              variant="ghost"
              onPress={() => loadTasks()}
              aria-label="Refresh"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button
              variant="primary"
              onPress={() => {
                setEditingTask(undefined);
                setIsModalOpen(true);
              }}
            >
              <Plus className="h-4 w-4 mr-2" />
              New Task
            </Button>
          </div>
        </div>

        {/* Compact filter bar */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-foreground-500">Total:</span>
            <span className="font-medium">{counts.total}</span>
          </div>
          <div className="h-4 w-px bg-divider" />
          <div className="flex items-center gap-2 flex-wrap">
            {Object.entries(counts.byStatus).map(([status, count]) => (
              <Button
                key={status}
                size="sm"
                variant={filter.status === status ? "primary" : "ghost"}
                onPress={() => setFilter(f => f.status === status ? {} : { ...f, status })}
                className="h-7"
              >
                <span className={filter.status === status ? "" : STATUS_CONFIG[status as Task['status']]?.color || 'text-foreground-500'}>
                  {status.replace('_', ' ')}
                </span>
                <span>{count}</span>
              </Button>
            ))}
            {filter.status && (
              <Button
                size="sm"
                variant="ghost"
                onPress={() => setFilter({})}
              >
                Clear filter
              </Button>
            )}
          </div>
        </div>

        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1 text-xs text-foreground-500">
            <Tag className="h-3.5 w-3.5" />
            <span>Tags</span>
          </div>
          {availableTags.length === 0 ? (
            <span className="text-xs text-foreground-500">No tags yet</span>
          ) : (
            availableTags.map((tag) => (
              <Chip
                key={tag}
                size="sm"
                variant={tagFilter.includes(tag) ? "primary" : "soft"}
                onClick={() => toggleTagFilter(tag)}
                className="cursor-pointer"
              >
                {tag}
              </Chip>
            ))
          )}
          {tagFilter.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onPress={() => setTagFilter([])}
            >
              Clear tags
            </Button>
          )}
        </div>
      </div>

      {error && (
        <div className="p-4 bg-danger/10 text-danger border-b border-danger/20">
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
                  <Card key={i} className="h-24">
                    <Card.Content className="animate-pulse bg-default-100" />
                  </Card>
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
          <Card className="w-80 border-l rounded-none shadow-none">
            <Card.Content className="overflow-auto">
              <div className="p-4 border-b">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-sm text-foreground-500 uppercase tracking-wide">
                    Task Details
                  </h3>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    onPress={() => setSelectedTask(null)}
                    aria-label="Close"
                  >
                    <X className="h-4 w-4" />
                  </Button>
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
                    <h5 className="text-sm font-medium text-foreground-500 mb-1">Original one-liner</h5>
                    <p className="text-sm">
                      {getTaskUiMeta(selectedTask).llm?.originalPrompt ?? selectedTask.subject}
                    </p>
                  </div>

                  <div>
                    <h5 className="text-sm font-medium text-foreground-500 mb-1 flex items-center gap-1">
                      <Sparkles className="h-3.5 w-3.5" />
                      LLM-generated description
                    </h5>
                    <p className="text-sm">
                      {getTaskUiMeta(selectedTask).llm?.generatedDescription ?? selectedTask.description}
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-foreground-500">Status:</span>
                      <div className="flex items-center gap-1 mt-1">
                        {React.createElement(STATUS_CONFIG[selectedTask.status].icon, { className: 'h-3 w-3' })}
                        <span className={STATUS_CONFIG[selectedTask.status].color}>
                          {STATUS_CONFIG[selectedTask.status].label}
                        </span>
                      </div>
                    </div>
                    <div>
                      <span className="text-foreground-500">Priority:</span>
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
                    <h5 className="text-sm font-medium text-foreground-500 mb-1">Tags</h5>
                    <div className="flex flex-wrap gap-1">
                      {(getTaskUiMeta(selectedTask).tags ?? []).length === 0 ? (
                        <span className="text-xs text-foreground-500">No tags</span>
                      ) : (
                        (getTaskUiMeta(selectedTask).tags ?? []).map((tag) => (
                          <Chip key={tag} size="sm" variant="soft" className="pr-1 gap-1 group hover:bg-default-200 transition-colors cursor-default">
                            {tag}
                            <button
                              type="button"
                              onClick={() => handleRemoveTagFromTask(selectedTask.id, tag)}
                              className="ml-0.5 p-0.5 rounded-full hover:bg-danger-100 hover:text-danger transition-colors cursor-pointer opacity-60 group-hover:opacity-100"
                              aria-label={`Remove tag ${tag}`}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </Chip>
                        ))
                      )}
                    </div>
                  </div>

                  {selectedTask.assignedArmName && (
                    <div>
                      <span className="text-sm text-foreground-500">Assigned to:</span>
                      <p className="text-sm font-medium">{selectedTask.assignedArmName}</p>
                    </div>
                  )}

                  <div className="border-t pt-3">
                    <div className="flex items-center gap-2 mb-2 text-sm font-medium">
                      <MessageSquareText className="h-4 w-4" />
                      Discussion
                    </div>
                    <div className="space-y-2 max-h-48 overflow-auto">
                      {(getTaskUiMeta(selectedTask).llm?.history ?? []).length === 0 ? (
                        <p className="text-xs text-foreground-500">No discussion yet.</p>
                      ) : (
                        (getTaskUiMeta(selectedTask).llm?.history ?? []).map((entry, index) => (
                          <div key={`${entry.at}-${index}`} className="text-xs">
                            <span className="font-medium capitalize">{entry.role}:</span>{' '}
                            <span className="text-foreground-500">{entry.content}</span>
                          </div>
                        ))
                      )}
                    </div>
                    <div className="mt-3 space-y-2">
                      <TextArea
                        value={draftMessage}
                        onChange={(e) => setDraftMessage(e.target.value)}
                        placeholder="Ask the LLM to expand or clarify..."
                        rows={3}
                        className="text-sm"
                      />
                      <Button
                        size="sm"
                        variant="primary"
                        onPress={handleSendDiscussion}
                        isDisabled={isDiscussing || !draftMessage.trim()}
                      >
                        <Send className="h-3.5 w-3.5 mr-1" />
                        {isDiscussing ? 'Sending...' : 'Send'}
                      </Button>
                    </div>
                  </div>

                  <div className="text-xs text-foreground-500">
                    Created {new Date(selectedTask.createdAt).toLocaleString()}
                  </div>
                </div>
              </div>
            </Card.Content>
          </Card>
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
