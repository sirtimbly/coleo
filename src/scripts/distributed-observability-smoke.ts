/**
 * Distributed observability smoke test.
 *
 * Verifies that distributed (agent-managed) arms expose:
 * - message logs (/api/arms/:id/messages)
 * - activity history (/api/arms/:id/activity)
 * - live events (/api/arms/:id/events)
 *
 * Optional baseline:
 * - If no agents are connected at start, runs a local process-hosted arm first
 *   (allowLocalFallback=true) and compares endpoint parity expectations.
 */

import { resolveApiKey, resolveApiUrl } from "../network-config";

interface SpawnResponse {
  spawned: boolean;
  distributed?: boolean;
  agentId?: string;
  host?: string;
  pid?: number;
  port?: number;
  sessionId?: string;
}

interface MessagesResponse {
  messages: unknown[];
  sessionId?: string;
  error?: string;
  distributed?: boolean;
}

interface ActivityResponse {
  activity: unknown[];
}

interface StateResponse {
  state: string;
  hasSession: boolean;
}

interface ArmRunResult {
  armId: string;
  distributed: boolean;
  messageCount: number;
  activityCount: number;
  firstEventType: string;
  state: string;
  hasSession: boolean;
}

const API_URL = resolveApiUrl();
const API_KEY = resolveApiKey() || "";
const PROVIDER = process.env.COLEO_TEST_PROVIDER || "opencode";
const MODEL = process.env.COLEO_TEST_MODEL || "gpt-5.1-codex-mini";
const TIMEOUT_MS = Number.parseInt(process.env.COLEO_OBS_TIMEOUT_MS || "90000", 10);
const AGENT_DISCOVERY_WAIT_MS = Number.parseInt(process.env.COLEO_AGENT_DISCOVERY_WAIT_MS || "35000", 10);

const headers: Record<string, string> = {
  "Content-Type": "application/json",
};
if (API_KEY) {
  headers["X-API-Key"] = API_KEY;
}

function log(message: string): void {
  console.log(`[obs-test] ${message}`);
}

