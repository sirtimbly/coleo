import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api } from '@/lib';
import { Card, CardContent, CardHeader, CardTitle } from '@/components';
import {
  buildCostSamplesFromMessages,
  computeCostRatePerHour,
  COST_POLL_INTERVAL_MS,
  COST_WINDOW_MS,
  getStorageKey,
  MAX_STORED_SAMPLES,
  type CostSample,
} from './arm-cost-usage-helpers';

export type { CostSample };

/**
 * ArmCostUsageChart
 *
 * Money-usage line graph placed below the context graph. Shows a running total
 * of spend over time, plus a dollars-per-hour cost-rate indicator derived from
 * the last 5 minutes of spend, and an optional dashed threshold line when a
 * costBudget prop is supplied.
 *
 * Samples are derived from per-message info.cost on the arm's message log and
 * persisted in localStorage keyed by armId.
 */

interface ArmCostUsageChartProps {
  armId: string | null;
  costBudget?: number;
  title?: string;
  className?: string;
  embedded?: boolean;
}

function loadStoredSamples(armId: string): CostSample[] {
  try {
    const stored = localStorage.getItem(getStorageKey(armId));
    if (!stored) return [];
    const parsed = JSON.parse(stored) as CostSample[];
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - COST_WINDOW_MS;
    return parsed.filter((sample) => sample.timestamp >= cutoff);
  } catch {
    return [];
  }
}

function saveStoredSamples(armId: string, samples: CostSample[]): void {
  try {
    const payload = samples.slice(-MAX_STORED_SAMPLES);
    localStorage.setItem(getStorageKey(armId), JSON.stringify(payload));
  } catch {
    void armId;
  }
}

