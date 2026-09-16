import type { api, Arm, AllArmsAnalysis } from './api';

export type DashboardStatus = Awaited<ReturnType<typeof api.status>>;
export type DashboardBrain = Awaited<ReturnType<typeof api.getBrainStatus>>['brain'];
export type ReportSource = 'status' | 'brain' | 'hosts' | 'arms' | 'analysis' | 'tasks' | 'indexer' | 'queue';
export interface ReportState { updatedAt?: number; error?: string }
export type DashboardReports = Partial<Record<ReportSource, ReportState>>;

export function reportIsStale(report: ReportState | undefined, now: number): boolean {
  return !report?.updatedAt || Boolean(report.error) || now - report.updatedAt > 90_000 || report.updatedAt > now + 30_000;
}

export function brainIsStale(brain: DashboardBrain | null, now: number): boolean {
  const poll = brain?.lastPollAt ? Date.parse(brain.lastPollAt) : NaN;
  const interval = brain?.pollIntervalMs;
  const threshold = Math.max(90_000, typeof interval === 'number' && interval > 0 ? interval * 3 : 90_000);
  return !Number.isFinite(poll) || poll > now + 30_000 || now - poll > threshold;
}

export function formatDashboardAge(timestamp: string | number | null | undefined, now: number): string {
  const time = typeof timestamp === 'number' ? timestamp : timestamp ? Date.parse(timestamp) : NaN;
  if (!Number.isFinite(time)) return 'Not reported';
  if (time > now + 30_000) return 'Invalid future timestamp';
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** Match by identity, never infer coverage by subtracting unrelated totals. */
export function fleetCoverage(arms: Arm[], analysis: AllArmsAnalysis | null): number {
  const observed = new Set(analysis?.arms.map((arm) => arm.armId));
  return arms.filter((arm) => observed.has(arm.id)).length;
}

export function healthReportIsStale(health: { updatedAt: string; staleThresholdMs: number } | null, now: number): boolean {
  const updatedAt = health ? Date.parse(health.updatedAt) : NaN;
  return !Number.isFinite(updatedAt) || updatedAt > now + 30_000
    || now - updatedAt > Math.max(90_000, health?.staleThresholdMs ?? 90_000);
}
