import { useEffect, useState, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Eye, Radio, Wrench, CheckCircle2, XCircle, Clock, Loader2,
  ChevronDown, ChevronRight, FileEdit, Terminal, AlertTriangle,
  MessageSquare, GitBranch, ListTodo, Zap, Bot, Coins, Trash2,
  RefreshCw, Maximize2, Minimize2
} from 'lucide-react';
import { api, type Arm, type ArmTodo, type OpenCodeEvent } from '@/lib';
import { StatusBadge } from '@/components';
import { useArmEvents, useWebSocket } from '@/hooks';

// Activity item types for the log
type ActivityType = 
  | 'message' 
  | 'tool' 
  | 'file' 
  | 'session' 
  | 'error' 
  | 'todo' 
  | 'step'
  | 'terminal'
  | 'branch';

interface ActivityItem {
  id: string;
  type: ActivityType;
  title: string;
  subtitle?: string;
  status: 'pending' | 'running' | 'completed' | 'error' | 'info';
  timestamp: number;
  details?: Record<string, unknown>;
  expanded?: boolean;
}

interface ArmHistoryState {
  activities: ActivityItem[];
  todos: ArmTodo[];
  currentText: string;
  totalCost: number;
  totalTokens: { input: number; output: number };
  sessionStatus: string;
  lastUpdated: number;
}

const MAX_HISTORY_ITEMS = 200;
const STORAGE_PREFIX = 'octopai-arm-history-';

function getStorageKey(armId: string): string {
  return `${STORAGE_PREFIX}${armId}`;
}

function loadArmHistory(armId: string): ArmHistoryState | null {
  try {
    const key = getStorageKey(armId);
    const stored = localStorage.getItem(key);
    if (!stored) return null;
    
    const parsed = JSON.parse(stored) as ArmHistoryState;
    
    // Check if history is stale (older than 24 hours)
    if (Date.now() - parsed.lastUpdated > 24 * 60 * 60 * 1000) {
      localStorage.removeItem(key);
      return null;
    }
    
    return parsed;
  } catch {
    return null;
  }
}



function pruneOldHistories(): void {
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const keysToRemove: string[] = [];
    
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(STORAGE_PREFIX)) {
        const stored = localStorage.getItem(key);
        if (stored) {
          try {
            const parsed = JSON.parse(stored) as { lastUpdated: number };
            if (parsed.lastUpdated < cutoff) {
              keysToRemove.push(key);
            }
          } catch {
            keysToRemove.push(key);
          }
        }
      }
    }
    
    keysToRemove.forEach(key => localStorage.removeItem(key));
  } catch {
    // Ignore
  }
}

// Color schemes for different activity types
const activityColors: Record<ActivityType, { bg: string; border: string; icon: string }> = {
  message: { bg: 'bg-blue-500/10', border: 'border-l-blue-500', icon: 'text-blue-500' },
  tool: { bg: 'bg-purple-500/10', border: 'border-l-purple-500', icon: 'text-purple-500' },
  file: { bg: 'bg-green-500/10', border: 'border-l-green-500', icon: 'text-green-500' },
  session: { bg: 'bg-cyan-500/10', border: 'border-l-cyan-500', icon: 'text-cyan-500' },
  error: { bg: 'bg-red-500/10', border: 'border-l-red-500', icon: 'text-red-500' },
  todo: { bg: 'bg-yellow-500/10', border: 'border-l-yellow-500', icon: 'text-yellow-500' },
  step: { bg: 'bg-indigo-500/10', border: 'border-l-indigo-500', icon: 'text-indigo-500' },
  terminal: { bg: 'bg-orange-500/10', border: 'border-l-orange-500', icon: 'text-orange-500' },
  branch: { bg: 'bg-pink-500/10', border: 'border-l-pink-500', icon: 'text-pink-500' },
};

const activityIcons: Record<ActivityType, typeof Wrench> = {
  message: MessageSquare,
  tool: Wrench,
  file: FileEdit,
  session: Zap,
  error: AlertTriangle,
  todo: ListTodo,
  step: Bot,
  terminal: Terminal,
  branch: GitBranch,
};

