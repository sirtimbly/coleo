import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';

const source = await Bun.file(new URL('../src/lib/session-heartbeat.ts', import.meta.url)).text();
const script = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.replaceAll('export function', 'function'));

test('heartbeat is activity-aware, bounded, recovers after sign-in, and cleans up', async () => {
  let now = 0;
  let checks = 0;
  let status = 200;
  let supported = true;
  let timer: (() => void) | undefined;
  const listeners = new Map<string, () => void>();
  const sessions: boolean[] = [];
  const doc = { visibilityState: 'visible', addEventListener: (event: string, fn: () => void) => listeners.set(event, fn), removeEventListener: (event: string) => listeners.delete(event) };
  const context = {
    Date: { now: () => now }, AbortSignal, AbortController,
    document: doc,
    window: { addEventListener: doc.addEventListener, removeEventListener: doc.removeEventListener },
    setInterval: (fn: () => void) => { timer = fn; return 1; },
    clearInterval: () => { timer = undefined; },
    fetch: async () => { checks++; return new Response(null, { status, headers: supported ? { 'x-reef-session': '1' } : {} }); },
    sessions,
  };
  const stop = runInNewContext(`${script}\nstartSessionHeartbeat(value => sessions.push(value));`, context) as () => void;
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  await flush();
  expect(checks).toBe(1);
  now = 30_000; listeners.get('keydown')!(); await flush();
  expect(checks).toBe(1);
  now = 60_000; timer!(); await flush();
  expect(checks).toBe(2);
  doc.visibilityState = 'hidden'; now = 90_000; timer!(); await flush();
  expect(checks).toBe(2);
  doc.visibilityState = 'visible'; now = 960_000; timer!(); await flush();
  expect(checks).toBe(2); // Idle despite being visible.
  status = 401; listeners.get('pointerdown')!(); await flush();
  expect(sessions.at(-1)).toBe(false);
  now = 1_020_000; status = 200; listeners.get('visibilitychange')!(); await flush();
  expect(sessions.at(-1)).toBe(true);
  now = 1_080_000; supported = false; timer!(); await flush();
  expect(timer).toBeUndefined();
  expect(listeners.size).toBe(0);
  stop();
});
