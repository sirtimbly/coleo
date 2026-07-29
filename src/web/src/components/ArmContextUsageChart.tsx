import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api } from '@/lib';
import { Card, CardContent, CardHeader, CardTitle } from '@/components';
import {
  COMPRESSION_THRESHOLD_PCT,
  MAX_STORED_SAMPLES,
  SAMPLE_INTERVAL_MS,
  SAMPLE_WINDOW_MS,
  STORAGE_PREFIX,
  type ContextSample,
} from './arm-context-usage-helpers';

export type { ContextSample };

/**
 * ArmContextUsageChart
 *
 * Higher-resolution context-length line graph placed below the activity graph.
 * Samples the arm's `context.used` and `context.budget` every ~12 seconds (and
 * optionally accepts higher-resolution samples pushed by callers such as
 * step-finish token events) and renders an SVG line chart with the 80%
 * compression threshold and a shaded warning zone above it.
 *
 * Samples are persisted in localStorage keyed by armId so a brief navigator
 * refresh keeps recent context history.
 */

interface ArmContextUsageChartProps {
  armId: string | null;
  samples?: ContextSample[];
  range?: { start: number; end: number };
  title?: string;
  className?: string;
  embedded?: boolean;
  compact?: boolean;
}

function getStorageKey(armId: string): string {
  return `${STORAGE_PREFIX}${armId}`;
}

function loadStoredSamples(armId: string): ContextSample[] {
  try {
    const stored = localStorage.getItem(getStorageKey(armId));
    if (!stored) return [];
    const parsed = JSON.parse(stored) as ContextSample[];
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - SAMPLE_WINDOW_MS;
    return parsed.filter((sample) => sample.timestamp >= cutoff);
  } catch {
    return [];
  }
}

