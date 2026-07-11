/**
 * Status History Search Page
 * SQLite status reports list + hybrid semantic search over Qdrant status-history.
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  api,
  type StatusReport,
  type StatusHistorySearchHit,
} from '@/lib/api';
import { Button } from '@heroui/react';
import {
  RefreshCw,
  AlertCircle,
  CheckCircle,
  Clock,
  XCircle,
  FileText,
  Search,
  FilterX,
  Sparkles,
} from 'lucide-react';
import { usePageTitle } from '@/hooks/usePageTitle';

type StatusReportStats = Awaited<ReturnType<typeof api.getStatusReportStats>>;
type SearchMode = 'browse' | 'semantic';

const EVENT_TYPES = [
  'status_report',
  'task_completion',
  'discovery',
  'bug_report',
  'task_created',
  'task_updated',
  'arm_event',
] as const;

export function StatusReportsPage() {
  usePageTitle('Coleo Observatory - Status History');

  const [mode, setMode] = useState<SearchMode>('browse');
  const [reports, setReports] = useState<StatusReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<StatusReportStats | null>(null);
  const [pagination, setPagination] = useState({ limit: 50, offset: 0, total: 0 });
  const [searchText, setSearchText] = useState('');
  const [taskIdFilter, setTaskIdFilter] = useState('');
  const [armIdFilter, setArmIdFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusReport['status'] | 'all'>('all');

  // Semantic search state
  const [semanticQuery, setSemanticQuery] = useState('');
  const [semanticHits, setSemanticHits] = useState<StatusHistorySearchHit[]>([]);
  const [semanticLoading, setSemanticLoading] = useState(false);
  const [semanticError, setSemanticError] = useState<string | null>(null);
  const [semanticMeta, setSemanticMeta] = useState<{
    total: number;
    took: number;
    semanticUsed: boolean;
  } | null>(null);
  const [eventTypeFilter, setEventTypeFilter] = useState<string>('all');
  const [daysBack, setDaysBack] = useState(30);
  const [vectorStats, setVectorStats] = useState<{
    healthy: boolean;
    pointsCount: number;
  } | null>(null);

  const loadReports = useCallback(async (offset = 0) => {
    try {
      setLoading(true);
      setError(null);

      const [reportsResponse, statsResponse] = await Promise.all([
        api.listStatusReports({
          limit: pagination.limit,
          offset,
          taskId: taskIdFilter.trim() || undefined,
          armId: armIdFilter.trim() || undefined,
        }),
        api.getStatusReportStats(),
      ]);

      setReports(reportsResponse.reports);
      setStats(statsResponse);
      setPagination(reportsResponse.pagination);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load status reports');
    } finally {
      setLoading(false);
    }
  }, [pagination.limit, taskIdFilter, armIdFilter]);

  const loadVectorStats = useCallback(async () => {
    try {
      const res = await api.getStatusHistoryStats('all');
      setVectorStats({ healthy: res.healthy, pointsCount: res.pointsCount });
    } catch {
      setVectorStats({ healthy: false, pointsCount: 0 });
    }
  }, []);

  useEffect(() => {
    loadReports();
    loadVectorStats();
  }, [loadReports, loadVectorStats]);

  const runSemanticSearch = useCallback(async () => {
    const q = semanticQuery.trim();
    if (!q) {
      setSemanticError('Enter a natural-language query');
      return;
    }
    try {
      setSemanticLoading(true);
      setSemanticError(null);
      const armIds = armIdFilter.trim() ? [armIdFilter.trim()] : undefined;
      const eventTypes =
        eventTypeFilter === 'all' ? undefined : [eventTypeFilter];

      const res = await api.searchStatusHistory({
        query: q,
        armIds,
        eventTypes,
        taskId: taskIdFilter.trim() || undefined,
        daysBack,
        limit: 25,
      });

      setSemanticHits(res.results);
      setSemanticMeta({
        total: res.total,
        took: res.query_time_ms,
        semanticUsed: res.semanticUsed,
      });
    } catch (err) {
      setSemanticError(err instanceof Error ? err.message : 'Semantic search failed');
      setSemanticHits([]);
      setSemanticMeta(null);
    } finally {
      setSemanticLoading(false);
    }
  }, [semanticQuery, armIdFilter, eventTypeFilter, taskIdFilter, daysBack]);

  const filteredReports = useMemo(() => {
    let result = reports;

    if (statusFilter !== 'all') {
      result = result.filter((report) => report.status === statusFilter);
    }

    if (searchText.trim()) {
      const query = searchText.toLowerCase();
      result = result.filter((report) => {
        const issues = report.issues?.join(' ').toLowerCase() || '';
        const blockers = report.blockers?.join(' ').toLowerCase() || '';
        const nextSteps = report.nextSteps?.toLowerCase() || '';
        return (
          report.summary.toLowerCase().includes(query) ||
          report.armId.toLowerCase().includes(query) ||
          report.taskId.toLowerCase().includes(query) ||
          issues.includes(query) ||
          blockers.includes(query) ||
          nextSteps.includes(query)
        );
      });
    }

    return result;
  }, [reports, searchText, statusFilter]);

  const handleApplyFilters = useCallback(() => {
    setPagination((prev) => ({ ...prev, offset: 0 }));
    loadReports(0);
  }, [loadReports]);

  const handleClearFilters = useCallback(() => {
    setTaskIdFilter('');
    setArmIdFilter('');
    setStatusFilter('all');
    setSearchText('');
    setEventTypeFilter('all');
    setDaysBack(30);
    setSemanticQuery('');
    setSemanticHits([]);
    setSemanticMeta(null);
    setPagination((prev) => ({ ...prev, offset: 0 }));
    loadReports(0);
  }, [loadReports]);

  const getStatusCount = useCallback(
    (status: StatusReport['status']) => {
      if (!stats) {
        return 0;
      }
      return stats.statusDistribution.find((entry) => entry.status === status)?.count ?? 0;
    },
    [stats],
  );

  if (loading && mode === 'browse' && reports.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="h-8 w-8 animate-spin" />
        <span className="ml-2">Loading status reports...</span>
      </div>
    );
  }

  if (error && mode === 'browse' && reports.length === 0) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <div className="flex">
          <AlertCircle className="h-4 w-4 text-red-400" />
          <div className="ml-3">
            <p className="text-sm text-red-800">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gradient-heading">Status History</h1>
          <p className="text-muted-foreground">
            Browse reports or run hybrid semantic search over indexed arm history
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border bg-default-50 p-0.5">
            <button
              type="button"
              className={`px-3 py-1.5 text-sm rounded ${mode === 'browse' ? 'bg-white shadow-sm font-medium' : 'text-muted-foreground'}`}
              onClick={() => setMode('browse')}
            >
              Browse
            </button>
            <button
              type="button"
              className={`px-3 py-1.5 text-sm rounded inline-flex items-center gap-1 ${mode === 'semantic' ? 'bg-white shadow-sm font-medium' : 'text-muted-foreground'}`}
              onClick={() => setMode('semantic')}
            >
              <Sparkles className="h-3.5 w-3.5" />
              Semantic
            </button>
          </div>
          <Button
            variant="primary"
            onPress={() => (mode === 'browse' ? loadReports(pagination.offset) : runSemanticSearch())}
            isDisabled={loading || semanticLoading}
            className="inline-flex"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${loading || semanticLoading ? 'animate-spin' : ''}`} />
            {mode === 'browse' ? 'Refresh' : 'Search'}
          </Button>
        </div>
      </div>

      {stats && mode === 'browse' && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-white p-4 rounded-lg border">
            <div className="flex items-center space-x-2">
              <CheckCircle className="h-5 w-5 text-green-500" />
              <div>
                <p className="text-sm font-medium">On Track</p>
                <p className="text-2xl font-bold">{getStatusCount('on_track')}</p>
              </div>
            </div>
          </div>
          <div className="bg-white p-4 rounded-lg border">
            <div className="flex items-center space-x-2">
              <XCircle className="h-5 w-5 text-red-500" />
              <div>
                <p className="text-sm font-medium">Blocked</p>
                <p className="text-2xl font-bold">{getStatusCount('blocked')}</p>
              </div>
            </div>
          </div>
          <div className="bg-white p-4 rounded-lg border">
            <div className="flex items-center space-x-2">
              <AlertCircle className="h-5 w-5 text-orange-500" />
              <div>
                <p className="text-sm font-medium">Issues Found</p>
                <p className="text-2xl font-bold">{getStatusCount('issues_found')}</p>
              </div>
            </div>
          </div>
          <div className="bg-white p-4 rounded-lg border">
            <div className="flex items-center space-x-2">
              <Clock className="h-5 w-5 text-blue-500" />
              <div>
                <p className="text-sm font-medium">Recent (24h)</p>
                <p className="text-2xl font-bold">{stats.recentReports || 0}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {mode === 'semantic' && (
        <div className="bg-white rounded-lg border p-4 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[240px]">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-default-400" />
              <input
                type="text"
                placeholder='e.g. "problems with database migrations"'
                value={semanticQuery}
                onChange={(e) => setSemanticQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') runSemanticSearch();
                }}
                className="w-full pl-8 pr-3 py-2 text-sm bg-default-100 border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-accent"
              />
            </div>
            <input
              type="text"
              placeholder="Arm ID"
              value={armIdFilter}
              onChange={(e) => setArmIdFilter(e.target.value)}
              className="px-3 py-2 text-sm bg-default-100 border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-accent w-40"
            />
            <input
              type="text"
              placeholder="Task ID"
              value={taskIdFilter}
              onChange={(e) => setTaskIdFilter(e.target.value)}
              className="px-3 py-2 text-sm bg-default-100 border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-accent w-40"
            />
            <select
              value={eventTypeFilter}
              onChange={(e) => setEventTypeFilter(e.target.value)}
              className="px-3 py-2 text-sm bg-default-100 border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-accent"
            >
              <option value="all">All event types</option>
              {EVENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <select
              value={String(daysBack)}
              onChange={(e) => setDaysBack(Number(e.target.value))}
              className="px-3 py-2 text-sm bg-default-100 border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-accent"
            >
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="365">Last year</option>
            </select>
            <Button variant="primary" onPress={runSemanticSearch} isDisabled={semanticLoading}>
              <Sparkles className="h-4 w-4 mr-2" />
              Search
            </Button>
            <Button variant="ghost" onPress={handleClearFilters}>
              <FilterX className="h-4 w-4 mr-2" />
              Clear
            </Button>
          </div>
          <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
            {vectorStats && (
              <span>
                Vector index: {vectorStats.healthy ? 'healthy' : 'unavailable'} ·{' '}
                {vectorStats.pointsCount} points
              </span>
            )}
            {semanticMeta && (
              <span>
                {semanticMeta.total} hits · {semanticMeta.took}ms · semantic{' '}
                {semanticMeta.semanticUsed ? 'on' : 'off'}
              </span>
            )}
          </div>
          {semanticError && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-100 rounded p-3">
              {semanticError}
            </div>
          )}
        </div>
      )}

      {mode === 'browse' && (
        <div className="bg-white rounded-lg border p-4 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-default-400" />
              <input
                type="text"
                placeholder="Search summaries, arm IDs, task IDs..."
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                className="pl-8 pr-3 py-1.5 text-sm bg-default-100 border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-accent w-72"
              />
            </div>
            <input
              type="text"
              placeholder="Filter by task ID"
              value={taskIdFilter}
              onChange={(e) => setTaskIdFilter(e.target.value)}
              className="px-3 py-1.5 text-sm bg-default-100 border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-accent w-48"
            />
            <input
              type="text"
              placeholder="Filter by arm ID"
              value={armIdFilter}
              onChange={(e) => setArmIdFilter(e.target.value)}
              className="px-3 py-1.5 text-sm bg-default-100 border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-accent w-48"
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusReport['status'] | 'all')}
              className="px-3 py-1.5 text-sm bg-default-100 border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-accent"
            >
              <option value="all">All statuses</option>
              <option value="on_track">On track</option>
              <option value="blocked">Blocked</option>
              <option value="issues_found">Issues found</option>
              <option value="needs_review">Needs review</option>
              <option value="completed_with_issues">Completed with issues</option>
            </select>
            <Button variant="secondary" onPress={handleApplyFilters} isDisabled={loading}>
              Apply
            </Button>
            <Button variant="ghost" onPress={handleClearFilters} isDisabled={loading}>
              <FilterX className="h-4 w-4 mr-2" />
              Clear
            </Button>
            <div className="ml-auto text-sm text-muted-foreground">
              Showing {filteredReports.length} of {pagination.total}
            </div>
          </div>
        </div>
      )}

      <div className="bg-white rounded-lg border">
        <div className="p-4">
          {mode === 'browse' ? (
            <StatusReportsList reports={filteredReports} />
          ) : (
            <SemanticHitsList hits={semanticHits} loading={semanticLoading} />
          )}
        </div>

        {mode === 'browse' && pagination.total > pagination.limit && (
          <div className="flex justify-center gap-2 px-4 pb-4">
            <Button
              variant="secondary"
              size="sm"
              onPress={() => loadReports(Math.max(0, pagination.offset - pagination.limit))}
              isDisabled={pagination.offset === 0 || loading}
            >
              Previous
            </Button>
            <span className="px-3 py-1 text-sm text-muted-foreground">
              {pagination.offset + 1} -{' '}
              {Math.min(pagination.offset + pagination.limit, pagination.total)} of{' '}
              {pagination.total}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onPress={() => loadReports(pagination.offset + pagination.limit)}
              isDisabled={pagination.offset + pagination.limit >= pagination.total || loading}
            >
              Next
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

interface StatusReportsListProps {
  reports: StatusReport[];
}

const getStatusIcon = (status: StatusReport['status'] | string | undefined) => {
  switch (status) {
    case 'on_track':
      return <CheckCircle className="h-4 w-4 text-green-500" />;
    case 'blocked':
      return <XCircle className="h-4 w-4 text-red-500" />;
    case 'issues_found':
      return <AlertCircle className="h-4 w-4 text-orange-500" />;
    case 'needs_review':
      return <Clock className="h-4 w-4 text-blue-500" />;
    case 'completed_with_issues':
      return <AlertCircle className="h-4 w-4 text-yellow-500" />;
    default:
      return <Clock className="h-4 w-4 text-gray-500" />;
  }
};

const getStatusBadgeClass = (status: StatusReport['status'] | string | undefined) => {
  switch (status) {
    case 'on_track':
      return 'bg-green-100 text-green-800';
    case 'blocked':
      return 'bg-red-100 text-red-800';
    case 'issues_found':
      return 'bg-orange-100 text-orange-800';
    case 'needs_review':
      return 'bg-blue-100 text-blue-800';
    case 'completed_with_issues':
      return 'bg-yellow-100 text-yellow-800';
    default:
      return 'bg-gray-100 text-gray-800';
  }
};

function StatusReportsList({ reports }: StatusReportsListProps) {
  if (reports.length === 0) {
    return (
      <div className="bg-white p-12 text-center rounded-lg border">
        <div className="max-w-md mx-auto">
          <FileText className="h-12 w-12 text-gray-400 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No Status Reports Yet</h3>
          <p className="text-gray-500 mb-4">
            This page will show progress updates from AI arms as they work on tasks. Switch to
            Semantic mode to search indexed history in Qdrant.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {reports.map((report) => (
        <div key={report.id} className="bg-white p-4 rounded-lg border">
          <div className="flex items-start space-x-3">
            {getStatusIcon(report.status)}
            <div className="flex-1">
              <div className="flex items-center space-x-2 mb-2">
                <h3 className="font-medium">{report.armId}</h3>
                <span className={`px-2 py-1 text-xs rounded-full ${getStatusBadgeClass(report.status)}`}>
                  {report.status.replace('_', ' ')}
                </span>
                <span className="text-sm text-gray-500">
                  {new Date(report.createdAt).toLocaleString()}
                </span>
              </div>
              <p className="text-sm mb-3">{report.summary}</p>
              {report.nextSteps && (
                <div className="mb-3">
                  <p className="text-sm font-medium">Next Steps:</p>
                  <p className="text-sm text-gray-600">{report.nextSteps}</p>
                </div>
              )}
              {report.issues && report.issues.length > 0 && (
                <div className="mb-3">
                  <p className="text-sm font-medium">Issues:</p>
                  <ul className="text-sm text-gray-600 list-disc list-inside">
                    {report.issues.map((issue: string) => (
                      <li key={`${report.id}-issue-${issue}`}>{issue}</li>
                    ))}
                  </ul>
                </div>
              )}
              {report.blockers && report.blockers.length > 0 && (
                <div className="mb-3">
                  <p className="text-sm font-medium">Blockers:</p>
                  <ul className="text-sm text-gray-600 list-disc list-inside">
                    {report.blockers.map((blocker: string) => (
                      <li key={`${report.id}-blocker-${blocker}`}>{blocker}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function SemanticHitsList({
  hits,
  loading,
}: {
  hits: StatusHistorySearchHit[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <RefreshCw className="h-6 w-6 animate-spin mr-2" />
        Searching status history…
      </div>
    );
  }

  if (hits.length === 0) {
    return (
      <div className="p-12 text-center">
        <Sparkles className="h-10 w-10 text-gray-400 mx-auto mb-3" />
        <h3 className="text-lg font-medium mb-2">Semantic status search</h3>
        <p className="text-sm text-muted-foreground max-w-md mx-auto">
          Enter a natural-language query (for example &quot;errors or blockers from last
          night&quot;) to search indexed status reports, completions, discoveries, and bugs.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {hits.map((hit) => {
        const { event } = hit;
        return (
          <div key={event.id} className="bg-white p-4 rounded-lg border">
            <div className="flex items-start space-x-3">
              {getStatusIcon(event.status)}
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <h3 className="font-medium">{event.title}</h3>
                  <span className="px-2 py-0.5 text-xs rounded-full bg-violet-100 text-violet-800">
                    {event.type}
                  </span>
                  {event.status && (
                    <span className={`px-2 py-0.5 text-xs rounded-full ${getStatusBadgeClass(event.status)}`}>
                      {event.status.replace(/_/g, ' ')}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    score {hit.score.toFixed(2)} · kw {hit.keywordScore.toFixed(2)} · sem{' '}
                    {hit.semanticScore.toFixed(2)}
                  </span>
                </div>
                <p className="text-sm mb-2 whitespace-pre-wrap">{event.content}</p>
                <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                  <span>{event.source}</span>
                  {event.armId && <span>arm: {event.armId}</span>}
                  {event.taskId && <span>task: {event.taskId}</span>}
                  <span>{new Date(event.timestamp).toLocaleString()}</span>
                </div>
                {hit.highlights.length > 0 && (
                  <div className="mt-3 space-y-1">
                    {hit.highlights.map((h) => (
                      <p
                        key={`${event.id}-${h.slice(0, 24)}`}
                        className="text-xs bg-amber-50 text-amber-900 border border-amber-100 rounded px-2 py-1"
                      >
                        …{h}…
                      </p>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
