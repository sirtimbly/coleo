/**
 * Status Reports Page
 * Displays status reports from arms and allows tracking message processing
 */
import { useState, useEffect } from 'react';
import { api, type StatusReport } from '@/lib/api';
import { RefreshCw, AlertCircle, CheckCircle, Clock, XCircle, FileText } from 'lucide-react';

interface StatusReportsPageProps {}

export function StatusReportsPage({}: StatusReportsPageProps) {
  const [reports, setReports] = useState<StatusReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<any>(null);

  const loadReports = async () => {
    try {
      setLoading(true);
      setError(null);

      const [reportsResponse, statsResponse] = await Promise.all([
        api.listStatusReports({ limit: 50 }),
        api.getStatusReportStats(),
      ]);

      setReports(reportsResponse.reports);
      setStats(statsResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load status reports');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadReports();
  }, []);



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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Status Reports</h1>
          <p className="text-muted-foreground">
            Monitor arm progress and track task status updates
          </p>
        </div>
        <button
          onClick={loadReports}
          disabled={loading}
          className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Stats Overview */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-white p-4 rounded-lg border">
            <div className="flex items-center space-x-2">
              <CheckCircle className="h-5 w-5 text-green-500" />
              <div>
                <p className="text-sm font-medium">On Track</p>
                <p className="text-2xl font-bold">{stats.statusDistribution?.find((s: any) => s.status === 'on_track')?.count || 0}</p>
                <p className="text-xs text-gray-500">Tasks progressing normally</p>
              </div>
            </div>
          </div>
          <div className="bg-white p-4 rounded-lg border">
            <div className="flex items-center space-x-2">
              <XCircle className="h-5 w-5 text-red-500" />
              <div>
                <p className="text-sm font-medium">Blocked</p>
                <p className="text-2xl font-bold">{stats.statusDistribution?.find((s: any) => s.status === 'blocked')?.count || 0}</p>
                <p className="text-xs text-gray-500">Need human intervention</p>
              </div>
            </div>
          </div>
          <div className="bg-white p-4 rounded-lg border">
            <div className="flex items-center space-x-2">
              <AlertCircle className="h-5 w-5 text-orange-500" />
              <div>
                <p className="text-sm font-medium">Issues Found</p>
                <p className="text-2xl font-bold">{stats.statusDistribution?.find((s: any) => s.status === 'issues_found')?.count || 0}</p>
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

      {/* Filter Tabs */}
      <div className="bg-white rounded-lg border">
        <div className="border-b">
          <nav className="flex">
            <button
              className="px-4 py-2 text-sm font-medium border-b-2 border-blue-500 text-blue-600"
              onClick={() => setReports(reports)}
            >
              All Reports
            </button>
            <button
              className="px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700"
              onClick={() => setReports(reports.filter(r => r.status === 'blocked'))}
            >
              Blocked
            </button>
            <button
              className="px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700"
              onClick={() => setReports(reports.filter(r => r.status === 'issues_found' || r.status === 'completed_with_issues'))}
            >
              Issues
            </button>
            <button
              className="px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700"
              onClick={() => {
                const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
                setReports(reports.filter(r => new Date(r.createdAt) > oneDayAgo));
              }}
            >
              Recent
            </button>
          </nav>
        </div>

        <div className="p-4">
          <StatusReportsList reports={reports} />
        </div>
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
                      {report.issues.map((issue: string, index: number) => (
                        <li key={index}>{issue}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {report.blockers && report.blockers.length > 0 && (
                  <div className="mb-3">
                    <p className="text-sm font-medium">Blockers:</p>
                    <ul className="text-sm text-gray-600 list-disc list-inside">
                      {report.blockers.map((blocker: string, index: number) => (
                        <li key={index}>{blocker}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {report.filesChanged && report.filesChanged.length > 0 && (
                  <div className="mb-3">
                    <p className="text-sm font-medium">Files Changed:</p>
                    <div className="flex flex-wrap gap-1">
                      {report.filesChanged.map((file: string, index: number) => (
                        <span key={index} className="px-2 py-1 text-xs bg-gray-100 rounded">
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