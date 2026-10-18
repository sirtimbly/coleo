import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);
export interface ArmRecoveryOwner {
  coleoDir: string;
  agentId: string;
  workspaceRoot: string;
}
export interface ArmRecoveryRecord extends ArmRecoveryOwner {
  schemaVersion: 1;
  armId: string;
  pid: number;
  port: number;
  identity: string;
}
async function canonical(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}
async function identity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command=']);
    return stdout.trim() || null;
  } catch { return null; }
}
function recordPath(owner: ArmRecoveryOwner, armId: string): string {
  const name = createHash('sha256').update(`${owner.agentId}\0${armId}`).digest('hex');
  return join(owner.coleoDir, 'run', 'arm-recovery', `${name}.json`);
}
/** Called only after this host successfully spawns an API-backed arm. */
export async function recordOwnedArm(owner: ArmRecoveryOwner, armId: string, pid: number, port: number): Promise<void> {
  const processIdentity = await identity(pid);
  if (!processIdentity) throw new Error(`Cannot record stopped arm ${armId}`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid arm recovery port');
  const record: ArmRecoveryRecord = {
    ...owner, coleoDir: await canonical(owner.coleoDir), workspaceRoot: await canonical(owner.workspaceRoot),
    schemaVersion: 1, armId, pid, port, identity: processIdentity,
  };
  const path = recordPath(owner, armId);
  await mkdir(join(owner.coleoDir, 'run', 'arm-recovery'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
  await rename(temporary, path);
}
export async function forgetOwnedArm(owner: ArmRecoveryOwner, armId: string): Promise<void> {
  await unlink(recordPath(owner, armId)).catch(() => {});
}
/** Never enumerate host processes or probe ports without verified launch ownership. */
export async function loadOwnedArms(owner: ArmRecoveryOwner): Promise<ArmRecoveryRecord[]> {
  const directory = join(owner.coleoDir, 'run', 'arm-recovery');
  const entries = await readdir(directory).catch(() => []);
  const coleoDir = await canonical(owner.coleoDir);
  const workspaceRoot = await canonical(owner.workspaceRoot);
  const owned: ArmRecoveryRecord[] = [];
  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    try {
      const record: ArmRecoveryRecord = JSON.parse(await readFile(join(directory, file), 'utf8'));
      if (record.schemaVersion !== 1 || record.agentId !== owner.agentId || record.coleoDir !== coleoDir ||
        record.workspaceRoot !== workspaceRoot || typeof record.armId !== 'string' || !record.armId ||
        !Number.isInteger(record.port) || record.port < 1 || record.port > 65535 ||
        typeof record.identity !== 'string' || !record.identity) continue;
      if (record.identity !== await identity(record.pid)) continue;
      owned.push(record);
    } catch { /* Invalid or stale records cannot establish ownership. */ }
  }
  return owned;
}
