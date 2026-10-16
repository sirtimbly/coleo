import { spawn } from "node:child_process";
import { appendFile, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getColeoDir } from "../config";
import { getCliEntrypoint } from "../cli/entrypoint";
import { isProcessRunning, requireSelfModify } from "./utils";

export { isProcessRunning, isSelfModifyAllowed, requireSelfModify, formatUptime } from "./utils";
export type ServiceType = "server" | "brain" | "agent" | "web" | "indexer";
export interface ServiceInfo {
  type: ServiceType;
  pid: number;
  startedAt: string;
  command: string[];
  cwd: string;
  identity?: string;
  token?: string;
}
export interface ServiceStatus {
  type: ServiceType;
  running: boolean;
  pid?: number;
  startedAt?: string;
  uptime?: number;
  identity?: string;
}
export interface LifecycleOptions {
  requireSelfModify?: boolean;
  force?: boolean;
  timeout?: number;
  startupTimeout?: number;
  args?: string[];
  env?: NodeJS.ProcessEnv;
}
export function getRunDir(): string { return join(getColeoDir(), "run"); }
export function getPidFilePath(service: ServiceType): string { return join(getRunDir(), `${service}.pid`); }
export function getLogFilePath(service: ServiceType): string { return join(getRunDir(), `${service}.log`); }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Kernel start time and command, rather than PID existence, establish ownership. */
async function processIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid < 1 || !isProcessRunning(pid)) return null;
  const proc = Bun.spawn(["ps", "-p", String(pid), "-o", "lstart=", "-o", "command="], { stdout: "pipe", stderr: "ignore" });
  const text = (await new Response(proc.stdout).text()).trim();
  return await proc.exited === 0 && text ? text : null;
}
async function ownsProcess(info: ServiceInfo): Promise<boolean> {
  return Boolean(info.identity && info.identity === await processIdentity(info.pid));
}
export async function readServiceInfo(service: ServiceType): Promise<ServiceInfo | null> {
  try { return JSON.parse(await readFile(getPidFilePath(service), "utf8")); }
  catch { return null; }
}
/** Separate from lifecycle locks: a background parent awaits child registration. */
async function withRegistrationLock<T>(service: ServiceType, action: () => Promise<T>): Promise<T> {
  await mkdir(getRunDir(), { recursive: true });
  const path = join(getRunDir(), `${service}.registration.lock`);
  const deadline = Date.now() + 5000;
  let handle;
  while (!handle) {
    try { handle = await open(path, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error(`${service} registration locked; if its operator exited, remove ${path}`);
      await sleep(10);
    }
  }
  try { return await action(); } finally { await handle.close(); await unlink(path); }
}
async function removeServiceInfo(service: ServiceType, expected: ServiceInfo): Promise<void> {
  await withRegistrationLock(service, async () => {
    const current = await readServiceInfo(service);
    if (JSON.stringify(current) === JSON.stringify(expected)) await unlink(getPidFilePath(service));
  });
}
export async function unregisterServiceProcess(service: ServiceType): Promise<void> {
  const info = await readServiceInfo(service);
  if (info?.pid === process.pid && await ownsProcess(info)) await removeServiceInfo(service, info);
}
export async function registerServiceProcess(service: ServiceType, pid = process.pid): Promise<void> {
  await withRegistrationLock(service, async () => {
    const existing = await readServiceInfo(service);
    if (existing && await ownsProcess(existing)) {
      if (existing.pid === pid) return;
      throw new Error(`${service} is already registered (PID ${existing.pid})`);
    }
    const identity = await processIdentity(pid);
    if (!identity) throw new Error(`Cannot register stopped ${service} process ${pid}`);
    const info: ServiceInfo = {
      type: service, pid, startedAt: new Date().toISOString(), identity,
      command: pid === process.pid ? [process.execPath, ...process.argv.slice(1)] : getServiceCommand(service).command,
      cwd: process.cwd(),
      token: process.env.COLEO_DAEMON_TOKEN,
    };
    const temporary = `${getPidFilePath(service)}.${crypto.randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(info)); } finally { await handle.close(); }
    await rename(temporary, getPidFilePath(service));
  });
}
export async function getServiceStatus(service: ServiceType): Promise<ServiceStatus> {
  const info = await readServiceInfo(service);
  if (!info || !await ownsProcess(info)) return { type: service, running: false };
  return { type: service, running: true, pid: info.pid, startedAt: info.startedAt,
    identity: info.identity, uptime: Math.floor((Date.now() - Date.parse(info.startedAt)) / 1000) };
}
export function getServiceCommand(service: ServiceType): { command: string[]; cwd: string } {
  const cwd = process.env.COLEO_PROJECT_DIR || process.cwd();
  const role = service === "agent" ? "agent" : "server";
  if (service === "web") return { command: [process.execPath, getCliEntrypoint(), "web", "--port",
    process.env.WEB_UI_PORT || "5173", "--host", process.env.WEB_UI_HOST || "0.0.0.0"], cwd };
  if (service === "indexer") return { command: [process.execPath, "src/scripts/jetstream-transcript-indexer.ts"], cwd };
  return { command: [process.execPath, getCliEntrypoint(role), ...(service === "brain" ? ["brain"] : []), "run"], cwd };
}
export async function readLaunchArgs(service: ServiceType): Promise<string[]> {
  try { return JSON.parse(await readFile(join(getRunDir(), `${service}.launch.json`), "utf8")).args; }
  catch { return []; }
}
export async function saveLaunchArgs(service: ServiceType, args: string[]): Promise<void> {
  await mkdir(getRunDir(), { recursive: true });
  const launchPath = join(getRunDir(), `${service}.launch.json`);
  const temporary = `${launchPath}.${crypto.randomUUID()}.tmp`;
  const saved = await open(temporary, "wx", 0o600);
  try { await saved.writeFile(JSON.stringify({ args })); } finally { await saved.close(); }
  await rename(temporary, launchPath);
}
async function withLock<T>(service: ServiceType, action: () => Promise<T>): Promise<T> {
  await mkdir(getRunDir(), { recursive: true });
  const path = join(getRunDir(), `${service}.lock`);
  let handle;
  try { handle = await open(path, "wx", 0o600); }
  catch { throw new Error(`${service} lifecycle operation locked; if its operator exited, remove ${path}`); }
  try { return await action(); } finally { await handle.close(); await unlink(path); }
}
async function start(service: ServiceType, options: LifecycleOptions): Promise<ServiceStatus> {
  const current = await getServiceStatus(service);
  if (current.running) return current;
  const { command, cwd } = getServiceCommand(service);
  const args = options.args ?? await readLaunchArgs(service);
  await saveLaunchArgs(service, args);
  await appendFile(getLogFilePath(service), `\n=== ${service} ${new Date().toISOString()} ===\n`);
  const log = await open(getLogFilePath(service), "a", 0o600);
  const token = crypto.randomUUID();
  const child = spawn(command[0]!, [...command.slice(1), ...args], {
    cwd, detached: true, stdio: ["ignore", log.fd, log.fd],
    env: { ...process.env, ...options.env, COLEO_DIR: getColeoDir(), COLEO_SELF_MODIFY: undefined, COLEO_DAEMON_TOKEN: token },
  });
  let failed = false;
  child.on("error", () => { failed = true; });
  child.on("exit", () => { failed = true; });
  child.unref();
  await log.close();
  const deadline = Date.now() + (options.startupTimeout ?? 30000);
  // These compatibility-only services predate the readiness handshake.
  // Canonical server, brain and agent services must explicitly register readiness.
  if (service === "web" || service === "indexer") {
    await sleep(500);
    if (!failed && child.pid) {
      await registerServiceProcess(service, child.pid);
      return getServiceStatus(service);
    }
  }
  while (!failed && Date.now() < deadline) {
    const info = await readServiceInfo(service);
    if (info && info.pid === child.pid && info.token === token && await ownsProcess(info)) return getServiceStatus(service);
    await sleep(100);
  }
  // Only the child spawned by this invocation can be terminated on startup failure.
  if (!failed) {
    child.kill("SIGTERM");
    for (let i = 0; i < 10 && !failed; i++) await sleep(100);
    if (!failed) {
      child.kill("SIGKILL");
      for (let i = 0; i < 10 && !failed; i++) await sleep(100);
    }
  }
  throw new Error(`Failed to start ${service}: exited or readiness timed out. See ${getLogFilePath(service)}`);
}
export async function startService(service: ServiceType, options: LifecycleOptions = {}): Promise<ServiceStatus> {
  if (options.requireSelfModify) requireSelfModify(`start ${service}`);
  return withLock(service, () => start(service, options));
}
async function stop(service: ServiceType, options: LifecycleOptions): Promise<ServiceStatus> {
  const info = await readServiceInfo(service);
  if (!info || !await ownsProcess(info)) {
    if (info) await removeServiceInfo(service, info);
    return getServiceStatus(service);
  }
  process.kill(info.pid, "SIGTERM");
  const deadline = Date.now() + (options.timeout ?? 10000);
  while (await ownsProcess(info) && Date.now() < deadline) await sleep(100);
  if (await ownsProcess(info) && options.force) {
    process.kill(info.pid, "SIGKILL");
    for (let i = 0; i < 50 && await ownsProcess(info); i++) await sleep(100);
  }
  if (await ownsProcess(info)) throw new Error(`${service} did not stop; use --force or increase --timeout`);
  await removeServiceInfo(service, info);
  return getServiceStatus(service);
}
export async function stopService(service: ServiceType, options: LifecycleOptions = {}): Promise<ServiceStatus> {
  if (options.requireSelfModify) requireSelfModify(`stop ${service}`);
  return withLock(service, () => stop(service, options));
}
export async function restartService(service: ServiceType, options: LifecycleOptions = {}): Promise<ServiceStatus> {
  if (options.requireSelfModify) requireSelfModify(`restart ${service}`);
  return withLock(service, async () => {
    if ((await stop(service, options)).running) throw new Error(`${service} was replaced by another foreground process during stop`);
    return start(service, options);
  });
}
export async function getAllServiceStatus(): Promise<ServiceStatus[]> {
  return Promise.all((["server", "brain", "agent", "web", "indexer"] as ServiceType[]).map(getServiceStatus));
}
export async function getServiceLogs(service: ServiceType, lines = 50): Promise<string[]> {
  if (!Number.isInteger(lines) || lines < 1) throw new Error("lines must be a positive integer");
  try { return (await readFile(getLogFilePath(service), "utf8")).split("\n").slice(-lines); }
  catch { return []; }
}
