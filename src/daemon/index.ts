/**
 * Daemon/Service Management for Octopai
 * 
 * Provides PID file tracking and process management for:
 * - API Server (coleo serve)
 * - Brain (coleo brain run)
 * 
 * PID files stored in ~/.coleo/run/
 * 
 * Security: Some operations require COLEO_SELF_MODIFY=1 env var,
 * which should only be set for arms working on Coleo itself.
 */

import { spawn } from "bun";
import { mkdir, readFile, writeFile, unlink } from "fs/promises";
import { join } from "path";
import { getColeoDir } from "../config";

export type ServiceType = "server" | "brain";

export interface ServiceInfo {
  type: ServiceType;
  pid: number;
  startedAt: string;
  command: string[];
  cwd: string;
}

export interface ServiceStatus {
  type: ServiceType;
  running: boolean;
  pid?: number;
  startedAt?: string;
  uptime?: number; // seconds
}

/**
 * Get the run directory for PID files
 */
export function getRunDir(): string {
  return join(getColeoDir(), "run");
}

/**
 * Get the PID file path for a service
 */
export function getPidFilePath(service: ServiceType): string {
  return join(getRunDir(), `${service}.pid`);
}

/**
 * Get the log file path for a service
 */
export function getLogFilePath(service: ServiceType): string {
  return join(getRunDir(), `${service}.log`);
}

/**
 * Ensure the run directory exists
 */
async function ensureRunDir(): Promise<void> {
  await mkdir(getRunDir(), { recursive: true });
}

/**
 * Check if a process is running by PID
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read service info from PID file
 */
export async function readServiceInfo(service: ServiceType): Promise<ServiceInfo | null> {
  const pidFile = getPidFilePath(service);
  try {
    const content = await readFile(pidFile, "utf-8");
    return JSON.parse(content) as ServiceInfo;
  } catch {
    return null;
  }
}

/**
 * Write service info to PID file
 */
async function writeServiceInfo(info: ServiceInfo): Promise<void> {
  await ensureRunDir();
  const pidFile = getPidFilePath(info.type);
  await writeFile(pidFile, JSON.stringify(info, null, 2));
}

/**
 * Remove PID file for a service
 */
async function removeServiceInfo(service: ServiceType): Promise<void> {
  const pidFile = getPidFilePath(service);
  try {
    await unlink(pidFile);
  } catch {
    // Ignore if file doesn't exist
  }
}

/**
 * Get the status of a service
 */
export async function getServiceStatus(service: ServiceType): Promise<ServiceStatus> {
  const info = await readServiceInfo(service);
  
  if (!info) {
    return { type: service, running: false };
  }
  
  const running = isProcessRunning(info.pid);
  
  if (!running) {
    // Clean up stale PID file
    await removeServiceInfo(service);
    return { type: service, running: false };
  }
  
  const startedAt = new Date(info.startedAt);
  const uptime = Math.floor((Date.now() - startedAt.getTime()) / 1000);
  
  return {
    type: service,
    running: true,
    pid: info.pid,
    startedAt: info.startedAt,
    uptime,
  };
}

/**
 * Check if self-modification is allowed
 * Only arms with COLEO_SELF_MODIFY=1 can restart services
 */
export function isSelfModifyAllowed(): boolean {
  return process.env.COLEO_SELF_MODIFY === "1";
}

/**
 * Guard function that throws if self-modification is not allowed
 */
export function requireSelfModify(action: string): void {
  if (!isSelfModifyAllowed()) {
    throw new Error(
      `Action "${action}" requires COLEO_SELF_MODIFY=1 environment variable. ` +
      `This is only allowed for arms working on Coleo itself.`
    );
  }
}

/**
 * Get the command to start a service
 */
function getServiceCommand(service: ServiceType): { command: string[]; cwd: string } {
  // Use the coleo directory as cwd
  const cwd = process.env.COLEO_PROJECT_DIR || process.cwd();
  
  switch (service) {
    case "server":
      return {
        command: ["bun", "run", "src/api/server.ts"],
        cwd,
      };
    case "brain":
      return {
        command: ["bun", "run", "src/cli/index.ts", "brain", "run", "--verbose"],
        cwd,
      };
  }
}

/**
 * Start a service in the background
 */
