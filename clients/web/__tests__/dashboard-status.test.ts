import { describe, expect, it } from 'bun:test';
import { brainIsStale, fleetCoverage, formatDashboardAge, healthReportIsStale, reportIsStale } from '../src/lib/dashboard-status';
import type { DashboardBrain } from '../src/lib/dashboard-status';
import type { AllArmsAnalysis, Arm } from '../src/lib/api';
const now = Date.parse('2026-09-15T12:00:00Z');
const brain = (lastPollAt: string | null, pollIntervalMs = 30000) => ({ lastPollAt, pollIntervalMs }) as DashboardBrain;

describe('dashboard observation semantics', () => {
  it('does not treat an old, missing, invalid, or future poll as running health', () => {
    for (const date of [null, 'invalid', '2026-08-01', '2027-01-01']) expect(brainIsStale(brain(date), now)).toBe(true);
    expect(brainIsStale(brain('2026-09-15T11:59:30Z'), now)).toBe(false);
    expect(brainIsStale(brain('2026-09-15T11:56:00Z', 120000), now)).toBe(false);
  });
  it('marks retained responses stale after failures or missed refreshes', () => {
    expect(reportIsStale({ updatedAt: now - 1000 }, now)).toBe(false);
    expect(reportIsStale({ updatedAt: now - 1000, error: 'offline' }, now)).toBe(true);
    expect(reportIsStale({ updatedAt: now - 100000 }, now)).toBe(true);
    expect(reportIsStale(undefined, now)).toBe(true);
    expect(healthReportIsStale({ updatedAt: '2026-01-01', staleThresholdMs: 120000 }, now)).toBe(true);
  });
  it('matches activity reports to Arm identities and ignores duplicates or foreign IDs', () => {
    const arms = [{ id: 'a' }, { id: 'b' }] as Arm[];
    const analysis = { arms: [{ armId: 'a' }, { armId: 'a' }, { armId: 'other' }] } as AllArmsAnalysis;
    expect(fleetCoverage(arms, analysis)).toBe(1);
  });
  it('uses readable ages without invalid or negative durations', () => {
    expect(formatDashboardAge('2026-08-22T12:00:00Z', now)).toBe('24d ago');
    expect(formatDashboardAge('invalid', now)).toBe('Not reported');
    expect(formatDashboardAge(now + 90000, now)).toBe('Invalid future timestamp');
  });
});
