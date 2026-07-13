/**
 * Unified chronological history for activity, messages, and arm reports.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@heroui/react';
import {
  Activity,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  FileText,
  Inbox,
  Mail,
  RefreshCw,
  Search,
  Send,
} from 'lucide-react';
import { usePageTitle } from '@/hooks/usePageTitle';
import {
  api,
  type ActivityEntry,
  type JsonObject,
  type MailMessage,
  type StatusReport,
} from '@/lib/api';

type HistoryFilter = 'all' | 'logs' | 'messages' | 'reports';
type HistoryKind = 'activity' | 'inbox' | 'sent' | 'archive' | 'report';

interface HistoryItem {
  id: string;
  kind: HistoryKind;
  group: Exclude<HistoryFilter, 'all'>;
  timestamp: string;
  source: string;
  event: string;
  summary: string;
  target?: string;
  details: JsonObject;
}

const FILTERS: ReadonlyArray<{ key: HistoryFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'logs', label: 'Logs' },
  { key: 'messages', label: 'Messages' },
  { key: 'reports', label: 'Reports' },
];

function normalizedTimestamp(value: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
}

function safeTimestamp(value: string): number {
  const timestamp = Date.parse(normalizedTimestamp(value));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function formatTimestamp(value: string): string {
  return new Date(normalizedTimestamp(value)).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function titleCase(value: string): string {
  return value
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function activitySummary(entry: ActivityEntry): string {
  const detail = entry.details;
  const preferred = detail.message ?? detail.subject ?? detail.summary ?? detail.title;
  if (typeof preferred === 'string' && preferred.trim()) return preferred;
  if (entry.target) return `${titleCase(entry.action)} on ${entry.target}`;
  return titleCase(entry.action);
}

function mapActivity(entry: ActivityEntry, index: number): HistoryItem {
  return {
    id: `activity-${entry.id ?? `${entry.timestamp}-${index}`}`,
    kind: 'activity',
    group: 'logs',
    timestamp: entry.timestamp,
    source: entry.actor || 'brain',
    event: titleCase(entry.action),
    summary: activitySummary(entry),
    target: entry.target ?? undefined,
    details: entry.details,
  };
}

function mapMail(message: MailMessage, kind: 'inbox' | 'sent' | 'archive'): HistoryItem {
  const label = kind === 'inbox' ? 'Received' : kind === 'sent' ? 'Sent' : 'Archived';
  return {
    id: `${kind}-${message.id}`,
    kind,
    group: 'messages',
    timestamp: message.date,
    source: kind === 'sent' ? message.to : message.from,
    event: label,
    summary: message.subject,
    target: kind === 'sent' ? message.from : message.to,
    details: {
      from: message.from,
      to: message.to,
      subject: message.subject,
      body: message.body,
      headers: message.headers,
      flags: message.flags,
    },
  };
}

function mapReport(report: StatusReport): HistoryItem {
  return {
    id: `report-${report.id}`,
    kind: 'report',
    group: 'reports',
    timestamp: report.createdAt,
    source: report.armId,
    event: titleCase(report.status),
    summary: report.summary,
    target: report.taskId,
    details: {
      taskId: report.taskId,
      armId: report.armId,
      status: report.status,
      summary: report.summary,
      issues: report.issues ?? [],
      blockers: report.blockers ?? [],
      nextSteps: report.nextSteps ?? null,
      filesChanged: report.filesChanged ?? [],
      testsStatus: report.testsStatus ?? null,
    },
  };
}

function KindIcon({ kind }: { kind: HistoryKind }) {
  switch (kind) {
    case 'activity':
      return <Activity className="h-3.5 w-3.5" />;
    case 'inbox':
      return <Inbox className="h-3.5 w-3.5" />;
    case 'sent':
      return <Send className="h-3.5 w-3.5" />;
    case 'archive':
      return <Mail className="h-3.5 w-3.5" />;
    case 'report':
      return <FileText className="h-3.5 w-3.5" />;
  }
}

function kindLabel(kind: HistoryKind): string {
  if (kind === 'activity') return 'Log';
  if (kind === 'report') return 'Report';
  return titleCase(kind);
}

function detailsText(details: JsonObject): string {
  return JSON.stringify(details, null, 2);
}

export function StatusReportsPage() {
  usePageTitle('Coleo Observatory - History');

  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [searchText, setSearchText] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const [activityResponse, inboxResponse, sentResponse, archiveResponse, reportsResponse] =
        await Promise.all([
          api.listActivity({ limit: 100 }),
          api.listInbox({ limit: 100 }),
          api.listSent({ limit: 100 }),
          api.listArchive({ limit: 100 }),
          api.listStatusReports({ limit: 100 }),
        ]);

      const historyItems = [
        ...activityResponse.activity.map(mapActivity),
        ...inboxResponse.messages.map((message) => mapMail(message, 'inbox')),
        ...sentResponse.messages.map((message) => mapMail(message, 'sent')),
        ...archiveResponse.messages.map((message) => mapMail(message, 'archive')),
        ...reportsResponse.reports.map(mapReport),
      ].sort((left, right) => safeTimestamp(right.timestamp) - safeTimestamp(left.timestamp));

      setItems(historyItems);
      setExpandedId((current) =>
        current && historyItems.some((item) => item.id === current) ? current : null,
      );
    } catch (historyError) {
      setError(historyError instanceof Error ? historyError.message : 'Failed to load history');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const counts = useMemo(() => {
    const next = { all: items.length, logs: 0, messages: 0, reports: 0 };
    items.forEach((item) => {
      next[item.group] += 1;
    });
    return next;
  }, [items]);

  const filteredItems = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    return items.filter((item) => {
      if (filter !== 'all' && item.group !== filter) return false;
      if (!query) return true;
      return [item.source, item.event, item.summary, item.target, detailsText(item.details)]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
  }, [filter, items, searchText]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex items-center gap-2 border-b border-border bg-background px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
          <div className="relative w-56 shrink-0">
            <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              placeholder="Search history..."
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              className="h-9 w-full rounded-md border border-border bg-surface-secondary px-8 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
          <div className="shrink-0 text-xs text-muted-foreground">{filteredItems.length} entries</div>
          <div className="h-4 w-px shrink-0 bg-border" />
          {FILTERS.map((option) => (
            <button
              key={option.key}
              type="button"
              aria-pressed={filter === option.key}
              onClick={() => setFilter(option.key)}
              className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                filter === option.key
                  ? 'border-accent/40 bg-accent/10 text-accent'
                  : 'border-transparent text-muted-foreground hover:bg-surface-secondary hover:text-foreground'
              }`}
            >
              <span>{option.label}</span>
              <span>{counts[option.key]}</span>
            </button>
          ))}
        </div>
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          onPress={loadHistory}
          isDisabled={loading}
          aria-label="Refresh"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="m-3 flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        ) : null}

        {loading && items.length === 0 ? (
          <div className="flex h-48 items-center justify-center gap-2 text-muted-foreground">
            <RefreshCw className="h-5 w-5 animate-spin" />
            Loading history…
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="m-3 flex h-56 flex-col items-center justify-center rounded-lg border border-border bg-card text-center">
            <Activity className="mb-3 h-9 w-9 text-muted-foreground" />
            <div className="text-base font-medium">No history entries</div>
            <p className="mt-1 text-sm text-muted-foreground">Logs and messages will appear here chronologically.</p>
          </div>
        ) : (
          <HistoryGrid
            items={filteredItems}
            expandedId={expandedId}
            onToggle={(id) => setExpandedId((current) => (current === id ? null : id))}
          />
        )}
      </div>
    </div>
  );
}

function HistoryGrid({
  items,
  expandedId,
  onToggle,
}: {
  items: HistoryItem[];
  expandedId: string | null;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="overflow-x-auto bg-card">
      <table className="w-full min-w-[860px] table-fixed border-collapse text-left">
        <colgroup>
          <col className="w-9" />
          <col className="w-36" />
          <col className="w-24" />
          <col className="w-40" />
          <col className="w-44" />
          <col />
        </colgroup>
        <thead className="bg-background text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          <tr className="border-b border-border">
            <th aria-label="Expand" className="px-2 py-2" />
            <th className="px-2 py-2">Time</th>
            <th className="px-2 py-2">Type</th>
            <th className="px-2 py-2">Source</th>
            <th className="px-2 py-2">Event</th>
            <th className="px-2 py-2">Summary</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const isExpanded = expandedId === item.id;
            return (
              <HistoryRow key={item.id} item={item} isExpanded={isExpanded} onToggle={onToggle} />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function HistoryRow({
  item,
  isExpanded,
  onToggle,
}: {
  item: HistoryItem;
  isExpanded: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <>
      <tr className={`border-b border-border text-xs last:border-b-0 ${isExpanded ? 'bg-accent/5' : 'hover:bg-surface-secondary/50'}`}>
        <td className="px-2 py-1.5">
          <button
            type="button"
            onClick={() => onToggle(item.id)}
            aria-expanded={isExpanded}
            aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${item.summary}`}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-surface-secondary hover:text-foreground"
          >
            {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        </td>
        <td className="whitespace-nowrap px-2 py-1.5 text-muted-foreground">{formatTimestamp(item.timestamp)}</td>
        <td className="px-2 py-1.5">
          <span className="inline-flex items-center gap-1 rounded border border-border bg-surface-secondary px-1.5 py-0.5">
            <KindIcon kind={item.kind} />
            {kindLabel(item.kind)}
          </span>
        </td>
        <td className="truncate px-2 py-1.5 font-medium" title={item.source}>{item.source}</td>
        <td className="truncate px-2 py-1.5 text-muted-foreground" title={item.event}>{item.event}</td>
        <td className="px-2 py-1.5">
          <button
            type="button"
            onClick={() => onToggle(item.id)}
            aria-expanded={isExpanded}
            className="block w-full truncate text-left text-foreground hover:text-accent"
            title={item.summary}
          >
            {item.summary}
            {item.target ? <span className="ml-2 text-muted-foreground">· {item.target}</span> : null}
          </button>
        </td>
      </tr>
      {isExpanded ? (
        <tr className="border-b border-border bg-surface-secondary/30">
          <td colSpan={6} className="p-0">
            <div className="max-h-56 overflow-auto px-4 py-3">
              <div className="mb-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                <span><span className="font-medium text-foreground">Time:</span> {new Date(normalizedTimestamp(item.timestamp)).toLocaleString()}</span>
                <span><span className="font-medium text-foreground">Source:</span> {item.source}</span>
                {item.target ? <span><span className="font-medium text-foreground">Target:</span> {item.target}</span> : null}
              </div>
              <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 font-mono text-xs leading-5 text-foreground">
                {detailsText(item.details)}
              </pre>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