export function ArmViewerPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedArmId = searchParams.get('arm');

  const [arms, setArms] = useState<Arm[]>([]);
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [todos, setTodos] = useState<ArmTodo[]>([]);
  const [sessionStatus, setSessionStatus] = useState<string>('unknown');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentText, setCurrentText] = useState<string>('');
  const [totalCost, setTotalCost] = useState<number>(0);
  const [totalTokens, setTotalTokens] = useState<{ input: number; output: number }>({ input: 0, output: 0 });
  const [panelWidth, setPanelWidth] = useState(400);
  const [isResizing, setIsResizing] = useState(false);
  const [viewerExpanded, setViewerExpanded] = useState(false);
  
  const activityEndRef = useRef<HTMLDivElement>(null);
  const activityIdCounter = useRef(0);

  // Generate unique activity ID
  const genId = () => `act-${++activityIdCounter.current}-${Date.now()}`;

  // Add or update activity
  const upsertActivity = useCallback((id: string, updates: Partial<ActivityItem> & { type: ActivityType; title: string }) => {
    setActivities(prev => {
      const idx = prev.findIndex(a => a.id === id);
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = { ...updated[idx], ...updates };
        return updated;
      }
      return [...prev, {
        id,
        status: 'info',
        timestamp: Date.now(),
        expanded: false,
        ...updates,
      }];
    });
  }, []);

  // Load arms list
  const loadArms = async () => {
    try {
      const res = await api.listArms();
      setArms(res.arms.filter(a => a.status !== 'stopped'));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load arms');
    } finally {
      setLoading(false);
    }
  };

  // Load todos for selected arm
  const loadTodos = async (armId: string) => {
    try {
      const res = await api.getArmTodos(armId);
      if (res.todos) {
        setTodos(res.todos);
      }
    } catch (err) {
      console.error('Failed to load todos:', err);
    }
  };

  // Handle SSE events from arm
  const handleArmEvent = useCallback((event: OpenCodeEvent) => {
    const { type, properties: props } = event;

    // Message events
    if (type === 'message.updated') {
      const info = props.info as { id: string; role: string } | undefined;
      if (info) {
        const role = info.role;
        const roleLabel = role === 'assistant' ? 'Assistant' : role === 'user' ? 'User' : 'System';
        upsertActivity(`msg-${info.id}`, {
          type: 'message',
          title: `${roleLabel} message`,
          status: 'running',
          details: { role, messageId: info.id },
        });
      }
    }

    // Text parts - use delta for incremental updates
    if (type === 'message.part.updated' || type === 'message.part.created') {
      const part = props.part as { 
        id?: string;
        type: string; 
        text?: string; 
        tool?: string; 
        state?: { 
          status: string; 
          title?: string; 
          input?: Record<string, unknown>; 
          output?: string; 
          error?: string; 
          time?: { start: number; end: number } 
        } 
      } | undefined;
      const delta = props.delta as string | undefined;
      
      if (part) {
        // Text content - use delta for updates, full text for creates
        if (part.type === 'text') {
          if (delta) {
            // Append delta to current text
            setCurrentText(prev => prev + delta);
          } else if (type === 'message.part.created' && part.text) {
            // New text part, set initial text
            setCurrentText(part.text);
          }
        }

        // Tool calls
        if (part.type === 'tool' && part.tool) {
          const state = part.state;
          const status = state?.status || 'pending';
          const title = state?.title || part.tool;
          // Use part.id if available for stable key, otherwise generate one
          const toolId = part.id || `tool-${part.tool}-${Date.now()}`;
          
          let actStatus: ActivityItem['status'] = 'pending';
          if (status === 'running') actStatus = 'running';
          else if (status === 'completed') actStatus = 'completed';
          else if (status === 'error') actStatus = 'error';

          upsertActivity(toolId, {
            type: 'tool',
            title: title,
            subtitle: part.tool,
            status: actStatus,
            details: {
              tool: part.tool,
              input: state?.input,
              output: state?.output,
              error: state?.error,
              duration: state?.time ? (state.time.end - state.time.start) : undefined,
            },
          });
        }

        // Step finish - contains cost/token info
        if (part.type === 'step-finish') {
          const stepPart = part as unknown as { 
            cost?: number; 
            tokens?: { input: number; output: number; reasoning?: number; cache?: { read: number; write: number } };
            reason?: string;
          };
          
          if (stepPart.cost) {
            setTotalCost(prev => prev + stepPart.cost!);
          }
          if (stepPart.tokens) {
            setTotalTokens(prev => ({
              input: prev.input + stepPart.tokens!.input,
              output: prev.output + stepPart.tokens!.output,
            }));
          }

          upsertActivity(genId(), {
            type: 'step',
            title: 'Step completed',
            subtitle: stepPart.reason || 'done',
            status: 'completed',
            details: {
              cost: stepPart.cost,
              tokens: stepPart.tokens,
            },
          });
        }

        // File parts
        if (part.type === 'file') {
          const filePart = part as unknown as { filename?: string; mime?: string };
          upsertActivity(genId(), {
            type: 'file',
            title: filePart.filename || 'File',
            subtitle: filePart.mime,
            status: 'info',
          });
        }
      }
    }

    // File edited
    if (type === 'file.edited') {
      const file = props.file as string | undefined;
      if (file) {
        upsertActivity(genId(), {
          type: 'file',
          title: 'File edited',
          subtitle: file.split('/').pop() || file,
          status: 'completed',
          details: { path: file },
        });
      }
    }

    // Session status
    if (type === 'session.status') {
      const status = props.status as { type: string; attempt?: number; message?: string } | undefined;
      if (status?.type) {
        setSessionStatus(status.type);
        
        if (status.type === 'idle') {
          // Mark all running activities as completed
          setActivities(prev => prev.map(a => 
            a.status === 'running' ? { ...a, status: 'completed' } : a
          ));
          setCurrentText('');
          
          // Refresh todos
          if (selectedArmId) {
            loadTodos(selectedArmId);
          }
        } else if (status.type === 'busy') {
          upsertActivity('session-busy', {
            type: 'session',
            title: 'Processing',
            status: 'running',
          });
        } else if (status.type === 'retry') {
          upsertActivity(genId(), {
            type: 'session',
            title: 'Retrying',
            subtitle: `Attempt ${status.attempt}: ${status.message}`,
            status: 'running',
          });
        }
      }
    }

    // Session error
    if (type === 'session.error') {
      const error = props.error as { name?: string; data?: { message?: string } } | undefined;
      const message = error?.data?.message || error?.name || 'Unknown error';
      upsertActivity(genId(), {
        type: 'error',
        title: 'Error',
        subtitle: message,
        status: 'error',
        details: { error },
      });
    }

    // Todo updates - only update if this is for the currently selected arm
    if (type === 'todo.updated') {
      const todos = props.todos as ArmTodo[] | undefined;
      if (todos && selectedArmId) {
        // Only update todos if the event is from the currently selected arm
        // The SSE connection should already be filtered by arm, but this adds extra safety
        setTodos(todos);
        upsertActivity('todos-updated', {
          type: 'todo',
          title: 'Todos updated',
          subtitle: `${todos.filter(t => t.status === 'completed').length}/${todos.length} complete`,
          status: 'info',
          details: { count: todos.length },
        });
      }
    }

    // PTY (terminal) events
    if (type === 'pty.created' || type === 'pty.updated') {
      const ptyId = props.id as string | undefined;
      upsertActivity(`pty-${ptyId}`, {
        type: 'terminal',
        title: 'Terminal',
        subtitle: type === 'pty.created' ? 'Created' : 'Updated',
        status: type === 'pty.created' ? 'running' : 'info',
      });
    }

    if (type === 'pty.exited') {
      const ptyId = props.id as string | undefined;
      const code = props.code as number | undefined;
      upsertActivity(`pty-${ptyId}`, {
        type: 'terminal',
        title: 'Terminal exited',
        subtitle: `Exit code: ${code}`,
        status: code === 0 ? 'completed' : 'error',
      });
    }

    // VCS branch
    if (type === 'vcs.branch.updated') {
      const branch = props.branch as string | undefined;
      upsertActivity(genId(), {
        type: 'branch',
        title: 'Branch updated',
        subtitle: branch,
        status: 'info',
      });
    }

    // LSP diagnostics
    if (type === 'lsp.client.diagnostics') {
      const diagnostics = props.diagnostics as Array<{ severity: number; message: string }> | undefined;
      const errorCount = diagnostics?.filter(d => d.severity === 1).length || 0;
      const warnCount = diagnostics?.filter(d => d.severity === 2).length || 0;
      if (errorCount > 0 || warnCount > 0) {
        upsertActivity(genId(), {
          type: errorCount > 0 ? 'error' : 'session',
          title: 'Diagnostics',
          subtitle: `${errorCount} errors, ${warnCount} warnings`,
          status: errorCount > 0 ? 'error' : 'info',
        });
      }
    }
  }, [selectedArmId, upsertActivity]);

  // Subscribe to arm events
  const { connected } = useArmEvents({
    armId: selectedArmId,
    onEvent: handleArmEvent,
    autoConnect: !!selectedArmId,
  });

  // Subscribe to arms channel for status updates
  useWebSocket({
    channels: ['arms'],
    onMessage: (msg) => {
      if (msg.channel === 'arms') {
        loadArms();
      }
    },
  });

  // Load arms on mount
  useEffect(() => {
    loadArms();
    pruneOldHistories();
  }, []);

  // Reset or restore state when arm changes
  useEffect(() => {
    if (selectedArmId) {
      // Try to restore from localStorage first
      const saved = loadArmHistory(selectedArmId);
      if (saved) {
        setActivities(saved.activities.slice(-MAX_HISTORY_ITEMS));
        // Don't restore todos from cache - always fetch fresh to prevent cross-arm contamination
        setTodos([]);
        setCurrentText(saved.currentText);
        setTotalCost(saved.totalCost);
        setTotalTokens(saved.totalTokens);
        setSessionStatus(saved.sessionStatus);
        // Note: We don't restore activityIdCounter as it's just for generating IDs
      } else {
        // No saved history - start fresh
        setActivities([]);
        setTodos([]);
        setSessionStatus('unknown');
        setCurrentText('');
        setTotalCost(0);
        setTotalTokens({ input: 0, output: 0 });
        activityIdCounter.current = 0;
      }
      // Always fetch fresh todos to ensure they match the selected arm
      loadTodos(selectedArmId);
    }
  }, [selectedArmId]);

  // Handle panel resizing
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const newWidth = e.clientX;
      if (newWidth > 300 && newWidth < window.innerWidth - 400) {
        setPanelWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  // Auto-scroll to bottom
  useEffect(() => {
    activityEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activities]);

  const selectArm = (armId: string) => {
    setSearchParams({ arm: armId });
  };

  const handleClearHistory = useCallback(() => {
    if (selectedArmId) {
      localStorage.removeItem(getStorageKey(selectedArmId));
      setActivities([]);
      setTodos([]);
      setCurrentText('');
      setTotalCost(0);
      setTotalTokens({ input: 0, output: 0 });
      setSessionStatus('unknown');
      activityIdCounter.current = 0;
    }
  }, [selectedArmId]);

  const toggleActivity = (id: string) => {
    setActivities(prev => prev.map(a => 
      a.id === id ? { ...a, expanded: !a.expanded } : a
    ));
  };

  const selectedArm = arms.find(a => a.id === selectedArmId);

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-secondary rounded w-48" />
          <div className="h-96 bg-secondary rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* Left Panel - Arm selector */}
      <div className="flex flex-col" style={{ width: panelWidth }}>
        <div className="border-b border-border px-4 py-3 bg-muted/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Eye className="h-4 w-4 text-muted-foreground" />
              <h2 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">Active Arms</h2>
            </div>
            <button
              onClick={() => setViewerExpanded(!viewerExpanded)}
              className="inline-flex items-center px-3 py-2 border border-border rounded-md text-sm font-medium text-muted-foreground bg-card hover:bg-secondary hover:text-secondary-foreground"
              title={viewerExpanded ? "Collapse panel" : "Expand panel"}
            >
              {viewerExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          {arms.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              <Eye className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p className="text-sm">No active arms</p>
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {arms.map(arm => (
                <button
                  key={arm.id}
                  onClick={() => selectArm(arm.id)}
                  className={`w-full text-left p-3 rounded-lg transition-colors ${
                    selectedArmId === arm.id
                      ? 'bg-primary text-primary-foreground'
                      : 'hover:bg-secondary'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium truncate">{arm.name}</span>
                    <StatusBadge status={arm.status} />
                  </div>
                  <p className={`text-xs mt-1 ${
                    selectedArmId === arm.id ? 'text-primary-foreground/70' : 'text-muted-foreground'
                  }`}>
                    {arm.domain}
                  </p>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Resizable divider */}
      <div
        className="w-1 bg-border hover:bg-primary/20 cursor-col-resize transition-colors"
        onMouseDown={() => setIsResizing(true)}
      />

      {/* Right Panel - Activity viewer */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="border-b border-border px-4 py-3 bg-muted/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <h1 className="text-lg font-semibold">
                {selectedArm ? selectedArm.name : 'Arm Viewer'}
              </h1>
              {selectedArm && (selectedArm.provider || selectedArm.model) && (
                <div className="flex items-center space-x-2 text-sm text-muted-foreground">
                  {selectedArm.provider && <span className="text-blue-600">{selectedArm.provider}</span>}
                  {selectedArm.provider && selectedArm.model && <span>·</span>}
                  {selectedArm.model && <span className="text-green-600">{selectedArm.model}</span>}
                </div>
              )}
            </div>

            {selectedArmId && (
              <div className="flex items-center gap-4">
                <button
                  onClick={loadArms}
                  disabled={loading}
                  className="inline-flex items-center px-3 py-2 border border-border rounded-md text-sm font-medium text-muted-foreground bg-card hover:bg-secondary hover:text-secondary-foreground disabled:opacity-50"
                >
                  <RefreshCw className="h-4 w-4" />
                </button>

                {/* Clear history button */}
                {activities.length > 0 && (
                  <button
                    onClick={handleClearHistory}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    title="Clear message history"
                  >
                    <Trash2 className="h-3 w-3" />
                    <span>Clear</span>
                  </button>
                )}

                {/* Stats */}
                {(totalCost > 0 || totalTokens.input > 0) && (
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Coins className="h-3 w-3" />
                      ${totalCost.toFixed(4)}
                    </span>
                    <span>{(totalTokens.input + totalTokens.output).toLocaleString()} tokens</span>
                  </div>
                )}

                {/* Connection status */}
                {connected ? (
                  <div className="flex items-center gap-1 text-green-500 text-sm">
                    <Radio className="h-4 w-4" />
                    <span>Live</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-1 text-muted-foreground text-sm">
                    <XCircle className="h-4 w-4" />
                    <span>Disconnected</span>
                  </div>
                )}

                {sessionStatus === 'busy' && (
                  <div className="flex items-center gap-1 text-yellow-500 text-sm">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Working...</span>
                  </div>
                )}
              </div>
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
        {!selectedArmId ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <Eye className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>Select an arm from the left panel to view its activity</p>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex overflow-hidden">
            {/* Activity log */}
            <div className="flex-1 overflow-auto p-4 space-y-2">
              {/* Current text output */}
              {currentText && (
                <div className="bg-secondary/30 rounded-lg p-4 mb-4 border border-border">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
                    <Bot className="h-3 w-3" />
                    <span>Assistant is typing...</span>
                    <Loader2 className="h-3 w-3 animate-spin ml-auto" />
                  </div>
                  <div className="text-sm whitespace-pre-wrap max-h-48 overflow-auto">
                    {currentText.slice(-1500)}
                  </div>
                </div>
              )}

              {/* Activity items */}
              {activities.length === 0 && !currentText ? (
                <div className="text-center text-muted-foreground py-8">
                  <p>No activity yet. Send a prompt to start.</p>
                </div>
              ) : (
                activities.map(activity => (
                  <ActivityItemComponent
                    key={activity.id}
                    activity={activity}
                    onToggle={() => toggleActivity(activity.id)}
                  />
                ))
              )}
              <div ref={activityEndRef} />
            </div>

            {/* Todos sidebar */}
            <aside className="w-72 border-l border-border bg-card overflow-auto">
              <div className="p-4 border-b border-border">
                <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">
                  Todo List
                </h3>
              </div>
              <div className="p-2">
                {todos.length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">No todos</p>
                ) : (
                  <div className="space-y-2">
                    {todos.map(todo => (
                      <TodoItem key={todo.id} todo={todo} />
                    ))}
                  </div>
                )}
              </div>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}

function ActivityItemComponent({ activity, onToggle }: { activity: ActivityItem; onToggle: () => void }) {
  const colors = activityColors[activity.type];
  const Icon = activityIcons[activity.type];
  const hasDetails = activity.details && Object.keys(activity.details).length > 0;

  const statusIcon = {
    pending: <Clock className="h-3 w-3 text-muted-foreground" />,
    running: <Loader2 className="h-3 w-3 animate-spin text-yellow-500" />,
    completed: <CheckCircle2 className="h-3 w-3 text-green-500" />,
    error: <XCircle className="h-3 w-3 text-red-500" />,
    info: null,
  }[activity.status];

  return (
    <div className={`rounded-lg border-l-2 ${colors.border} ${colors.bg} overflow-hidden`}>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 p-2 text-left hover:bg-black/5 transition-colors"
        disabled={!hasDetails}
      >
        {hasDetails ? (
          activity.expanded ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground flex-shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground flex-shrink-0" />
          )
        ) : (
          <span className="w-3" />
        )}
        
        <Icon className={`h-4 w-4 ${colors.icon} flex-shrink-0`} />
        
        <span className="text-sm font-medium truncate flex-1">{activity.title}</span>
        
        {activity.subtitle && (
          <span className="text-xs text-muted-foreground truncate max-w-[40%]">
            {activity.subtitle}
          </span>
        )}
        
        {statusIcon}
        
        <span className="text-xs text-muted-foreground flex-shrink-0">
          {formatTime(activity.timestamp)}
        </span>
      </button>

      {/* Expanded details */}
      {activity.expanded && hasDetails && (
        <div className="px-4 pb-3 pt-1 border-t border-border/50">
          <pre className="text-xs text-muted-foreground overflow-auto max-h-48 whitespace-pre-wrap">
            {formatDetails(activity.details!)}
          </pre>
        </div>
      )}
    </div>
  );
}

function TodoItem({ todo }: { todo: ArmTodo }) {
  const statusIcon = {
    pending: <Clock className="h-4 w-4 text-muted-foreground" />,
    in_progress: <Loader2 className="h-4 w-4 animate-spin text-yellow-500" />,
    completed: <CheckCircle2 className="h-4 w-4 text-green-500" />,
    cancelled: <XCircle className="h-4 w-4 text-muted-foreground" />,
  }[todo.status];

  const priorityColor = {
    high: 'border-l-red-500',
    medium: 'border-l-yellow-500',
    low: 'border-l-green-500',
  }[todo.priority];

  return (
    <div className={`p-3 rounded bg-secondary/50 border-l-2 ${priorityColor}`}>
      <div className="flex items-start gap-2">
        {statusIcon}
        <span className={`text-sm flex-1 ${
          todo.status === 'completed' || todo.status === 'cancelled'
            ? 'line-through text-muted-foreground'
            : ''
        }`}>
          {todo.content}
        </span>
      </div>
    </div>
  );
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDetails(details: Record<string, unknown>): string {
  // Format details for display, handling special cases
  const formatted: Record<string, unknown> = {};
  
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined || value === null) continue;
    
    if (key === 'output' && typeof value === 'string' && value.length > 500) {
      formatted[key] = value.slice(0, 500) + '... (truncated)';
    } else if (key === 'input' && typeof value === 'object') {
      // Truncate long input values
      const inputObj = value as Record<string, unknown>;
      const truncatedInput: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(inputObj)) {
        if (typeof v === 'string' && v.length > 200) {
          truncatedInput[k] = v.slice(0, 200) + '...';
        } else {
          truncatedInput[k] = v;
        }
      }
      formatted[key] = truncatedInput;
    } else if (key === 'duration' && typeof value === 'number') {
      formatted[key] = `${value}ms`;
    } else {
      formatted[key] = value;
    }
  }
  
  return JSON.stringify(formatted, null, 2);
}
