import { describe, expect, it } from 'bun:test';

import { RefreshGate } from '../src/lib/refresh-gate';

describe('RefreshGate', () => {
  it('prevents overlapping refreshes for the same resource', async () => {
    let release: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = new RefreshGate(() => 100);
    let calls = 0;

    const running = gate.run('dashboard', async () => {
      calls += 1;
      await first;
    });
    const skipped = await gate.run('dashboard', async () => {
      calls += 1;
    });

    expect(skipped).toBe(false);
    expect(calls).toBe(1);
    release?.();
    expect(await running).toBe(true);
  });

  it('coalesces event bursts within the minimum interval', async () => {
    let now = 1_000;
    const gate = new RefreshGate(() => now);
    let calls = 0;
    const refresh = async (): Promise<void> => {
      calls += 1;
    };

    expect(await gate.run('brain', refresh, 5_000)).toBe(true);
    now = 2_000;
    expect(await gate.run('brain', refresh, 5_000)).toBe(false);
    now = 6_000;
    expect(await gate.run('brain', refresh, 5_000)).toBe(true);
    expect(calls).toBe(2);
  });

  it('allows unrelated resources to refresh concurrently', async () => {
    const gate = new RefreshGate(() => 100);
    const calls: string[] = [];

    await Promise.all([
      gate.run('status', async () => { calls.push('status'); }),
      gate.run('events', async () => { calls.push('events'); }),
    ]);

    expect(calls.sort()).toEqual(['events', 'status']);
  });
});