export async function startService(
  service: ServiceType,
  options?: { requireSelfModify?: boolean }
): Promise<ServiceStatus> {
  // Check self-modify permission if required
  if (options?.requireSelfModify) {
    requireSelfModify(`start ${service}`);
  }
  
  // Check if already running
  const currentStatus = await getServiceStatus(service);
  if (currentStatus.running) {
    return currentStatus;
  }
  
  await ensureRunDir();
  
  const { command, cwd } = getServiceCommand(service);
  const logFile = getLogFilePath(service);
  
  // Write startup marker to log
  const startMarker = `\n\n========== ${service.toUpperCase()} STARTED AT ${new Date().toISOString()} ==========\n\n`;
  await Bun.write(logFile, startMarker, { createPath: true });
  
  // Use nohup + shell redirect to fully detach the process
  // This ensures the parent can exit without waiting
  const shellCmd = `nohup ${command.join(" ")} >> "${logFile}" 2>&1 &`;
  
  const proc = spawn({
    cmd: ["sh", "-c", shellCmd],
    cwd,
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...process.env,
      // Ensure the spawned process doesn't inherit COLEO_SELF_MODIFY
      COLEO_SELF_MODIFY: undefined,
    },
  });
  
  // Wait for shell to exit (happens immediately after backgrounding)
  await proc.exited;
  
  // Wait a moment for the actual process to start
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Find the PID of the started process
  // We need to find it by looking for the command pattern
  const pidResult = await findProcessByCommand(command, cwd);
  
  if (!pidResult) {
    throw new Error(`Failed to start ${service}: could not find process. Check ${logFile} for details.`);
  }
  
  // Verify it's running
  if (!isProcessRunning(pidResult)) {
    throw new Error(`Failed to start ${service}: process exited immediately. Check ${logFile} for details.`);
  }
  
  // Write PID file
  const info: ServiceInfo = {
    type: service,
    pid: pidResult,
    startedAt: new Date().toISOString(),
    command,
    cwd,
  };
  await writeServiceInfo(info);
  
  console.log(`Started ${service} (PID: ${pidResult}), logs at ${logFile}`);
  
  return {
    type: service,
    running: true,
    pid: pidResult,
    startedAt: info.startedAt,
    uptime: 0,
  };
}

/**
 * Find a process by its command pattern
 */
async function findProcessByCommand(command: string[], cwd: string): Promise<number | null> {
  // Look for bun processes matching our command
  const { execSync } = await import("node:child_process");
  
  try {
    // Find bun processes running our script
    const pattern = command.slice(1).join(".*");
    const psOutput = execSync(
      `ps aux | grep -E 'bun.*${pattern}' | grep -v grep | awk '{print $2}' | head -1`,
      { encoding: "utf-8", cwd }
    ).trim();
    
    if (psOutput) {
      const pid = parseInt(psOutput, 10);
      if (!isNaN(pid)) {
        return pid;
      }
    }
  } catch {
    // Ignore errors
  }
  
  return null;
}

/**
 * Stop a running service
 */
export async function stopService(
  service: ServiceType,
  options?: { requireSelfModify?: boolean; force?: boolean; timeout?: number }
): Promise<ServiceStatus> {
  // Check self-modify permission if required
  if (options?.requireSelfModify) {
    requireSelfModify(`stop ${service}`);
  }
  
  const info = await readServiceInfo(service);
  
  if (!info) {
    return { type: service, running: false };
  }
  
  if (!isProcessRunning(info.pid)) {
    await removeServiceInfo(service);
    return { type: service, running: false };
  }
  
  const timeout = options?.timeout ?? 5000;
  const force = options?.force ?? false;
  
  // Try graceful shutdown first
  try {
    process.kill(info.pid, "SIGTERM");
    console.log(`Sent SIGTERM to ${service} (PID: ${info.pid})`);
  } catch (err) {
    console.error(`Failed to send SIGTERM to ${service}: ${err}`);
  }
  
  // Wait for process to exit
  const startWait = Date.now();
  while (isProcessRunning(info.pid) && Date.now() - startWait < timeout) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  // If still running and force is enabled, send SIGKILL
  if (isProcessRunning(info.pid)) {
    if (force) {
      try {
        process.kill(info.pid, "SIGKILL");
        console.log(`Sent SIGKILL to ${service} (PID: ${info.pid})`);
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (err) {
        console.error(`Failed to send SIGKILL to ${service}: ${err}`);
      }
    } else {
      console.warn(`${service} (PID: ${info.pid}) did not stop gracefully within ${timeout}ms. Use --force to kill.`);
      return { type: service, running: true, pid: info.pid };
    }
  }
  
  // Clean up PID file
  await removeServiceInfo(service);
  console.log(`Stopped ${service}`);
  
  return { type: service, running: false };
}

/**
 * Restart a service (stop + start)
 */
export async function restartService(
  service: ServiceType,
  options?: { requireSelfModify?: boolean; force?: boolean; timeout?: number }
): Promise<ServiceStatus> {
  // Check self-modify permission if required
  if (options?.requireSelfModify) {
    requireSelfModify(`restart ${service}`);
  }
  
  // Stop first
  await stopService(service, { force: options?.force, timeout: options?.timeout });
  
  // Wait a moment for ports to be released
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Start
  return startService(service);
}

/**
 * Get status of all services
 */
export async function getAllServiceStatus(): Promise<ServiceStatus[]> {
  const services: ServiceType[] = ["server", "brain"];
  return Promise.all(services.map(getServiceStatus));
}

/**
 * Get the last N lines from a service log
 */
export async function getServiceLogs(
  service: ServiceType,
  lines: number = 50
): Promise<string[]> {
  const logFile = getLogFilePath(service);
  
  try {
    const content = await readFile(logFile, "utf-8");
    const allLines = content.split("\n");
    return allLines.slice(-lines);
  } catch {
    return [];
  }
}

/**
 * Format uptime in human-readable format
 */
export function formatUptime(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  }
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}
