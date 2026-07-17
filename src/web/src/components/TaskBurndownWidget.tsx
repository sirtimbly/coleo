import { useEffect, useRef, useState } from 'react';
import { Download, ImageDown } from 'lucide-react';
import { api } from '@/lib';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/Card';

type Bin = 'hour' | 'day';
type Range = '7d' | '30d' | 'custom';
type Bucket = Awaited<ReturnType<typeof api.getTaskBurndown>>['buckets'][number];

interface TaskBurndownWidgetProps {
  refreshKey: number;
}

const toDateValue = (date: Date) => date.toISOString().slice(0, 10);

export function TaskBurndownWidget({ refreshKey }: TaskBurndownWidgetProps) {
  const [bin, setBin] = useState<Bin>('day');
  const [range, setRange] = useState<Range>('7d');
  const [customStart, setCustomStart] = useState(toDateValue(new Date(Date.now() - 6 * 86400000)));
  const [customEnd, setCustomEnd] = useState(toDateValue(new Date()));
  const [status, setStatus] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [domain, setDomain] = useState('');
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreated, setShowCreated] = useState(true);
  const [showCompleted, setShowCompleted] = useState(true);
  const [hovered, setHovered] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const end = new Date();
    const start = range === 'custom'
      ? new Date(`${customStart}T00:00:00`)
      : new Date(end.getTime() - (range === '30d' ? 29 : 6) * 86400000);
    if (range === 'custom') end.setTime(new Date(`${customEnd}T23:59:59.999`).getTime());
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) return;
    let active = true;
    setLoading(true);
    void api.getTaskBurndown({
      start: start.toISOString(), end: end.toISOString(), bin,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      status: status || undefined, assignedTo: assignedTo || undefined, domain: domain || undefined,
    }).then((result) => {
      if (active) setBuckets(result.buckets);
    }).catch(() => {
      if (active) setBuckets([]);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [assignedTo, bin, customEnd, customStart, domain, range, refreshKey, status]);

  const exportCsv = () => {
    const rows = ['bucket,created,completed,cumulative_created,cumulative_completed', ...buckets.map((bucket) =>
      `${bucket.bucket},${bucket.created},${bucket.completed},${bucket.cumulativeCreated},${bucket.cumulativeCompleted}`)];
    download(new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' }), 'task-burndown.csv');
  };

  const exportPng = () => {
    const svg = svgRef.current;
    if (!svg) return;
    const image = new Image();
    const markup = new XMLSerializer().serializeToString(svg);
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 900; canvas.height = 260;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => blob && download(blob, 'task-burndown.png'));
    };
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  };

  const max = Math.max(1, ...buckets.flatMap((bucket) => [bucket.created, bucket.completed]));
  const point = (bucket: Bucket, index: number, value: 'created' | 'completed') => {
    const x = buckets.length < 2 ? 450 : 42 + index * 816 / (buckets.length - 1);
    return `${x},${226 - bucket[value] / max * 184}`;
  };
  const line = (value: 'created' | 'completed') => buckets.map((bucket, index) => point(bucket, index, value)).join(' ');
  const selected = hovered === null ? null : buckets[hovered];

  return <Card className="xl:col-span-2">
    <CardHeader>
      <CardTitle className="flex flex-wrap items-center justify-between gap-2">
        <span>Task Burndown</span>
        <span className="text-xs font-normal text-muted-foreground">Local time, real-time</span>
      </CardTitle>
    </CardHeader>
    <CardContent className="space-y-3">
      <div className="flex flex-wrap gap-2 text-xs">
        <select value={range} onChange={(event) => setRange(event.target.value as Range)} className="rounded border border-border bg-background px-2 py-1">
          <option value="7d">Last 7 days</option><option value="30d">Last 30 days</option><option value="custom">Custom range</option>
        </select>
        <select value={bin} onChange={(event) => setBin(event.target.value as Bin)} className="rounded border border-border bg-background px-2 py-1">
          <option value="day">Daily</option><option value="hour">Hourly</option>
        </select>
        {range === 'custom' && <><input aria-label="Burndown start date" type="date" value={customStart} onChange={(event) => setCustomStart(event.target.value)} className="rounded border border-border bg-background px-2 py-1" /><input aria-label="Burndown end date" type="date" value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} className="rounded border border-border bg-background px-2 py-1" /></>}
        <input aria-label="Filter task status" placeholder="Status" value={status} onChange={(event) => setStatus(event.target.value)} className="w-24 rounded border border-border bg-background px-2 py-1" />
        <input aria-label="Filter assignee" placeholder="Assignee" value={assignedTo} onChange={(event) => setAssignedTo(event.target.value)} className="w-24 rounded border border-border bg-background px-2 py-1" />
        <input aria-label="Filter domain" placeholder="Team/domain" value={domain} onChange={(event) => setDomain(event.target.value)} className="w-28 rounded border border-border bg-background px-2 py-1" />
        <button type="button" onClick={exportCsv} className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 hover:bg-default-100"><Download className="h-3 w-3" />CSV</button>
        <button type="button" onClick={exportPng} className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 hover:bg-default-100"><ImageDown className="h-3 w-3" />PNG</button>
      </div>
      <div className="flex gap-4 text-xs">
        <button type="button" onClick={() => setShowCreated(!showCreated)} className={showCreated ? 'text-blue-600' : 'text-muted-foreground line-through'}><span className="mr-1 inline-block h-2 w-2 rounded-full bg-blue-500" />Created</button>
        <button type="button" onClick={() => setShowCompleted(!showCompleted)} className={showCompleted ? 'text-green-600' : 'text-muted-foreground line-through'}><span className="mr-1 inline-block h-2 w-2 rounded-full bg-green-500" />Completed</button>
      </div>
      {loading ? <div className="h-56 animate-pulse rounded bg-secondary" /> : buckets.length === 0 ? <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">No task activity for the selected range.</div> : <div className="relative">
        <svg ref={svgRef} viewBox="0 0 900 260" className="h-56 w-full" role="img" aria-label="Tasks created and completed over time" onMouseLeave={() => setHovered(null)} onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const x = (event.clientX - rect.left) / rect.width * 900;
           setHovered(Math.max(0, Math.min(buckets.length - 1, Math.round((x - 42) / 816 * (buckets.length - 1)))));
        }}>
          {[42, 88, 134, 180, 226].map((y) => <line key={y} x1="42" x2="858" y1={y} y2={y} stroke="#e5e7eb" strokeWidth="1" />)}
          <text x="4" y="46" fill="#6b7280" fontSize="11">{max}</text><text x="12" y="230" fill="#6b7280" fontSize="11">0</text>
          {showCreated && <polyline points={line('created')} fill="none" stroke="#3b82f6" strokeWidth="3" strokeLinejoin="round" />}
          {showCompleted && <polyline points={line('completed')} fill="none" stroke="#22c55e" strokeWidth="3" strokeLinejoin="round" />}
          {hovered !== null && <line x1={point(buckets[hovered], hovered, 'created').split(',')[0]} x2={point(buckets[hovered], hovered, 'created').split(',')[0]} y1="42" y2="226" stroke="#9ca3af" strokeDasharray="3 3" />}
          <text x="42" y="252" fill="#6b7280" fontSize="11">{buckets[0]?.bucket}</text><text x="858" y="252" textAnchor="end" fill="#6b7280" fontSize="11">{buckets.at(-1)?.bucket}</text>
        </svg>
        {selected && <div className="pointer-events-none absolute right-2 top-2 rounded border border-border bg-background/95 px-2 py-1 text-xs shadow"><strong>{selected.bucket}</strong><br />Created: {selected.created} ({selected.cumulativeCreated} cumulative)<br />Completed: {selected.completed} ({selected.cumulativeCompleted} cumulative)</div>}
      </div>}
    </CardContent>
  </Card>;
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  URL.revokeObjectURL(url);
}