export function ArmCostUsageChart({
  armId,
  costBudget,
  title = 'Cost Usage',
  className,
  embedded = false,
}: ArmCostUsageChartProps) {
  const [samples, setSamples] = useState<CostSample[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const storedRef = useRef<CostSample[]>([]);

  const recordSnapshot = useCallback(
    (fresh: CostSample[]) => {
      if (!armId) return;
      if (fresh.length === 0) {
        setLoading(false);
        return;
      }
      const stored = storedRef.current;
      const storedMap = new Map<number, CostSample>();
      for (const sample of stored) storedMap.set(sample.timestamp, sample);
      let base = stored.length === 0 ? 0 : stored[stored.length - 1]!.cumulativeCost;
      for (const sample of stored) {
        if (sample.cumulativeCost > base) base = sample.cumulativeCost;
      }
      const next: CostSample[] = [];
      for (const sample of fresh) {
        const existing = storedMap.get(sample.timestamp);
        if (existing) {
          next.push(existing);
        } else {
          next.push({
            ...sample,
            cumulativeCost: base + sample.cumulativeCost,
          });
        }
      }
      for (const sample of stored) {
        if (!next.some((n) => n.timestamp === sample.timestamp)) {
          next.push(sample);
        }
      }
      next.sort((a, b) => a.timestamp - b.timestamp);
      const trimmed = next.slice(-MAX_STORED_SAMPLES);
      storedRef.current = trimmed;
      saveStoredSamples(armId, trimmed);
      setSamples(trimmed);
    },
    [armId],
  );

  useEffect(() => {
    if (!armId) {
      setSamples([]);
      storedRef.current = [];
      return;
    }
    const restored = loadStoredSamples(armId);
    storedRef.current = restored.slice(-MAX_STORED_SAMPLES);
    setSamples(restored);
  }, [armId]);

  useEffect(() => {
    if (!armId) return;
    let cancelled = false;

    const refresh = async () => {
      if (cancelled) return;
      setLoading(true);
      try {
        const response = await api.getArmMessages(armId, 200);
        if (cancelled) return;
        const fresh = buildCostSamplesFromMessages(response.messages);
        recordSnapshot(fresh);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load cost samples');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void refresh();
    const interval = setInterval(refresh, COST_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [armId, recordSnapshot]);

  const referenceTime = Date.now();
  const windowStart = referenceTime - COST_WINDOW_MS;
  const visibleSamples = samples.filter((s) => s.timestamp >= windowStart);
  const maxCumulative = visibleSamples.length === 0
    ? 0
    : Math.max(...visibleSamples.map((s) => s.cumulativeCost));
  const maxBudget = typeof costBudget === 'number' && costBudget > 0 ? costBudget : 0;
  const chartMax = maxBudget > maxCumulative ? maxBudget : maxCumulative * 1.15;
  const costRatePerHour = computeCostRatePerHour(visibleSamples, referenceTime);

  const width = 600;
  const height = 140;
  const padLeft = 52;
  const padRight = 16;
  const padTop = 14;
  const padBottom = 24;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  const xScale = (timestamp: number): number => {
    if (referenceTime <= windowStart) return padLeft;
    const ratio = (timestamp - windowStart) / (referenceTime - windowStart);
    return padLeft + ratio * plotWidth;
  };
  const yScale = (value: number): number => {
    if (chartMax <= 0) return padTop + plotHeight;
    const clamped = Math.max(0, Math.min(value, chartMax));
    return padTop + plotHeight - (clamped / chartMax) * plotHeight;
  };

  const linePoints = visibleSamples
    .map((sample) => `${xScale(sample.timestamp)},${yScale(sample.cumulativeCost)}`)
    .join(' ');

  const areaPath = (() => {
    if (visibleSamples.length === 0) return '';
    const firstX = xScale(visibleSamples[0]!.timestamp);
    const lastX = xScale(visibleSamples[visibleSamples.length - 1]!.timestamp);
    const topPoints = visibleSamples
      .map((sample) => `L${xScale(sample.timestamp).toFixed(2)},${yScale(sample.cumulativeCost).toFixed(2)}`)
      .join(' ');
    const baseY = padTop + plotHeight;
    return `M${firstX.toFixed(2)},${baseY} ${topPoints} L${lastX.toFixed(2)},${baseY} Z`;
  })();

  const budgetY = yScale(maxBudget);
  const gridColor = '#e5e7eb';
  const labelColor = '#6b7280';
  const lineColor = '#22c55e';
  const areaFill = 'rgba(34, 197, 94, 0.12)';
  const budgetLineColor = '#ef4444';

  const formatCurrency = (value: number): string => {
    if (value >= 1) return `$${value.toFixed(2)}`;
    if (value >= 0.01) return `$${value.toFixed(3)}`;
    if (value > 0) return `$${value.toFixed(5)}`;
    return '$0';
  };

  const formatCompactCurrency = (value: number): string => {
    if (value <= 0) return '$0';
    if (value >= 1000) return `$${(value / 1000).toFixed(1)}k`;
    if (value >= 1) return `$${value.toFixed(2)}`;
    if (value >= 0.01) return `$${value.toFixed(3)}`;
    return `$${value.toFixed(5)}`;
  };

  const formatTime = (timestamp: number): string =>
    new Date(timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

  const hoveredSample = hovered === null ? null : visibleSamples[hovered] ?? null;

  const inner = (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: lineColor }} />
          Cumulative cost
        </span>
        {maxBudget > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: budgetLineColor }} />
            Cost budget
          </span>
        )}
        <span className="text-[0.72rem] uppercase tracking-[0.16em] text-muted-foreground">
          ~{formatCompactCurrency(costRatePerHour)}/hr
          <span className="ml-1 normal-case tracking-normal">recent 5 min</span>
        </span>
        <span className="text-[0.7rem]">Samples every ~{Math.round(COST_POLL_INTERVAL_MS / 1000)}s</span>
      </div>

      {loading && visibleSamples.length === 0 ? (
        <div className="flex h-[120px] items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading cost samples...</span>
        </div>
      ) : error ? (
        <div className="flex h-[120px] items-center justify-center rounded-md border border-danger/30 bg-danger/10 text-sm text-danger">
          {error}
        </div>
      ) : visibleSamples.length === 0 ? (
        <div className="flex h-[120px] items-center justify-center rounded-md border border-dashed border-border bg-surface-secondary/35 text-sm text-muted-foreground">
          No cost samples yet. The first one arrives in ~{Math.round(COST_POLL_INTERVAL_MS / 1000)} seconds.
        </div>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="w-full"
            style={{ maxHeight: height }}
            role="img"
            aria-label="Arm cumulative cost over the last 30 minutes"
            onMouseLeave={() => setHovered(null)}
            onMouseMove={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const pointerX = (event.clientX - rect.left) / rect.width * width;
              const offset = pointerX - padLeft;
              if (offset < 0 || offset > plotWidth) {
                setHovered(null);
                return;
              }
              const targetX = (offset / plotWidth) * (referenceTime - windowStart) + windowStart;
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
              {formatCompactCurrency(chartMax)}
            </text>
            <text x={6} y={padTop + plotHeight - 2} fill={labelColor} fontSize={10}>
              $0
            </text>
            {maxBudget > 0 && (
              <>
                <line
                  x1={padLeft}
                  x2={width - padRight}
                  y1={budgetY}
                  y2={budgetY}
                  stroke={budgetLineColor}
                  strokeWidth={2}
                  strokeDasharray="4 3"
                />
                <text
                  x={width - padRight - 4}
                  y={Math.max(padTop + 10, budgetY - 4)}
                  textAnchor="end"
                  fill={budgetLineColor}
                  fontSize={10}
                >
                  Budget {formatCompactCurrency(maxBudget)}
                </text>
              </>
            )}
            {visibleSamples.length === 0 ? null : (
              <>
                <path d={areaPath} fill={areaFill} />
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
            <text x={padLeft} y={height - 6} fill={labelColor} fontSize={10}>
              {new Date(windowStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </text>
            <text x={width - padRight} y={height - 6} textAnchor="end" fill={labelColor} fontSize={10}>
              {visibleSamples.length > 0
                ? formatTime(visibleSamples[visibleSamples.length - 1]!.timestamp)
                : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </text>
          </svg>
          {hoveredSample ? (
            <div
              className="pointer-events-none absolute right-2 top-2 z-10 rounded-md border border-border bg-background/95 px-3 py-2 text-xs shadow"
              style={{ width: 200 }}
            >
              <div className="font-semibold">{formatTime(hoveredSample.timestamp)}</div>
              <div className="mt-1 grid gap-0.5">
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Cumulative</span>
                  <span className="font-medium">{formatCurrency(hoveredSample.cumulativeCost)}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">This message</span>
                  <span className="font-medium">{formatCurrency(hoveredSample.messageCost)}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">In / out tokens</span>
                  <span className="font-medium">
                    {hoveredSample.inputTokens.toLocaleString()} / {hoveredSample.outputTokens.toLocaleString()}
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
            ~{formatCompactCurrency(costRatePerHour)}/hr · cumulative cost
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>{inner}</CardContent>
    </Card>
  );
}
