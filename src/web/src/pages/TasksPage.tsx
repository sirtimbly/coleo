import React, { useEffect, useState, useCallback } from 'react';
import { Plus, Clock, CheckCircle2, XCircle, AlertTriangle, Pause, Trash2, RefreshCw, Pencil, ListTodo, ChevronUp, ChevronDown, Square, CheckSquare, Undo2 } from 'lucide-react';
import { api, type Task, cn } from '@/lib';
import { Card, CardContent, TaskModal } from '@/components';
import { useWebSocket } from '@/hooks/useWebSocket';

interface TaskEventData {
  task?: Task;
  taskId?: string;
  changes?: Partial<Task>;
}

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
  const [isHovered, setIsHovered] = useState(false);
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
    <div 
      className="inline-flex items-center gap-0.5 group"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {isHovered && canIncrease && (
        <button
          onClick={handleIncrease}
          className="p-0.5 hover:bg-secondary rounded transition-colors"
          title="Increase priority"
        >
          <ChevronUp className="h-3 w-3" />
        </button>
      )}
      <span className={cn('inline-flex items-center px-2 py-0.5 rounded text-xs font-medium', config.bgColor, config.color)}>
        {config.label}
      </span>
      {isHovered && canDecrease && (
        <button
          onClick={handleDecrease}
          className="p-0.5 hover:bg-secondary rounded transition-colors"
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
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | undefined>(undefined);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
  const [isReleasing, setIsReleasing] = useState(false);

  const loadTasks = async () => {
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
  };

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
  }, [filter]);

  // Subscribe to tasks channel
  useWebSocket({
    channels: ['tasks'],
    onMessage: handleWSMessage,
  });

  useEffect(() => {
    loadTasks();
  }, [filter]);

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this task?')) return;
    try {
      await api.deleteTask(id);
      loadTasks();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete task');
    }
  };

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

  // Toggle selection of a single task
  const toggleTaskSelection = (taskId: string) => {
    setSelectedTaskIds(prev => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  };

  // Toggle selection of all tasks in a status group
  const toggleAllInStatus = (status: string) => {
    const statusTasks = groupedTasks[status] || [];
    const statusTaskIds = statusTasks.map(t => t.id);
    const allSelected = statusTaskIds.every(id => selectedTaskIds.has(id));
    
    setSelectedTaskIds(prev => {
      const next = new Set(prev);
      if (allSelected) {
        // Deselect all in this status
        statusTaskIds.forEach(id => next.delete(id));
      } else {
        // Select all in this status
        statusTaskIds.forEach(id => next.add(id));
      }
      return next;
    });
  };

  // Release selected claimed tasks (set status to pending, clear assignedTo)
  const handleReleaseSelected = async () => {
    const claimedTasks = (groupedTasks['claimed'] || []).filter(t => selectedTaskIds.has(t.id));
    if (claimedTasks.length === 0) {
      alert('No claimed tasks selected');
      return;
    }
    
    if (!confirm(`Release ${claimedTasks.length} claimed task(s) back to pending?`)) return;
    
    setIsReleasing(true);
    try {
      await Promise.all(
        claimedTasks.map(task => 
          api.updateTask(task.id, { status: 'pending', assignedTo: null })
        )
      );
      setSelectedTaskIds(new Set());
      loadTasks();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to release tasks');
    } finally {
      setIsReleasing(false);
    }
  };

  // Group tasks by status for display
  const groupedTasks = tasks.reduce((acc, task) => {
    if (!acc[task.status]) acc[task.status] = [];
    acc[task.status].push(task);
    return acc;
  }, {} as Record<string, Task[]>);

  const statusOrder: Task['status'][] = ['in_progress', 'claimed', 'pending', 'blocked', 'completed', 'failed', 'cancelled'];

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
              onClick={() => loadTasks()}
              className="inline-flex items-center px-3 py-2 border border-border rounded-md text-sm font-medium text-muted-foreground bg-card hover:bg-secondary hover:text-secondary-foreground"
              title="Refresh"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
            <button
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
                onClick={() => setFilter({})}
                className="text-xs text-muted-foreground hover:text-foreground px-2 py-1"
              >
                Clear filter
              </button>
            )}
          </div>
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
            ) : tasks.length === 0 ? (
              <div className="flex items-center justify-center h-full p-8">
                <div className="text-center text-muted-foreground">
                  <ListTodo className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p className="mb-2">No tasks found</p>
                  <p className="text-sm">Tasks will appear here when created by the Brain or manually.</p>
                </div>
              </div>
            ) : (
              <div className="p-4 space-y-4">
                {statusOrder.map((status) => {
                  const statusTasks = groupedTasks[status];
                  if (!statusTasks || statusTasks.length === 0) return null;

                  const config = STATUS_CONFIG[status];

                  return (
                    <div key={status}>
                      <div className="flex items-center justify-between mb-3">
                        <h2 className={cn("flex items-center gap-2 text-sm font-medium", config.color)}>
                          {status === 'claimed' && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleAllInStatus(status);
                              }}
                              className="p-0.5 hover:bg-secondary rounded transition-colors"
                              title={statusTasks.every(t => selectedTaskIds.has(t.id)) ? "Deselect all" : "Select all"}
                            >
                              {statusTasks.every(t => selectedTaskIds.has(t.id)) ? (
                                <CheckSquare className="h-4 w-4" />
                              ) : (
                                <Square className="h-4 w-4" />
                              )}
                            </button>
                          )}
                          <config.icon className="h-4 w-4" />
                          {config.label}
                          <span className="text-muted-foreground">({statusTasks.length})</span>
                        </h2>
                        {status === 'claimed' && selectedTaskIds.size > 0 && (
                          <button
                            onClick={handleReleaseSelected}
                            disabled={isReleasing}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded bg-orange-500/20 text-orange-500 hover:bg-orange-500/30 transition-colors disabled:opacity-50"
                          >
                            <Undo2 className="h-3 w-3" />
                            {isReleasing ? 'Releasing...' : `Release ${[...selectedTaskIds].filter(id => (groupedTasks['claimed'] || []).some(t => t.id === id)).length} Selected`}
                          </button>
                        )}
                      </div>

                       <div className="space-y-2">
                        {statusTasks.map((task) => (
                          <div
                            key={task.id}
                            className={cn(
                              "transition-colors cursor-pointer group",
                              selectedTask?.id === task.id ? "ring-2 ring-primary rounded-lg" : ""
                            )}
                            onClick={() => setSelectedTask(selectedTask?.id === task.id ? null : task)}
                          >
                            <Card
                              className={cn("transition-colors", config.bgColor)}
                            >
                            <CardContent className="py-4">
                              <div className="flex items-start justify-between gap-4">
                                {/* Checkbox for claimed tasks */}
                                {status === 'claimed' && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      toggleTaskSelection(task.id);
                                    }}
                                    className="mt-0.5 p-0.5 hover:bg-secondary rounded transition-colors flex-shrink-0"
                                  >
                                    {selectedTaskIds.has(task.id) ? (
                                      <CheckSquare className="h-4 w-4 text-primary" />
                                    ) : (
                                      <Square className="h-4 w-4 text-muted-foreground" />
                                    )}
                                  </button>
                                )}
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 mb-1">
                                    <h3 className="font-medium truncate">{task.subject}</h3>
                                    <TaskPriorityBadge 
                                      priority={task.priority} 
                                      taskId={task.id}
                                      onPriorityChange={handlePriorityChange}
                                    />
                                    {task.domain && (
                                      <span className="text-xs px-2 py-0.5 bg-secondary rounded text-muted-foreground">
                                        {task.domain}
                                      </span>
                                    )}
                                  </div>

                                  <p className="text-sm text-muted-foreground line-clamp-2 mb-2">
                                    {task.description}
                                  </p>

                                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                                    {task.assignedArmName && (
                                      <span className="flex items-center gap-1">
                                        <span className="text-foreground font-medium">{task.assignedArmName}</span>
                                      </span>
                                    )}
                                    {task.phase && (
                                      <span>Phase: {task.phase}</span>
                                    )}
                                    {task.sourceType !== 'manual' && (
                                      <span>Source: {task.sourceType}</span>
                                    )}
                                    <span>Created {new Date(task.createdAt).toLocaleDateString()}</span>
                                   </div>
                                </div>

                                {/* Card actions - visible on hover */}
                                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setEditingTask(task);
                                      setIsModalOpen(true);
                                    }}
                                    className="p-2 text-muted-foreground hover:text-foreground hover:bg-secondary rounded transition-colors"
                                    title="Edit task"
                                  >
                                    <Pencil className="h-4 w-4" />
                                  </button>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleDelete(task.id);
                                    }}
                                    className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded transition-colors"
                                    title="Delete task"
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </button>
                                </div>
                              </div>
                            </CardContent>
                            </Card>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
        </div>

        {/* Task details sidebar */}
        {selectedTask && (
            <aside className="w-80 border-l border-border bg-card overflow-auto">
              <div className="p-4 border-b border-border">
                <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">
                  Task Details
                </h3>
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
                    <h5 className="text-sm font-medium text-muted-foreground mb-1">Description</h5>
                    <p className="text-sm">{selectedTask.description}</p>
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

                  {selectedTask.assignedArmName && (
                    <div>
                      <span className="text-sm text-muted-foreground">Assigned to:</span>
                      <p className="text-sm font-medium">{selectedTask.assignedArmName}</p>
                    </div>
                  )}

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
