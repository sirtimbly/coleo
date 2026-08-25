import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components';
import type { CommandQueueHealth } from '@/lib';

export interface CommandQueueChartProps {
  health?: CommandQueueHealth | null;
  loading?: boolean;
  className?: string;
  title?: string;
  maxSamples?: number;
}

interface QueueSample {
  timestamp: number;
  depth: number;
  inFlight: number;
  oldestPendingAgeMs: number | null;
  avgCompletedLatencyMs: number | null;
}

function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / (60 * 60_000))}h`;
}

export function CommandQueueChart({
  health,
  loading = false,
  className,
  title = 'Command Queue',
  maxSamples = 60,
}: CommandQueueChartProps) {
  const [samples, setSamples] = useState<QueueSample[]>([]);

  useEffect(() => {
    if (!health?.updatedAt) return;

    const timestamp = new Date(health.updatedAt).getTime() || Date.now();
    const depth = (health.lagMessages ?? 0) + (health.ackPending ?? 0);

    setSamples((current) => {
      const next = [
        ...current,
        {
          timestamp,
          depth,
          inFlight: health.ackPending ?? 0,
          oldestPendingAgeMs: health.oldestPendingAgeMs ?? null,
          avgCompletedLatencyMs: health.avgCompletedLatencyMs ?? null,
        },
      ];
      return next.slice(-maxSamples);
    });
  }, [health, maxSamples]);

  const visibleSamples = useMemo(() => {
    if (samples.length < 2) return samples;
    const cutoff = Date.now() - 30 * 60 * 1000;
    const filtered = samples.filter((s) => s.timestamp >= cutoff);
    return filtered.length >= 2 ? filtered : samples.slice(-2);
  }, [samples]);

  const depthMax = useMemo(() => {
    const peak = Math.max(1, ...visibleSamples.map((s) => s.depth));
    return Math.ceil(peak * 1.15);
  }, [visibleSamples]);

  const latencyMax = useMemo(() => {
    const values = visibleSamples
      .map((s) => s.avgCompletedLatencyMs ?? s.oldestPendingAgeMs ?? 0)
      .filter((v) => v > 0);
    const peak = values.length > 0 ? Math.max(...values) : 1;
    return Math.ceil(peak * 1.15);
  }, [visibleSamples]);

  const width = 600;
  const height = 180;
  const padLeft = 40;
  const padRight = 48;
  const padTop = 16;
  const padBottom = 28;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  const windowStart = visibleSamples[0]?.timestamp ?? Date.now();
  const windowEnd = visibleSamples.at(-1)?.timestamp ?? Date.now();

  const depthPath = useMemo(() => {
    if (visibleSamples.length === 0) return '';
    const x = (timestamp: number) => {
      if (windowEnd <= windowStart) return padLeft;
      return padLeft + ((timestamp - windowStart) / (windowEnd - windowStart)) * plotWidth;
    };
    const y = (value: number) => {
      if (depthMax <= 0) return padTop + plotHeight;
      return padTop + plotHeight - (value / depthMax) * plotHeight;
    };
    return visibleSamples
      .map((s, i) => `${i === 0 ? 'M' : 'L'} ${x(s.timestamp)} ${y(s.depth)}`)
      .join(' ');
  }, [visibleSamples, windowStart, windowEnd, plotWidth, plotHeight, depthMax]);

  const inFlightPath = useMemo(() => {
    if (visibleSamples.length === 0) return '';
    const x = (timestamp: number) => {
      if (windowEnd <= windowStart) return padLeft;
      return padLeft + ((timestamp - windowStart) / (windowEnd - windowStart)) * plotWidth;
    };
    const y = (value: number) => {
      if (depthMax <= 0) return padTop + plotHeight;
      return padTop + plotHeight - (value / depthMax) * plotHeight;
    };
    return visibleSamples
      .map((s, i) => `${i === 0 ? 'M' : 'L'} ${x(s.timestamp)} ${y(s.inFlight)}`)
      .join(' ');
  }, [visibleSamples, windowStart, windowEnd, plotWidth, plotHeight, depthMax]);

  const latencyPath = useMemo(() => {
    if (visibleSamples.length === 0) return '';
    const x = (timestamp: number) => {
      if (windowEnd <= windowStart) return padLeft;
      return padLeft + ((timestamp - windowStart) / (windowEnd - windowStart)) * plotWidth;
    };
    const y = (value: number) => {
      if (latencyMax <= 0) return padTop + plotHeight;
      return padTop + plotHeight - (value / latencyMax) * plotHeight;
    };
    return visibleSamples
      .map((s, i) => {
        const value = s.avgCompletedLatencyMs ?? s.oldestPendingAgeMs ?? 0;
        return `${i === 0 ? 'M' : 'L'} ${x(s.timestamp)} ${y(value)}`;
      })
      .join(' ');
  }, [visibleSamples, windowStart, windowEnd, plotWidth, plotHeight, latencyMax]);

  const gridLines = useMemo(() => {
    const count = 4;
    return Array.from({ length: count + 1 }, (_, i) => {
      const y = padTop + (plotHeight / count) * i;
      return (
        <line
          key={`grid-${i}`}
          x1={padLeft}
          y1={y}
          x2={width - padRight}
          y2={y}
          stroke="currentColor"
          className="text-border opacity-40"
          strokeDasharray="2 2"
        />
      );
    });
  }, [plotHeight]);

  const current = visibleSamples.at(-1);

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          {title}
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {visibleSamples.length < 2 ? (
          <div className="flex h-[180px] items-center justify-center text-xs text-muted-foreground">
            Collecting queue samples…
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-4 text-xs">
              <div className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full bg-foreground" />
                <span className="text-muted-foreground">Depth:</span>
                <span className="font-medium">{current?.depth ?? '-'}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full bg-warning" />
                <span className="text-muted-foreground">In flight:</span>
                <span className="font-medium">{current?.inFlight ?? '-'}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full bg-accent" />
                <span className="text-muted-foreground">Latency:</span>
                <span className="font-medium">
                  {formatDuration(current?.avgCompletedLatencyMs ?? current?.oldestPendingAgeMs ?? null)}
                </span>
              </div>
            </div>
            <svg
              viewBox={`0 0 ${width} ${height}`}
              className="w-full overflow-visible"
              role="img"
              aria-label="Command queue depth and latency over time"
            >
              {gridLines}

              {/* Depth line */}
              <path
                d={depthPath}
                fill="none"
                stroke="currentColor"
                className="text-foreground"
                strokeWidth={2}
              />

              {/* In-flight line */}
              <path
                d={inFlightPath}
                fill="none"
                stroke="currentColor"
                className="text-warning"
                strokeWidth={2}
                strokeDasharray="4 3"
              />

              {/* Latency line */}
              <path
                d={latencyPath}
                fill="none"
                stroke="currentColor"
                className="text-accent"
                strokeWidth={2}
              />

              {/* Left axis labels (depth) */}
              <text x={padLeft - 8} y={padTop + 4} textAnchor="end" fontSize={10} className="fill-muted-foreground">
                {depthMax}
              </text>
              <text x={padLeft - 8} y={padTop + plotHeight} textAnchor="end" fontSize={10} className="fill-muted-foreground">
                0
              </text>

              {/* Right axis labels (latency) */}
              <text x={width - padRight + 8} y={padTop + 4} textAnchor="start" fontSize={10} className="fill-muted-foreground">
                {formatDuration(latencyMax)}
              </text>
              <text x={width - padRight + 8} y={padTop + plotHeight} textAnchor="start" fontSize={10} className="fill-muted-foreground">
                0
              </text>
            </svg>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
