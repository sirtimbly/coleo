import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { forgetOwnedArm, loadOwnedArms, recordOwnedArm } from '../arm-recovery';
import { ArmAgent } from '../arm-agent';
import { OpenCodeApiHarness } from '../../harness/opencode-api';
import { NatsClient } from '../../nats';
import * as preflight from '../../harness/model-preflight';
import type { HarnessSession } from '../../harness/types';
import type { ArmRecoveryOwner } from '../arm-recovery';
import type { AgentCommand, CommandResponse } from '../../nats/types';

let directory: string;
let child: ReturnType<typeof Bun.spawn>;
let owner: ArmRecoveryOwner;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'coleo arm ownership '));
  owner = { coleoDir: directory, workspaceRoot: directory, agentId: 'stable-host' };
  child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'ignore', stderr: 'ignore' });
});
afterEach(async () => {
  child.kill('SIGKILL'); await child.exited;
  await rm(directory, { recursive: true, force: true });
});
test('restart records require matching agent, runtime, workspace and live process identity', async () => {
  expect(await loadOwnedArms(owner)).toEqual([]);
  await recordOwnedArm(owner, 'owned-arm', child.pid, 12345);
  expect((await loadOwnedArms({ ...owner })).map(record => record.armId)).toEqual(['owned-arm']);
  expect(await loadOwnedArms({ ...owner, agentId: 'another-host' })).toEqual([]);
  expect(await loadOwnedArms({ ...owner, workspaceRoot: join(directory, 'other-workspace') })).toEqual([]);
  const otherRuntime = join(directory, 'copied-runtime');
  await cp(join(directory, 'run'), join(otherRuntime, 'run'), { recursive: true });
  expect(await loadOwnedArms({ ...owner, coleoDir: otherRuntime })).toEqual([]);
  const file = (await readdir(join(directory, 'run/arm-recovery'))).find(file => file.endsWith('.json'))!;
  const path = join(directory, 'run/arm-recovery', file);
  const record = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...record, identity: 'stale identity for reused PID' }));
  expect(await loadOwnedArms(owner)).toEqual([]);
  await recordOwnedArm(owner, 'owned-arm', child.pid, 12345);
  child.kill('SIGTERM'); await child.exited;
  expect(await loadOwnedArms(owner)).toEqual([]);
});
test('spawn records ownership and same-host restart recovers only that live arm', async () => {
  const session = { id: 'owned-arm', port: 12345, sessionId: 'fixture-session' } as unknown as HarnessSession;
  const spawn = spyOn(OpenCodeApiHarness.prototype, 'spawn').mockResolvedValue(session);
  const pid = spyOn(OpenCodeApiHarness.prototype, 'getPid').mockReturnValue(child.pid);
  const recover = spyOn(OpenCodeApiHarness.prototype, 'recover').mockResolvedValue(session);
  const publish = spyOn(NatsClient.prototype, 'publishArmEvent').mockResolvedValue(undefined);
  const check = spyOn(preflight, 'verifySpawnModel').mockResolvedValue(undefined);
  const options = { ...owner, natsUrl: 'nats://unused.invalid:4222' };
  try {
    const original = new ArmAgent(options) as unknown as { handleCommand(command: AgentCommand): Promise<CommandResponse> };
    const result = await original.handleCommand({ type: 'spawn', requestId: 'fixture', armId: 'owned-arm',
      name: 'Owned', domain: 'test', harness: 'opencode-api' });
    expect(result.success).toBe(true);
    expect((await loadOwnedArms(owner))[0]?.pid).toBe(child.pid);
    const unrelated = new ArmAgent({ ...options, agentId: 'unrelated-host' }) as unknown as { recoverExistingArms(): Promise<void> };
    await unrelated.recoverExistingArms();
    expect(recover).not.toHaveBeenCalled();
    const restarted = new ArmAgent(options) as unknown as { recoverExistingArms(): Promise<void>; managedArms: Map<string, unknown> };
    await restarted.recoverExistingArms();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledWith('owned-arm', 12345, child.pid);
    expect(restarted.managedArms.has('owned-arm')).toBe(true);
    await forgetOwnedArm(owner, 'owned-arm');
    expect(await loadOwnedArms(owner)).toEqual([]);
  } finally {
    spawn.mockRestore(); pid.mockRestore(); recover.mockRestore(); publish.mockRestore(); check.mockRestore();
  }
});