function normalizeHistoryResponse(samples: Array<{ timestamp: string; used: number; budget: number }>): ContextSample[] {
  return samples
    .map((sample) => ({
      timestamp: new Date(sample.timestamp).getTime(),
      used: sample.used,
      budget: sample.budget,
    }))
    .filter((sample) => Number.isFinite(sample.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp);
}

function trimAndPersistSamples(
  armId: string,
  samples: ContextSample[],
  setSamples: (next: ContextSample[]) => void,
  storedRef: { current: ContextSample[] },
): void {
  const cutoff = Date.now() - SAMPLE_WINDOW_MS;
  const next = samples
    .filter((sample) => sample.timestamp >= cutoff)
    .slice(-MAX_STORED_SAMPLES);
  storedRef.current = next;
  saveStoredSamples(armId, next);
  setSamples(next);
}

function saveStoredSamples(armId: string, samples: ContextSample[]): void {
  try {
    const payload = samples.slice(-MAX_STORED_SAMPLES);
    localStorage.setItem(getStorageKey(armId), JSON.stringify(payload));
  } catch {
    void armId;
  }
}

export function ArmContextUsageChart({
  armId,
  samples: externalSamples,
  range,
  title = 'Context Usage',
  className,
  embedded = false,
  compact = false,
}: ArmContextUsageChartProps) {
  const [samples, setSamples] = useState<ContextSample[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const storedRef = useRef<ContextSample[]>([]);

  useEffect(() => {
    if (externalSamples) {
      const sorted = externalSamples.slice().sort((left, right) => left.timestamp - right.timestamp);
      storedRef.current = sorted;
      setSamples(sorted);
      setLoading(false);
      setError(null);
      return;
    }
    if (!armId) {
      setSamples([]);
      storedRef.current = [];
      return;
    }
    const restored = loadStoredSamples(armId);
    storedRef.current = restored.slice(-MAX_STORED_SAMPLES);
    setSamples(restored);
  }, [armId, externalSamples]);

  useEffect(() => {
    if (externalSamples) return;
    if (!armId) return;
    let cancelled = false;

    const refresh = async () => {
      if (cancelled) return;
      setLoading(true);
      try {
        const response = await api.getArmContextHistory(armId, SAMPLE_WINDOW_MS);
        if (cancelled) return;
        const nextSamples = normalizeHistoryResponse(response.samples);
        trimAndPersistSamples(armId, nextSamples, setSamples, storedRef);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to fetch context');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void refresh();
    const interval = setInterval(refresh, SAMPLE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [armId, externalSamples]);

  const windowEnd = range?.end ?? Date.now();
  const windowStart = range?.start ?? windowEnd - SAMPLE_WINDOW_MS;
  const visibleSamples = samples.filter(
    (sample) => sample.timestamp >= windowStart && sample.timestamp <= windowEnd,
  );

  const budget = visibleSamples.length === 0
    ? 0
    : Math.max(...visibleSamples.map((s) => s.budget));
  const maxUsed = visibleSamples.length === 0 ? 0 : Math.max(...visibleSamples.map((s) => s.used));
  const headroom = Math.max(1, Math.floor(budget * 0.1));
  const chartMax = Math.max(budget, maxUsed + headroom);
  const threshold = budget * COMPRESSION_THRESHOLD_PCT;

  const width = 600;
  const height = compact ? 105 : 140;
  const padLeft = compact ? 40 : 48;
  const padRight = 16;
  const padTop = compact ? 10 : 14;
  const padBottom = compact ? 18 : 24;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  const xScale = (timestamp: number): number => {
    if (windowEnd <= windowStart) return padLeft;
    const ratio = (timestamp - windowStart) / (windowEnd - windowStart);
    return padLeft + ratio * plotWidth;
  };
  const yScale = (value: number): number => {
    if (chartMax <= 0) return padTop + plotHeight;
    const clamped = Math.max(0, Math.min(value, chartMax));
    const ratio = clamped / chartMax;
    return padTop + plotHeight - ratio * plotHeight;
  };

  const areaPath = (() => {
    if (visibleSamples.length === 0) return '';
    const firstX = xScale(visibleSamples[0]!.timestamp);
    const lastX = xScale(visibleSamples[visibleSamples.length - 1]!.timestamp);
    const baseY = padTop + plotHeight;
    const topPoints = visibleSamples
      .map((sample) => `L${xScale(sample.timestamp).toFixed(2)},${yScale(sample.used).toFixed(2)}`)
      .join(' ');
    return `M${firstX.toFixed(2)},${baseY} ${topPoints} L${lastX.toFixed(2)},${baseY} Z`;
  })();

  const linePoints = visibleSamples
    .map((sample) => `${xScale(sample.timestamp)},${yScale(sample.used)}`)
    .join(' ');

  const thresholdY = yScale(threshold);
  const budgetY = yScale(budget);
  const warningZoneFill = 'rgba(239, 68, 68, 0.12)';
  const gridColor = '#e5e7eb';
  const labelColor = '#6b7280';
  const lineColor = '#3b82f6';
  const areaFill = 'rgba(59, 130, 246, 0.12)';
  const thresholdColor = '#f97316';
  const budgetLineColor = '#ef4444';

  const formatTokens = (value: number): string => {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
    return String(value);
  };

  const formatTime = (timestamp: number): string => {
    const date = new Date(timestamp);
    return windowEnd - windowStart >= 24 * 60 * 60 * 1000
      ? date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const hoveredSample = hovered === null ? null : visibleSamples[hovered] ?? null;

  const inner = (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        {compact ? (
          <span>{`Context usage · ${new Date(windowStart).toLocaleString()} - ${new Date(windowEnd).toLocaleString()}`}</span>
        ) : (
          <>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: lineColor }} />
              Context tokens used
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: thresholdColor }} />
              80% compression threshold
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: budgetLineColor }} />
              Context limit (budget)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-3 w-3 rounded-sm" style={{ backgroundColor: warningZoneFill }} />
              Warning zone
            </span>
            <span className="text-[0.7rem]">
              {externalSamples
                ? `${visibleSamples.length} persisted aggregate samples`
                : `Samples every ~${Math.round(SAMPLE_INTERVAL_MS / 1000)}s`}
            </span>
          </>
        )}
      </div>

      {loading && visibleSamples.length === 0 ? (
        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground" style={{ height: compact ? 90 : 120 }}>
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading context samples...</span>
        </div>
      ) : error ? (
        <div className="flex items-center justify-center rounded-md border border-danger/30 bg-danger/10 text-sm text-danger" style={{ height: compact ? 90 : 120 }}>
          {error}
        </div>
      ) : visibleSamples.length === 0 ? (
        <div className="flex items-center justify-center rounded-md border border-dashed border-border bg-surface-secondary/35 text-sm text-muted-foreground" style={{ height: compact ? 90 : 120 }}>
          No context samples in the selected range.
        </div>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="w-full"
            style={{ maxHeight: height }}
            role="img"
            aria-label={`Arm context token usage from ${new Date(windowStart).toLocaleString()} to ${new Date(windowEnd).toLocaleString()}`}
            onMouseLeave={() => setHovered(null)}
            onMouseMove={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const pointerX = (event.clientX - rect.left) / rect.width * width;
              const offset = pointerX - padLeft;
              if (offset < 0 || offset > plotWidth) {
                setHovered(null);
                return;
              }
              const targetX = (offset / plotWidth) * (windowEnd - windowStart) + windowStart;
              let nearestIndex = -1;
              let nearestDistance = Number.POSITIVE_INFINITY;
              visibleSamples.forEach((sample, index) => {
                const distance = Math.abs(sample.timestamp - targetX);
                if (distance < nearestDistance) {
                  nearestDistance = distance;
                  nearestIndex = index;
                }
              });
              setHovered(nearestIndex >= 0 ? nearestIndex : null);
            }}
          >
            {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
              const y = padTop + (1 - fraction) * plotHeight;
              return (
                <line
                  key={`grid-${fraction}`}
                  x1={padLeft}
                  x2={width - padRight}
                  y1={y}
                  y2={y}
                  stroke={gridColor}
                  strokeWidth={1}
                />
              );
            })}
            <text x={4} y={padTop + 8} fill={labelColor} fontSize={10}>
              {formatTokens(chartMax)}
            </text>
            <text x={6} y={padTop + plotHeight - 2} fill={labelColor} fontSize={10}>
              0
            </text>
            {budget > 0 && (
              <>
                <rect
                  x={padLeft}
                  y={budgetY}
                  width={plotWidth}
                  height={Math.max(0, thresholdY - budgetY)}
                  fill={warningZoneFill}
                />
                <line
                  x1={padLeft}
                  x2={width - padRight}
                  y1={budgetY}
                  y2={budgetY}
                  stroke={budgetLineColor}
                  strokeWidth={2}
                  strokeDasharray="4 3"
                />
                <line
                  x1={padLeft}
                  x2={width - padRight}
                  y1={thresholdY}
                  y2={thresholdY}
                  stroke={thresholdColor}
                  strokeWidth={2}
                  strokeDasharray="6 4"
                />
                <text x={padLeft + 4} y={Math.max(padTop + 10, thresholdY - 4)} fill={thresholdColor} fontSize={10}>
                  80% threshold
                </text>
                <text x={width - padRight - 4} y={Math.max(padTop + 10, budgetY - 4)} textAnchor="end" fill={budgetLineColor} fontSize={10}>
                  Budget
                </text>
              </>
            )}
            <text x={padLeft} y={height - 6} fill={labelColor} fontSize={10}>
              {new Date(windowStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </text>
            <text x={width - padRight} y={height - 6} textAnchor="end" fill={labelColor} fontSize={10}>
              {visibleSamples.length > 0
                ? formatTime(visibleSamples[visibleSamples.length - 1]!.timestamp)
                : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </text>
            {visibleSamples.length === 0 ? null : (
              <>
                <path d={areaPath} fill={areaFill} />
                {visibleSamples.map((sample, index) => (
                  <circle
                    key={`dot-${index}-${sample.timestamp}`}
                    cx={xScale(sample.timestamp)}
                    cy={yScale(sample.used)}
                    r={2}
                    fill={lineColor}
                  />
                ))}
                <polyline
                  points={linePoints}
                  fill="none"
                  stroke={lineColor}
                  strokeWidth={2}
                  strokeLinejoin="round"
                />
              </>
            )}
            {hovered !== null && hoveredSample ? (
              <line
                x1={xScale(hoveredSample.timestamp)}
                x2={xScale(hoveredSample.timestamp)}
                y1={padTop}
                y2={padTop + plotHeight}
                stroke="#9ca3af"
                strokeDasharray="3 3"
              />
            ) : null}
          </svg>
          {hoveredSample ? (
            <div
              className="pointer-events-none absolute right-2 top-2 z-10 rounded-md border border-border bg-background/95 px-3 py-2 text-xs shadow"
              style={{ width: compact ? 180 : 200 }}
            >
              <div className="font-semibold">{formatTime(hoveredSample.timestamp)}</div>
              <div className="mt-1 grid gap-0.5">
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Used</span>
                  <span className="font-medium">{formatTokens(hoveredSample.used)}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Budget</span>
                  <span className="font-medium">{formatTokens(hoveredSample.budget)}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Utilization</span>
                  <span className="font-medium">
                    {hoveredSample.budget > 0
                      ? `${((hoveredSample.used / hoveredSample.budget) * 100).toFixed(1)}%`
                      : '—'}
                  </span>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );

  if (embedded) {
    return <div className={className}>{inner}</div>;
  }
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          <span>{title}</span>
          <span className="text-xs font-normal text-muted-foreground">
            Context token usage · 80% compression threshold · warning zone
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>{inner}</CardContent>
    </Card>
  );
}
