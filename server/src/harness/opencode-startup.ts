import type { Subprocess } from "bun";
import { openCodeHeaders } from "./opencode-v2-client";

/** Abort the request as well as bounding the wait, including response-body reads. */
export async function withStartupTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  const error = new Error(`${label} timed out after ${timeoutMs}ms`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForOpenCodeServer(
  serverUrl: string,
  timeoutMs: number,
  serverProcess?: Pick<Subprocess, "exitCode">,
  apiVersion: 1 | 2 = 1,
  headers: Record<string, string> = openCodeHeaders(),
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "server did not report healthy";
  while (Date.now() < deadline) {
    if (serverProcess && serverProcess.exitCode !== null) {
      throw new Error(`OpenCode server process died with exit code ${serverProcess.exitCode}`);
    }
    try {
      const healthy = await withStartupTimeout(async (signal) => {
        const response = await fetch(`${serverUrl}${apiVersion === 2 ? "/api/info" : "/global/health"}`, { signal, headers });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`Health check returned HTTP ${response.status}`);
        }
        const data = await response.json() as { healthy?: boolean; version?: string };
        if (apiVersion === 2 ? typeof data.version === "string" : data.healthy) {
          console.log(`[harness-api] Server ready (version ${data.version})`);
          return true;
        }
        return false;
      }, Math.min(1000, deadline - Date.now()), "OpenCode health check");
      if (healthy) return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await Bun.sleep(Math.min(200, remaining));
  }
  throw new Error(`OpenCode server failed to start within ${timeoutMs}ms (last error: ${lastError})`);
}

/** Reap failed launches before a retry can create another server for the arm. */
export async function stopFailedOpenCodeProcess(process: Subprocess, graceMs = 1000): Promise<void> {
  if (process.exitCode !== null) return;
  process.kill("SIGTERM");
  try {
    await withStartupTimeout(() => process.exited, graceMs, "OpenCode shutdown");
  } catch {
    process.kill("SIGKILL");
    await withStartupTimeout(() => process.exited, graceMs, "OpenCode forced shutdown");
  }
}
