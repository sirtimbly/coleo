import { afterEach, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { acquirePlanEvaluation } from '../evaluation-lock';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'coleo-evaluation-lock-'));
  directories.push(path);
  return path;
}

it('excludes another process and releases ownership', async () => {
  const path = await directory();
  const release = await acquirePlanEvaluation(path);
  expect(release).not.toBeNull();
  try {
    const child = Bun.spawn([process.execPath, '-e', `
      const { acquirePlanEvaluation } = await import(process.argv[1]);
      const release = await acquirePlanEvaluation(process.argv[2]);
      console.log(release ? 'acquired' : 'busy');
      release?.();
    `, resolve('src/project-setup/evaluation-lock.ts'), path], { stdout: 'pipe', stderr: 'pipe' });
    expect(await child.exited).toBe(0);
    expect((await new Response(child.stdout).text()).trim()).toBe('busy');
  } finally { release?.(); }
  const next = await acquirePlanEvaluation(path);
  expect(next).not.toBeNull();
  next?.();
});

it('recovers ownership after the evaluating process exits without cleanup', async () => {
  const path = await directory();
  const child = Bun.spawn([process.execPath, '-e', `
    const { acquirePlanEvaluation } = await import(process.argv[1]);
    await acquirePlanEvaluation(process.argv[2]);
    process.exit(0);
  `, resolve('src/project-setup/evaluation-lock.ts'), path], { stdout: 'pipe', stderr: 'pipe' });
  expect(await child.exited).toBe(0);
  const release = await acquirePlanEvaluation(path);
  expect(release).not.toBeNull();
  release?.();
});

it('grants exactly one owner under concurrent acquisition', async () => {
  const path = await directory();
  const contenders = 8;
  const children = Array.from({ length: contenders }, () =>
    Bun.spawn([process.execPath, '-e', `
      const { acquirePlanEvaluation } = await import(process.argv[1]);
      const release = await acquirePlanEvaluation(process.argv[2]);
      console.log(release ? 'acquired' : 'busy');
      // Hold briefly so overlapping attempts contend rather than serialize.
      await new Promise((resolve) => setTimeout(resolve, 300));
      release?.();
    `, resolve('src/project-setup/evaluation-lock.ts'), path], { stdout: 'pipe', stderr: 'pipe' }));
  const outcomes: string[] = [];
  for (const child of children) {
    expect(await child.exited).toBe(0);
    outcomes.push((await new Response(child.stdout).text()).trim());
  }
  expect(outcomes.filter((outcome) => outcome === 'acquired')).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome === 'busy')).toHaveLength(contenders - 1);
  // The winner released: the lock is acquirable again with no residue.
  const release = await acquirePlanEvaluation(path);
  expect(release).not.toBeNull();
  release?.();
});

it('tolerates double release and leaves no residue behind', async () => {
  const path = await directory();
  const release = await acquirePlanEvaluation(path);
  expect(release).not.toBeNull();
  release?.();
  // Idempotent: second release must not throw or corrupt state.
  release?.();
  const next = await acquirePlanEvaluation(path);
  expect(next).not.toBeNull();
  next?.();
  const final = await acquirePlanEvaluation(path);
  expect(final).not.toBeNull();
  final?.();
});
