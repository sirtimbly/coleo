/**
 * Bugs Page
 *
 * Displays bug reports and allows tracking and management
 */
import { useState, useEffect } from 'react';
import { api, type Bug, cn } from '@/lib';
import { Card, CardContent } from '@/components';
import { RefreshCw, Bug as BugIcon, AlertTriangle, Clock, CheckCircle, XCircle, User, Calendar, Trash2 } from 'lucide-react';
import { useWebSocket } from '@/hooks/useWebSocket';

// Status configuration
const STATUS_CONFIG: Record<Bug['status'], { color: string; bgColor: string; icon: React.ComponentType<{ className?: string }>; label: string }> = {
  open: { color: 'text-red-500', bgColor: 'bg-red-500/10', icon: AlertTriangle, label: 'Open' },
  investigating: { color: 'text-yellow-500', bgColor: 'bg-yellow-500/10', icon: Clock, label: 'Investigating' },
  fixing: { color: 'text-blue-500', bgColor: 'bg-blue-500/10', icon: Clock, label: 'Fixing' },
  verifying: { color: 'text-purple-500', bgColor: 'bg-purple-500/10', icon: Clock, label: 'Verifying' },
  resolved: { color: 'text-green-500', bgColor: 'bg-green-500/10', icon: CheckCircle, label: 'Resolved' },
  closed: { color: 'text-gray-500', bgColor: 'bg-gray-500/10', icon: XCircle, label: 'Closed' },
};

// Priority configuration
const PRIORITY_CONFIG: Record<Bug['priority'], { color: string; bgColor: string; label: string }> = {
  critical: { color: 'text-red-500', bgColor: 'bg-red-500/20', label: 'Critical' },
  high: { color: 'text-orange-500', bgColor: 'bg-orange-500/20', label: 'High' },
  medium: { color: 'text-yellow-500', bgColor: 'bg-yellow-500/20', label: 'Medium' },
  low: { color: 'text-gray-500', bgColor: 'bg-gray-500/20', label: 'Low' },
};

// Source configuration
const SOURCE_CONFIG: Record<Bug['source'], { label: string; color: string }> = {
  arm_reported: { label: 'Arm Reported', color: 'text-blue-500' },
  human_reported: { label: 'Human Reported', color: 'text-purple-500' },
  system_detected: { label: 'System Detected', color: 'text-red-500' },
};

export function BugsPage() {
  const [bugs, setBugs] = useState<Bug[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // WebSocket for real-time updates
  useWebSocket({
    channels: ['bugs'],
    onMessage: (message) => {
      if (message.event === 'bug.created' || message.event === 'bug.updated' || message.event === 'bug.deleted') {
        loadBugs();
      }
    },
  });

  const loadBugs = async () => {
    try {
      setLoading(true);
      const response = await api.listBugs();
      setBugs(response.bugs || []);
      setError(null);
    } catch (err) {
      setError('Failed to load bugs');
      console.error('Failed to load bugs:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadBugs();
  }, []);

  const handleStatusChange = async (bugId: string, newStatus: Bug['status']) => {
    try {
      await api.updateBug(bugId, { status: newStatus });
      loadBugs();
    } catch (err) {
      console.error('Failed to update bug status:', err);
    }
  };

  const handleDelete = async (bugId: string) => {
    if (!confirm('Are you sure you want to delete this bug?')) return;
    try {
      await api.deleteBug(bugId);
      loadBugs();
    } catch (err) {
      console.error('Failed to delete bug:', err);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="h-8 w-8 animate-spin text-gray-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Bug Tracker</h1>
          <p className="text-gray-600">Track and manage bug reports from arms and humans</p>
        </div>
        <button
          onClick={loadBugs}
          className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-md">
          <div className="flex items-center gap-2 text-red-800">
            <AlertTriangle className="h-4 w-4" />
            <span>{error}</span>
          </div>
        </div>
      )}

      {/* Bugs List */}
      <div className="space-y-4">
        {bugs.length === 0 ? (
          <Card>
            <CardContent className="pt-6">
              <div className="text-center py-8 text-gray-500">
                <BugIcon className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>No bugs found.</p>
              </div>
            </CardContent>
          </Card>
        ) : (
          bugs.map((bug) => {
            const statusConfig = STATUS_CONFIG[bug.status];
            const priorityConfig = PRIORITY_CONFIG[bug.priority];
            const sourceConfig = SOURCE_CONFIG[bug.source];
            const StatusIcon = statusConfig.icon;

            return (
              <Card key={bug.id} className="hover:shadow-md transition-shadow">
                <CardContent className="pt-6">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <StatusIcon className={cn("h-5 w-5", statusConfig.color)} />
                        <h3 className="text-lg font-semibold text-gray-900">{bug.title}</h3>
                        <span className={cn("px-2 py-1 text-xs rounded", priorityConfig.bgColor, priorityConfig.color)}>
                          {priorityConfig.label}
                        </span>
                        <span className={cn("px-2 py-1 text-xs border rounded", sourceConfig.color)}>
                          {sourceConfig.label}
                        </span>
                      </div>

                      <p className="text-gray-600 mb-3 line-clamp-2">{bug.description}</p>

                      <div className="flex items-center gap-4 text-sm text-gray-500">
                        <div className="flex items-center gap-1">
                          <User className="h-4 w-4" />
                          {bug.assigneeArmName ? (
                            <span>{bug.assigneeArmName}</span>
                          ) : (
                            <span className="text-gray-400">Unassigned</span>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          <Calendar className="h-4 w-4" />
                          <span>{new Date(bug.createdAt).toLocaleDateString()}</span>
                        </div>
                        {bug.sourceTaskId && (
                          <div className="flex items-center gap-1">
                            <span>Task: {bug.sourceTaskId.slice(-8)}</span>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 ml-4">
                      <select
                        value={bug.status}
                        onChange={(e) => handleStatusChange(bug.id, e.target.value as Bug['status'])}
                        className="px-3 py-1 border border-gray-300 rounded text-sm"
                      >
                        <option value="open">Open</option>
                        <option value="investigating">Investigating</option>
                        <option value="fixing">Fixing</option>
                        <option value="verifying">Verifying</option>
                        <option value="resolved">Resolved</option>
                        <option value="closed">Closed</option>
                      </select>

                      <button
                        onClick={() => handleDelete(bug.id)}
                        className="p-2 text-red-600 hover:text-red-700"
                        title="Delete bug"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}