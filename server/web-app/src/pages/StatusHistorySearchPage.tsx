import { useDeferredValue, useState } from 'react';
import { Button, Chip } from '@heroui/react';
import { CalendarDays, ChevronDown, ChevronRight, Clock3, Search, Sparkles } from 'lucide-react';
import { usePageTitle } from '@/hooks/usePageTitle';
import { api, type StatusHistorySearchHit } from '@/lib/api';

const EVENT_TYPES = ['status_report', 'task_completion', 'discovery', 'bug_report'] as const;

function formatTimestamp(timestamp: string): string {
  return new Date(timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function isoDate(value: string, end = false): string | undefined {
  return value ? new Date(`${value}T${end ? '23:59:59.999' : '00:00:00.000'}`).toISOString() : undefined;
}

export function StatusHistorySearchPage() {
  usePageTitle('Coleo Observatory - Search History');
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [armId, setArmId] = useState('');
  const [eventType, setEventType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [timeline, setTimeline] = useState(false);
  const [results, setResults] = useState<StatusHistorySearchHit[]>([]);
  const [total, setTotal] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    if (!deferredQuery.trim()) { setError('Enter a question or phrase to search history.'); return; }
    setLoading(true); setError(null);
    try {
      const response = await api.searchStatusHistory({ query: deferredQuery.trim(), armIds: armId.trim() ? [armId.trim()] : undefined, eventTypes: eventType ? [eventType] : undefined, from: isoDate(from), to: isoDate(to, true), limit: 50 });
      setResults(timeline ? [...response.results].sort((a, b) => a.event.timestamp.localeCompare(b.event.timestamp)) : response.results);
      setTotal(response.total); setExpanded(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'History search is unavailable.'); setResults([]); setTotal(0);
    } finally { setLoading(false); }
  };

  return <div className="flex h-full min-h-0 flex-col bg-background">
    <header className="border-b border-border px-5 py-5"><div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Semantic archive</p><h1 className="mt-1 text-2xl font-semibold tracking-tight">Search operational memory</h1><p className="mt-1 text-sm text-muted-foreground">Find decisions, blockers, completions, and discoveries across every arm.</p></div><Button size="sm" variant={timeline ? 'secondary' : 'ghost'} onPress={() => setTimeline((value) => !value)}><Clock3 className="mr-1.5 h-4 w-4" />{timeline ? 'Timeline view' : 'Ranked view'}</Button></div>
      <div className="mt-5 flex gap-2"><div className="relative flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-500" /><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void search(); }} placeholder="What happened with the migration rollout?" className="h-11 w-full rounded-lg border border-border bg-content1 pl-10 pr-3 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20" /></div><Button variant="primary" className="h-11" isDisabled={loading} onPress={() => void search()}><Sparkles className="mr-1.5 h-4 w-4" />{loading ? 'Searching' : 'Search'}</Button></div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4"><label className="text-xs text-foreground-500">Arm ID<input value={armId} onChange={(event) => setArmId(event.target.value)} placeholder="Any arm" className="mt-1 h-9 w-full rounded-md border border-border bg-content1 px-2 text-sm" /></label><label className="text-xs text-foreground-500">Event type<select value={eventType} onChange={(event) => setEventType(event.target.value)} className="mt-1 h-9 w-full rounded-md border border-border bg-content1 px-2 text-sm"><option value="">All events</option>{EVENT_TYPES.map((type) => <option key={type} value={type}>{type.replaceAll('_', ' ')}</option>)}</select></label><label className="text-xs text-foreground-500"><CalendarDays className="mr-1 inline h-3 w-3" />From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="mt-1 h-9 w-full rounded-md border border-border bg-content1 px-2 text-sm" /></label><label className="text-xs text-foreground-500">To<input type="date" value={to} onChange={(event) => setTo(event.target.value)} className="mt-1 h-9 w-full rounded-md border border-border bg-content1 px-2 text-sm" /></label></div>
    </div></header>
    <main className="min-h-0 flex-1 overflow-y-auto px-5 py-5"><div className="mx-auto max-w-6xl">
      {error ? <div className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div> : null}
      {!error && !loading && results.length === 0 ? <div className="rounded-xl border border-dashed border-border bg-content1/40 px-6 py-14 text-center"><Search className="mx-auto h-7 w-7 text-foreground-400" /><p className="mt-3 font-medium">Search the history, not just the latest state.</p><p className="mt-1 text-sm text-muted-foreground">Results include preserved status reports, discoveries, completions, and bug context.</p></div> : null}
      {results.length ? <div className="mb-3 flex justify-between text-sm text-muted-foreground"><span>{total} matching events</span><span>{timeline ? 'Oldest first' : 'Best semantic matches first'}</span></div> : null}
      <div className={timeline ? 'border-l-2 border-accent/30 pl-5' : 'space-y-3'}>{results.map((hit) => { const open = expanded === hit.event.id; return <article key={hit.event.id} className={`relative rounded-xl border border-border bg-content1 p-4 ${timeline ? 'mb-3 before:absolute before:-left-[1.7rem] before:top-5 before:h-3 before:w-3 before:rounded-full before:bg-accent' : ''}`}><div className="flex justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><Chip size="sm" variant="secondary" className="capitalize">{hit.event.type.replaceAll('_', ' ')}</Chip>{hit.event.armId ? <span className="font-mono text-xs text-foreground-500">{hit.event.armId}</span> : null}</div><h2 className="mt-2 font-medium">{hit.event.title}</h2><p className="mt-1 whitespace-pre-wrap text-sm text-foreground-600">{hit.event.content}</p></div><time className="shrink-0 text-xs text-foreground-500">{formatTimestamp(hit.event.timestamp)}</time></div>{hit.highlights.length ? <div className="mt-3 rounded-md border-l-2 border-accent bg-accent/5 px-3 py-2 text-sm text-foreground-600">{hit.highlights[0]}</div> : null}<div className="mt-3 flex justify-between"><span className="text-xs text-foreground-500">Match {Math.round(hit.score * 100)}%</span><button type="button" className="inline-flex items-center text-xs font-medium text-accent hover:underline" onClick={() => setExpanded(open ? null : hit.event.id)}>{open ? <ChevronDown className="mr-1 h-3.5 w-3.5" /> : <ChevronRight className="mr-1 h-3.5 w-3.5" />}{open ? 'Hide full context' : 'Show full context'}</button></div>{open ? <pre className="mt-3 max-h-80 overflow-auto rounded-md bg-content2 p-3 text-xs leading-5 text-foreground-600">{JSON.stringify(hit.event, null, 2)}</pre> : null}</article>; })}</div>
    </div></main>
  </div>;
}
