import { useEffect, useState, useCallback } from 'react';
import { Plus, Clock, CheckCircle2, XCircle, AlertTriangle, Pause, PlayCircle, Trash2, RefreshCw, Pencil } from 'lucide-react';
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
  in_progress: { color: 'text-yellow-500', bgColor: 'bg-yellow-500/10', icon: PlayCircle, label: 'In Progress' },
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

function TaskPriorityBadge({ priority }: { priority: Task['priority'] }) {
  const config = PRIORITY_CONFIG[priority];
  return (
    <span className={cn('inline-flex items-center px-2 py-0.5 rounded text-xs font-medium', config.bgColor, config.color)}>
      {config.label}
    </span>
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

  const handleStatusChange = async (id: string, status: Task['status']) => {
    try {
      await api.updateTask(id, { status });
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update task');
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
    <div className="p-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Tasks</h1>
          <p className="text-muted-foreground">Brain-managed task queue</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => loadTasks()}
            className="flex items-center gap-2 px-3 py-2 text-muted-foreground hover:text-foreground rounded-md hover:bg-secondary transition-colors"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button 
            onClick={() => {
              setEditingTask(undefined);
              setIsModalOpen(true);
            }}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
          >
            <Plus className="h-4 w-4" />
            New Task
          </button>
        </div>
      </div>

      {/* Stats Bar */}
      <div className="flex items-center gap-4 p-4 bg-card border border-border rounded-lg">
        <div className="text-sm">
          <span className="text-muted-foreground">Total:</span>{' '}
          <span className="font-medium">{counts.total}</span>
        </div>
        <div className="h-4 w-px bg-border" />
        {Object.entries(counts.byStatus).map(([status, count]) => (
          <button
            key={status}
            onClick={() => setFilter(f => f.status === status ? {} : { ...f, status })}
            className={cn(
              "flex items-center gap-1.5 text-sm px-2 py-1 rounded transition-colors",
              filter.status === status ? "bg-secondary" : "hover:bg-secondary/50"
            )}
          >
            <span className={STATUS_CONFIG[status as Task['status']]?.color || 'text-muted-foreground'}>
              {count}
            </span>
            <span className="text-muted-foreground">{status.replace('_', ' ')}</span>
          </button>
        ))}
        {filter.status && (
          <button
            onClick={() => setFilter({})}
            className="text-xs text-muted-foreground hover:text-foreground ml-auto"
          >
            Clear filter
          </button>
        )}
      </div>

      {error && (
        <Card className="border-destructive">
          <CardContent className="py-4">
            <p className="text-destructive">{error}</p>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 bg-secondary rounded-lg animate-pulse" />
          ))}
        </div>
      ) : tasks.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground mb-4">No tasks found</p>
            <p className="text-sm text-muted-foreground">Tasks will appear here when created by the Brain or manually.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {statusOrder.map((status) => {
            const statusTasks = groupedTasks[status];
            if (!statusTasks || statusTasks.length === 0) return null;
            
            const config = STATUS_CONFIG[status];
            
            return (
              <div key={status}>
                <h2 className={cn("flex items-center gap-2 text-sm font-medium mb-3", config.color)}>
                  <config.icon className="h-4 w-4" />
                  {config.label}
                  <span className="text-muted-foreground">({statusTasks.length})</span>
                </h2>
                
                <div className="space-y-2">
                  {statusTasks.map((task) => (
                    <Card key={task.id} className={cn("transition-colors", config.bgColor)}>
                      <CardContent className="py-4">
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <h3 className="font-medium truncate">{task.subject}</h3>
                              <TaskPriorityBadge priority={task.priority} />
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
                          
                          <div className="flex items-center gap-1">
                            {/* Edit button */}
                            <button
                              onClick={() => {
                                setEditingTask(task);
                                setIsModalOpen(true);
                              }}
                              className="p-2 text-muted-foreground hover:text-blue-500 transition-colors"
                              title="Edit task"
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
                            {/* Quick status actions */}
                            {status === 'pending' && (
                              <button
                                onClick={() => handleStatusChange(task.id, 'in_progress')}
                                className="p-2 text-muted-foreground hover:text-green-500 transition-colors"
                                title="Start task"
                              >
                                <PlayCircle className="h-4 w-4" />
                              </button>
                            )}
                            {status === 'in_progress' && (
                              <button
                                onClick={() => handleStatusChange(task.id, 'completed')}
                                className="p-2 text-muted-foreground hover:text-green-500 transition-colors"
                                title="Mark complete"
                              >
                                <CheckCircle2 className="h-4 w-4" />
                              </button>
                            )}
                            {(status === 'in_progress' || status === 'claimed') && (
                              <button
                                onClick={() => handleStatusChange(task.id, 'blocked')}
                                className="p-2 text-muted-foreground hover:text-orange-500 transition-colors"
                                title="Mark blocked"
                              >
                                <AlertTriangle className="h-4 w-4" />
                              </button>
                            )}
                            <button
                              onClick={() => handleDelete(task.id)}
                              className="p-2 text-muted-foreground hover:text-destructive transition-colors"
                              title="Delete task"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

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
