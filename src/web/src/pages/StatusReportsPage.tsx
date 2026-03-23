/**
 * Status Reports Page
 * Displays status reports from arms and allows tracking message processing
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import { api, type StatusReport } from '@/lib/api';
import { Button } from '@heroui/react';
import { RefreshCw, AlertCircle, CheckCircle, Clock, XCircle, FileText, Search, FilterX } from 'lucide-react';
import { usePageTitle } from '@/hooks/usePageTitle';

type StatusReportStats = Awaited<ReturnType<typeof api.getStatusReportStats>>;

export function StatusReportsPage() {
  usePageTitle('Coleo Observatory - Status History');

  const [reports, setReports] = useState<StatusReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<StatusReportStats | null>(null);
  const [pagination, setPagination] = useState({ limit: 50, offset: 0, total: 0 });
  const [searchText, setSearchText] = useState('');
  const [taskIdFilter, setTaskIdFilter] = useState('');
  const [armIdFilter, setArmIdFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusReport['status'] | 'all'>('all');

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

  useEffect(() => {
    loadReports();
  }, [loadReports]);

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



  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="h-8 w-8 animate-spin" />
        <span className="ml-2">Loading status reports...</span>
      </div>
    );
  }

  if (error) {
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
            Search historical status reports from arms across tasks
          </p>
        </div>
        <Button variant="primary" onPress={() => loadReports(pagination.offset)} isDisabled={loading} className="inline-flex">
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Stats Overview */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-white p-4 rounded-lg border">
            <div className="flex items-center space-x-2">
              <CheckCircle className="h-5 w-5 text-green-500" />
              <div>
                <p className="text-sm font-medium">On Track</p>
                <p className="text-2xl font-bold">{getStatusCount('on_track')}</p>
                <p className="text-xs text-gray-500">Tasks progressing normally</p>
              </div>
            </div>
          </div>
          <div className="bg-white p-4 rounded-lg border">
            <div className="flex items-center space-x-2">
              <XCircle className="h-5 w-5 text-red-500" />
              <div>
                <p className="text-sm font-medium">Blocked</p>
                <p className="text-2xl font-bold">{getStatusCount('blocked')}</p>
                <p className="text-xs text-gray-500">Need human intervention</p>
              </div>
            </div>
          </div>
          <div className="bg-white p-4 rounded-lg border">
            <div className="flex items-center space-x-2">
              <AlertCircle className="h-5 w-5 text-orange-500" />
              <div>
                <p className="text-sm font-medium">Issues Found</p>
                <p className="text-2xl font-bold">{getStatusCount('issues_found')}</p>
                <p className="text-xs text-gray-500">Problems discovered</p>
              </div>
            </div>
          </div>
          <div className="bg-white p-4 rounded-lg border">
            <div className="flex items-center space-x-2">
              <Clock className="h-5 w-5 text-blue-500" />
              <div>
                <p className="text-sm font-medium">Recent (24h)</p>
                <p className="text-2xl font-bold">{stats.recentReports || 0}</p>
                <p className="text-xs text-gray-500">Reports in last day</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Empty stats state */}
      {!stats && !loading && reports.length === 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex">
            <AlertCircle className="h-5 w-5 text-blue-400" />
            <div className="ml-3">
              <p className="text-sm text-blue-800">
                Statistics will appear here once arms start submitting status reports.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Search and Filters */}
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
          <div className="h-4 w-px bg-divider" />
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

      {/* Reports List */}
      <div className="bg-white rounded-lg border">
        <div className="p-4">
          <StatusReportsList reports={filteredReports} />
        </div>

        {/* Pagination */}
        {pagination.total > pagination.limit && (
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
              {pagination.offset + 1} - {Math.min(pagination.offset + pagination.limit, pagination.total)} of {pagination.total}
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

const getStatusIcon = (status: StatusReport['status']) => {
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

const getStatusBadgeClass = (status: StatusReport['status']) => {
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
          <h3 className="text-lg font-medium text-gray-900 mb-2">
            No Status Reports Yet
          </h3>
          <p className="text-gray-500 mb-4">
            This page will show progress updates from AI arms as they work on tasks.
            Status reports appear when arms encounter issues, complete work, or need human input.
          </p>
          <div className="text-sm text-gray-400">
            <p className="mb-1">Reports include:</p>
            <ul className="list-disc list-inside text-left inline-block">
              <li>Task progress updates</li>
              <li>Issues and blockers discovered</li>
              <li>Next steps and recommendations</li>
              <li>Files changed and test results</li>
            </ul>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {reports.map((report) => (
        <div key={report.id} className="bg-white p-4 rounded-lg border">
          <div className="flex items-start justify-between">
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

                {report.filesChanged && report.filesChanged.length > 0 && (
                  <div className="mb-3">
                    <p className="text-sm font-medium">Files Changed:</p>
                    <div className="flex flex-wrap gap-1">
                      {report.filesChanged.map((file: string) => (
                        <span key={`${report.id}-file-${file}`} className="px-2 py-1 text-xs bg-gray-100 rounded">
                          {file}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {report.testsStatus && (
                  <div>
                    <p className="text-sm font-medium">Tests: {report.testsStatus}</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