async function apiRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...headers,
      ...(init?.headers as Record<string, string> | undefined),
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${init?.method || "GET"} ${path} failed (${response.status}): ${body}`);
  }

  return await response.json() as T;
}

async function waitFor<T>(
  op: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs: number,
  intervalMs = 1500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const value = await op();
      lastValue = value;
      if (predicate(value)) {
        return value;
      }
    } catch (err) {
      lastError = err;
    }
    await Bun.sleep(intervalMs);
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  if (lastValue !== undefined) {
    throw new Error(`Condition not met before timeout. Last value: ${JSON.stringify(lastValue)}`);
  }
  throw new Error("Condition not met before timeout.");
}

async function readFirstEventType(armId: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${API_URL}/api/arms/${armId}/events`, {
      headers,
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`SSE endpoint unavailable (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let delim = buffer.indexOf("\n\n");
      while (delim >= 0) {
        const rawEvent = buffer.slice(0, delim);
        buffer = buffer.slice(delim + 2);
        delim = buffer.indexOf("\n\n");

        const dataLine = rawEvent
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.startsWith("data:"));
        if (!dataLine) continue;

        const payload = JSON.parse(dataLine.slice(5).trim()) as { type?: string };
        const type = payload.type || "unknown";
        if (type !== "server.connected") {
          return type;
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }

  throw new Error(`No arm event received for ${armId} within ${timeoutMs}ms`);
}

async function createAndSpawnArm(
  armId: string,
  options: {
    allowLocalFallback?: boolean;
  },
): Promise<SpawnResponse> {
  await apiRequest<{ arm: { id: string } }>("/api/arms", {
    method: "POST",
    body: JSON.stringify({
      name: armId,
      domain: "development",
      harness: "opencode-api",
      provider: PROVIDER,
      model: MODEL,
    }),
  });

  const prompt = "Reply with exactly: OBSERVABILITY_OK";
  return await apiRequest<SpawnResponse>(`/api/arms/${armId}/spawn`, {
    method: "POST",
    body: JSON.stringify({
      workdir: process.cwd(),
      provider: PROVIDER,
      model: MODEL,
      initialPrompt: prompt,
      allowLocalFallback: options.allowLocalFallback === true,
    }),
  });
}

async function verifyArmObservability(
  armId: string,
  expectedDistributed: boolean,
): Promise<ArmRunResult> {
  const state = await waitFor<StateResponse>(
    () => apiRequest<StateResponse>(`/api/arms/${armId}/state`),
    (value) => value.hasSession && value.state !== "stopped" && value.state !== "dead",
    TIMEOUT_MS,
  );

  const messages = await waitFor<MessagesResponse>(
    () => apiRequest<MessagesResponse>(`/api/arms/${armId}/messages?limit=200`),
    (value) => !value.error && Array.isArray(value.messages) && value.messages.length > 0,
    TIMEOUT_MS,
  );

  const activity = await waitFor<ActivityResponse>(
    () => apiRequest<ActivityResponse>(`/api/arms/${armId}/activity?limit=50`),
    (value) => Array.isArray(value.activity) && value.activity.length > 0,
    TIMEOUT_MS,
  );

  const firstEventType = await readFirstEventType(armId, 20000);

  return {
    armId,
    distributed: expectedDistributed,
    messageCount: messages.messages.length,
    activityCount: activity.activity.length,
    firstEventType,
    state: state.state,
    hasSession: state.hasSession,
  };
}

async function safeCleanupArm(armId: string): Promise<void> {
  try {
    await apiRequest(`/api/arms/${armId}/kill`, { method: "POST" });
  } catch {
    // ignore cleanup errors
  }
  try {
    await apiRequest(`/api/arms/${armId}`, { method: "DELETE" });
  } catch {
    // ignore cleanup errors
  }
}

async function main(): Promise<void> {
  const suffix = Date.now().toString(36);
  const localArmId = `obs-local-${suffix}`;
  const distributedArmId = `obs-dist-${suffix}`;
  const createdArms: string[] = [];

  log(`API URL: ${API_URL}`);
  log(`Model: ${PROVIDER}/${MODEL}`);

  try {
    const health = await apiRequest<{ status: string }>("/api/health");
    if (health.status !== "ok") {
      throw new Error(`API health status is not ok: ${health.status}`);
    }

    const agents = await apiRequest<{ agents: Array<{ agentId: string }> }>("/api/agents");
    let agentCount = agents.agents.length;
    log(`Connected agents at start: ${agentCount}`);

    if (agentCount === 0) {
      log(`Waiting up to ${AGENT_DISCOVERY_WAIT_MS}ms for agent discovery...`);
      try {
        const discovered = await waitFor<{ agents: Array<{ agentId: string }> }>(
          () => apiRequest<{ agents: Array<{ agentId: string }> }>("/api/agents"),
          (value) => value.agents.length > 0,
          AGENT_DISCOVERY_WAIT_MS,
          2000,
        );
        agentCount = discovered.agents.length;
        log(`Agents discovered after wait: ${agentCount}`);
      } catch {
        log("No agents discovered during grace period.");
      }
    }

    let localResult: ArmRunResult | null = null;
    if (agentCount === 0) {
      log("Running local (process-hosted) baseline arm...");
      createdArms.push(localArmId);
      const localSpawn = await createAndSpawnArm(localArmId, { allowLocalFallback: true });
      if (localSpawn.distributed) {
        log("Local baseline arm was routed to distributed agent; skipping baseline comparison.");
      } else {
        localResult = await verifyArmObservability(localArmId, false);
        log(`Local baseline passed: messages=${localResult.messageCount}, activity=${localResult.activityCount}, firstEvent=${localResult.firstEventType}`);
      }
    } else {
      log("Skipping local baseline because agents are already connected.");
    }

    log("Running distributed arm test...");
    createdArms.push(distributedArmId);
    const distributedSpawn = await createAndSpawnArm(distributedArmId, {});
    if (!distributedSpawn.distributed) {
      throw new Error("Expected distributed spawn, but arm spawned locally.");
    }

    const distributedResult = await verifyArmObservability(distributedArmId, true);
    log(`Distributed test passed: messages=${distributedResult.messageCount}, activity=${distributedResult.activityCount}, firstEvent=${distributedResult.firstEventType}`);

    if (localResult) {
      if (distributedResult.messageCount === 0 || distributedResult.activityCount === 0) {
        throw new Error("Distributed arm did not match baseline observability minimums.");
      }
      log("Comparison: distributed observability meets baseline minimums.");
    } else {
      log("Distributed observability checks passed without local baseline.");
    }

    log("PASS");
  } finally {
    for (const armId of createdArms) {
      await safeCleanupArm(armId);
    }
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[obs-test] FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
