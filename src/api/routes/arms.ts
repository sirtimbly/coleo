/**
 * Arms routes
 * 
 * CRUD operations for arm profiles + harness control
 */
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { HttpError } from "../middleware";
import { getGlobalHarnessManager } from "../../harness";
import { broadcast } from "../websocket";
import { loadConfig, getColeoDir, getRandomPreferredModel } from "../../config";
import { join } from "path";
import { execSync } from "node:child_process";
import { readFile, mkdir, writeFile, unlink, readdir } from "fs/promises";
import { parse as parseToml } from "smol-toml";
import { getArmClient } from "../arm-client-registry";
import { generateSystemPrompt } from "../../arm/prompts";
import { eventStore } from "../../nats/jetstream";
import { releaseClaimsForArm } from "../claim-cleanup";
import { refreshOpenCodeProvidersCache } from "./opencode";
import { getCliEntrypoint } from "../../cli/entrypoint";
import { hostname } from "os";
import { appendTaskAttachmentsToPromptText } from "../../lib/prompt-attachments";
import { supportsInputModality } from "../../harness/model-resolver";
import { searchStatusHistory } from "../../vector/indexing-pipeline";
import type { TaskAttachment } from "../../types";

interface ArmsContext {
  Variables: {
    db: Database;
  };
}

const AUTO_AGENT_ID = `agent-${hostname()}-autostart`;
const AUTO_AGENT_WAIT_MS_DEFAULT = 8000;
const DISTRIBUTED_OBSERVABILITY_COMMAND_TIMEOUT_MS = 8000;
let autoStartAgentPromise: Promise<void> | null = null;

interface ArmClientLookup {
  findBestAgent: (harness: string) => unknown;
  listArmsOnAgent?: (agentId: string, timeoutMs?: number) => Promise<{ success: boolean }>;
}

interface DistributedRuntimeSnapshot {
  status: string;
  pid: number | null;
  port: number | null;
  sessionId: string | null;
  lastActivityAt: string | null;
}

interface DistributedRuntimeRefreshResult {
  snapshot: DistributedRuntimeSnapshot;
  confirmed: boolean;
}

type ArmRuntimeState =
  | "starting"
  | "active"
  | "quiet"
  | "hung"
  | "recoverable"
  | "stopped"
  | "unknown";

interface ArmRuntimeSignals {
  dbStatus: string;
  hasPid: boolean;
  hasPort: boolean;
  hasSessionId: boolean;
  hasAgentId: boolean;
  hasWorkdir: boolean;
  hasAssignedTask: boolean;
  distributed: boolean;
}

export interface ArmRuntimeSummary {
  state: ArmRuntimeState;
  reason: string;
  distributed: boolean;
  hasRuntime: boolean;
  hasSession: boolean;
  canRecover: boolean;
  canRestart: boolean;
  lastActivityAt: string | null;
  lastHeartbeatAt: string | null;
  lastOutputAt: string | null;
  secondsSinceActivity: number | null;
  secondsSinceHeartbeat: number | null;
  secondsSinceOutput: number | null;
  signals: ArmRuntimeSignals;
}

const ACTIVE_OUTPUT_THRESHOLD_MS = 90_000;
const QUIET_OUTPUT_THRESHOLD_MS = 180_000;
const HUNG_OUTPUT_THRESHOLD_MS = 300_000;
const STALE_HEARTBEAT_THRESHOLD_MS = 120_000;

function ageInSeconds(timestamp: string | null | undefined): number | null {
  if (!timestamp) return null;
  const ms = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(ms) || ms < 0) {
    return null;
  }
  return Math.floor(ms / 1000);
}

function isAgeWithin(seconds: number | null, thresholdMs: number): boolean {
  if (seconds === null) {
    return false;
  }
  return seconds * 1000 <= thresholdMs;
}

function hasDistributedRuntimeMetadata(snapshot: DistributedRuntimeSnapshot): boolean {
  return snapshot.pid !== null || snapshot.port !== null || snapshot.sessionId !== null;
}

function isDistributedRuntimeReattachable(result: DistributedRuntimeRefreshResult): boolean {
  if (!result.confirmed || !hasDistributedRuntimeMetadata(result.snapshot)) {
    return false;
  }

  return !["stopped", "error", "stale"].includes(result.snapshot.status);
}

function resolveDistributedAgentId(
  armId: string,
  persistedAgentId: string | null,
  options?: { harness?: string | null; host?: string | null },
): string | null {
  const armClient = getArmClient();
  if (!armClient) {
    return persistedAgentId;
  }

  const mapped = armClient.getAgentForArm(armId);
  if (mapped && armClient.getAgent(mapped)) {
    return mapped;
  }

  if (persistedAgentId && armClient.getAgent(persistedAgentId)) {
    return persistedAgentId;
  }

  const daemonManagedHarness =
    options?.harness === "opencode-api" || options?.harness === "opencode";

  if (options?.host) {
    const matchingAgent = armClient
      .getAgents()
      .find((agent) =>
        agent.hostname === options.host &&
        (!options.harness || agent.capabilities.includes(options.harness)),
      );
    if (matchingAgent) {
      return matchingAgent.agentId;
    }
  }

  if (!daemonManagedHarness) {
    return mapped || persistedAgentId || null;
  }

  // Local daemon fallback for bootstrap/restart windows before heartbeats populate mappings.
  if (armClient.getAgent(AUTO_AGENT_ID)) {
    return AUTO_AGENT_ID;
  }

  return mapped || persistedAgentId || null;
}

function mapDistributedStatusToHarnessState(status: string): string {
  switch (status) {
    case "busy":
    case "running":
      return "processing";
    case "starting":
      return "initializing";
    case "error":
      return "error";
    case "stopped":
      return "stopped";
    case "idle":
      return "idle";
    default:
      return "unknown";
  }
}

function findReachableAgentForHarness(
  harness: string,
  options?: { preferredAgentId?: string | null; preferredHost?: string | null },
): string | null {
  const armClient = getArmClient();
  if (!armClient) {
    return options?.preferredAgentId || null;
  }

  if (options?.preferredAgentId && armClient.getAgent(options.preferredAgentId)) {
    return options.preferredAgentId;
  }

  if (options?.preferredHost) {
    const hostMatch = armClient
      .getAgents()
      .find((agent) => agent.hostname === options.preferredHost && agent.capabilities.includes(harness));
    if (hostMatch) {
      return hostMatch.agentId;
    }
  }

  return armClient.findBestAgent(harness)?.agentId || null;
}

async function refreshDistributedRuntimeFromAgent(
  db: Database,
  armId: string,
  agentId: string | null,
  current: DistributedRuntimeSnapshot,
): Promise<DistributedRuntimeRefreshResult> {
  const armClient = getArmClient();
  if (!armClient) {
    return { snapshot: current, confirmed: false };
  }

  let remoteState:
    | {
        status?: string | null;
        pid?: number | null;
        port?: number | null;
        sessionId?: string | null;
        lastActivityAt?: string | null;
      }
    | undefined;

  try {
    const response = await armClient.getArmState(armId);
    if (response.success && response.data) {
      remoteState = response.data;
    } else if (agentId) {
      const listResponse = await armClient.listArmsOnAgent(agentId);
      if (listResponse.success && listResponse.data?.arms) {
        remoteState = listResponse.data.arms.find((arm) => arm.armId === armId);
      }
    }
  } catch {
    return { snapshot: current, confirmed: false };
  }

  if (!remoteState) {
    return { snapshot: current, confirmed: false };
  }

  const next: DistributedRuntimeSnapshot = {
    status: remoteState.status || current.status,
    pid:
      typeof remoteState.pid === "number" || remoteState.pid === null
        ? remoteState.pid
        : current.pid,
    port:
      typeof remoteState.port === "number" || remoteState.port === null
        ? remoteState.port
        : current.port,
    sessionId:
      typeof remoteState.sessionId === "string" || remoteState.sessionId === null
        ? remoteState.sessionId
        : current.sessionId,
    lastActivityAt:
      typeof remoteState.lastActivityAt === "string" || remoteState.lastActivityAt === null
        ? remoteState.lastActivityAt
        : current.lastActivityAt,
  };

  const now = new Date().toISOString();
  const resolvedHost = agentId ? armClient.getAgent(agentId)?.hostname ?? null : null;
  db.run(
    "UPDATE arms SET status = ?, pid = ?, port = ?, session_id = ?, last_activity_at = COALESCE(?, last_activity_at), agent_id = COALESCE(?, agent_id), host = COALESCE(?, host), last_heartbeat = ?, updated_at = ? WHERE id = ?",
    [next.status, next.pid, next.port, next.sessionId, next.lastActivityAt, agentId, resolvedHost, now, now, armId],
  );

  return { snapshot: next, confirmed: true };
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function shellQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function readAutostartPidFilePath(): string {
  const coleoDir = getColeoDir();
  return join(coleoDir, "run", "agent-autostart.pid");
}

function processLooksLikeAutostartAgent(pid: number): boolean {
  try {
    const command = execSync(`ps -p ${pid} -o command=`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!command) return false;
    return (
      command.includes(getCliEntrypoint()) &&
      command.includes("agent") &&
      command.includes("start") &&
      command.includes(AUTO_AGENT_ID)
    );
  } catch {
    return false;
  }
}

async function restartLocalAutostartAgentIfStale(): Promise<boolean> {
  const pidFile = readAutostartPidFilePath();
  let existingPid: number | null = null;

  try {
    const parsed = JSON.parse(await readFile(pidFile, "utf-8")) as { pid?: number };
    if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      existingPid = parsed.pid;
    }
  } catch {
    return false;
  }

  if (!existingPid || !isProcessAlive(existingPid)) {
    await unlink(pidFile).catch(() => undefined);
    return false;
  }

  if (!processLooksLikeAutostartAgent(existingPid)) {
    console.warn(
      `[arms-api] Autostart PID ${existingPid} is alive but does not match agent command; skipping forced restart`,
    );
    return false;
  }

  try {
    process.kill(existingPid, "SIGTERM");
  } catch {
    // Fall through and try best-effort cleanup/start.
  }

  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(existingPid)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (isProcessAlive(existingPid)) {
    try {
      process.kill(existingPid, "SIGKILL");
    } catch {
      // Ignore - start path below will still try.
    }
  }

  await unlink(pidFile).catch(() => undefined);
  await startLocalArmAgentDaemonIfNeeded();
  return true;
}

async function startLocalArmAgentDaemonIfNeeded(): Promise<void> {
  if (process.env.COLEO_AUTO_START_AGENT === "0") {
    return;
  }

  const coleoDir = getColeoDir();
  const runDir = join(coleoDir, "run");
  const pidFile = join(runDir, "agent-autostart.pid");
  const logFile = join(runDir, "agent-autostart.log");
  await mkdir(runDir, { recursive: true });

  try {
    const existing = JSON.parse(await readFile(pidFile, "utf-8")) as {
      pid?: number;
    };
    if (typeof existing.pid === "number" && isProcessAlive(existing.pid)) {
      return;
    }
    await unlink(pidFile).catch(() => undefined);
  } catch {
    // No existing PID file
  }

  const natsUrl = process.env.COLEO_NATS_URL || "nats://localhost:4222";
  const command = [
    process.execPath,
    getCliEntrypoint(),
    "agent",
    "start",
    "--nats-url",
    natsUrl,
    "--id",
    AUTO_AGENT_ID,
  ];

  const shellCommand = command.map(shellQuote).join(" ");
  const launchCommand = `nohup ${shellCommand} >> ${shellQuote(logFile)} 2>&1 & echo $!`;
  const pidOutput = execSync(launchCommand, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      COLEO_SELF_MODIFY: undefined,
    },
    encoding: "utf-8",
  }).trim();

  const pid = Number.parseInt(pidOutput, 10);
  if (!Number.isFinite(pid)) {
    throw new Error(`Unable to parse autostart agent PID: ${pidOutput}`);
  }

  await writeFile(
    pidFile,
    JSON.stringify(
      {
        pid,
        id: AUTO_AGENT_ID,
        startedAt: new Date().toISOString(),
        natsUrl,
      },
      null,
      2,
    ),
    "utf-8",
  );

  console.log(`[arms-api] Auto-started local arm agent: ${AUTO_AGENT_ID} (pid ${pid})`);
}

async function ensureDaemonAgentAvailable(
  armClient: ArmClientLookup,
  harness: string,
): Promise<void> {
  if (armClient.findBestAgent(harness)) {
    return;
  }
  if (process.env.COLEO_AUTO_START_AGENT === "0") {
    return;
  }

  if (!autoStartAgentPromise) {
    autoStartAgentPromise = startLocalArmAgentDaemonIfNeeded().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[arms-api] Failed to auto-start arm agent: ${msg}`);
    });
  }

  try {
    await autoStartAgentPromise;
  } finally {
    autoStartAgentPromise = null;
  }

  const configuredWait = Number.parseInt(
    process.env.COLEO_AUTO_START_AGENT_WAIT_MS || "",
    10,
  );
  const waitMs =
    Number.isFinite(configuredWait) && configuredWait > 0
      ? configuredWait
      : AUTO_AGENT_WAIT_MS_DEFAULT;
  const deadline = Date.now() + waitMs;

  while (Date.now() < deadline) {
    if (armClient.findBestAgent(harness)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  // If the local autostart agent process is stale (alive but disconnected from NATS),
  // force-restart it once and wait again for discovery.
  try {
    const restarted = await restartLocalAutostartAgentIfStale();
    if (restarted) {
      const restartDeadline = Date.now() + waitMs;
      while (Date.now() < restartDeadline) {
        if (armClient.findBestAgent(harness)) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[arms-api] Failed to restart stale autostart agent: ${msg}`);
  }

  if (armClient.listArmsOnAgent) {
    try {
      const probe = await armClient.listArmsOnAgent(AUTO_AGENT_ID, 2000);
      if (probe.success) {
        return;
      }
    } catch {
      // Fall through to caller error path.
    }
  }
}

/**
 * Log an activity entry to JetStream
 * This replaces the old SQLite activity table - JetStream is now the single source of truth
 */
function logActivity(_db: Database, actor: string, action: string, target?: string, details?: Record<string, unknown>): void {
  const resolvedTarget = target || (actor !== "api" ? actor : undefined);

  // Publish to JetStream if initialized
  if (eventStore.isInitialized()) {
    const subject = resolvedTarget 
      ? `coleo.events.arm.${resolvedTarget}.${action}`
      : `coleo.events.api.${action}`;
    
    eventStore.publishEvent(subject, {
      type: action,
      armId: resolvedTarget,
      data: { actor, ...details },
      timestamp: new Date().toISOString(),
    }).catch(err => {
      console.error(`[arms-api] Failed to publish activity event: ${err}`);
    });
  }
}

function recordMetricSnapshot(db: Database, armId: string, timestamp = new Date().toISOString()): void {
  try {
    const arm = db.query(
      `SELECT current_context_used, context_budget, total_tokens, total_cost FROM arms WHERE id = ?`,
    ).get(armId) as {
      current_context_used: number;
      context_budget: number;
      total_tokens: number | null;
      total_cost: number | null;
    } | null;
    if (!arm) return;

    db.run(
      `INSERT INTO arm_metric_history
       (arm_id, timestamp, context_used, context_budget, total_tokens, total_cost)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        armId,
        timestamp,
        arm.current_context_used,
        arm.context_budget,
        arm.total_tokens ?? 0,
        arm.total_cost ?? 0,
      ],
    );
  } catch {
    // Older test databases may not have applied the history migration yet.
  }
}

export interface ArmProfile {
  id: string;
  name: string;
  domain: string;
  harness: string;
  status: "idle" | "busy" | "paused" | "error" | "stopped" | "starting" | "running";
  contextBudget: number;
  currentContextUsed: number;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
  recoveryRequestedAt?: string;
  lastHeartbeat?: string | null;
  lastOutputAt?: string | null;
  config: Record<string, unknown>;
  pid?: number;
  port?: number;
  provider?: string;
  model?: string;
  totalTokens?: number;
  totalCost?: number;
  currentTaskId?: string;
  currentTaskSubject?: string;
  currentBugId?: string;
  currentBugTitle?: string;
  agentId?: string;
  host?: string;
  sessionId?: string;
  workdir?: string;
  runtime?: ArmRuntimeSummary;
}

function parseArmConfig(config: string | null | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(config || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export interface ArmTemplate {
  name: string;
  domain: string;
  harness: string;
  contextBudget: number;
  provider?: string;
  model?: string;
  personality?: string;
  convictions?: string[];
  config: Record<string, unknown>;
}

export interface ArmTemplateSummary {
  id: string;
  filename: string;
  name: string;
  description: string;
  domain: string;
  harness: string;
  contextBudget: number;
  provider?: string;
  model?: string;
}

function deriveArmRuntime(row: {
  status: string;
  pid: number | null;
  port: number | null;
  sessionId: string | null;
  agentId: string | null;
  workdir: string | null;
  currentTaskId: string | null;
  currentTaskSubject: string | null;
  lastActivityAt: string | null;
  lastHeartbeat: string | null;
  lastOutputAt: string | null;
}): ArmRuntimeSummary {
  const secondsSinceActivity = ageInSeconds(row.lastActivityAt);
  const secondsSinceHeartbeat = ageInSeconds(row.lastHeartbeat);
  const secondsSinceOutput = ageInSeconds(row.lastOutputAt);
  const distributed = Boolean(row.agentId);
  const hasPid = typeof row.pid === "number" && row.pid > 0;
  const hasPort = typeof row.port === "number" && row.port > 0;
  const hasSessionId = typeof row.sessionId === "string" && row.sessionId.length > 0;
  const hasRuntime = hasPid || hasPort || hasSessionId || distributed;
  const hasSession = hasPort || hasSessionId;
  const hasWorkdir = typeof row.workdir === "string" && row.workdir.length > 0;
  const hasAssignedTask = Boolean(row.currentTaskId || row.currentTaskSubject);
  const recentOutput = isAgeWithin(secondsSinceOutput, ACTIVE_OUTPUT_THRESHOLD_MS);
  const recentActivity = isAgeWithin(secondsSinceActivity, QUIET_OUTPUT_THRESHOLD_MS);
  const recentHeartbeat = isAgeWithin(secondsSinceHeartbeat, STALE_HEARTBEAT_THRESHOLD_MS);
  const outputIsStale =
    secondsSinceOutput !== null && secondsSinceOutput * 1000 > HUNG_OUTPUT_THRESHOLD_MS;
  const canRecover = hasWorkdir || hasRuntime;
  const canRestart = hasWorkdir || hasRuntime;

  let state: ArmRuntimeState = "unknown";
  let reason = "No runtime signals were recorded for this arm.";

  if (row.status === "starting") {
    state = "starting";
    reason = hasRuntime
      ? "The arm has runtime metadata and is still starting."
      : "The arm is marked as starting but has not reported a runtime yet.";
  } else if (row.status === "stopped") {
    state = "stopped";
    reason = canRecover
      ? "The arm is stopped but has enough metadata to recover or restart."
      : "The arm is stopped and missing runtime metadata needed for recovery.";
  } else if (row.status === "error") {
    state = canRecover ? "recoverable" : "unknown";
    reason = canRecover
      ? "The arm reported an error and can be recovered or restarted."
      : "The arm reported an error and no recovery metadata is available.";
  } else if (row.status === "busy" || row.status === "running") {
    if (recentOutput || recentActivity || recentHeartbeat) {
      state = "active";
      reason = recentOutput
        ? "Recent output is still arriving from this arm."
        : recentHeartbeat
          ? "The arm is still heartbeating even though output is quiet."
          : "The arm recently reported activity.";
    } else if (hasRuntime) {
      state = "hung";
      reason = outputIsStale
        ? "The arm still has a runtime but has not produced output recently."
        : "The arm is marked busy but recent runtime activity is missing.";
    } else {
      state = "recoverable";
      reason = "The arm is marked busy but no active runtime is visible.";
    }
  } else if (row.status === "idle" || row.status === "paused") {
    if (recentOutput || recentActivity || recentHeartbeat || hasRuntime) {
      state = "quiet";
      reason = recentOutput
        ? "The arm produced output recently and is now quiet."
        : recentHeartbeat
          ? "The arm is reachable and currently idle."
          : hasRuntime
            ? "The arm still has a runtime attached but has not emitted recent output."
            : "The arm recently reported activity and is currently quiet.";
    } else {
      state = canRecover ? "recoverable" : "unknown";
      reason = canRecover
        ? "The arm is idle in the database but no fresh runtime signals are visible."
        : "The arm is idle and no runtime metadata is available.";
    }
  }

  return {
    state,
    reason,
    distributed,
    hasRuntime,
    hasSession,
    canRecover,
    canRestart,
    lastActivityAt: row.lastActivityAt,
    lastHeartbeatAt: row.lastHeartbeat,
    lastOutputAt: row.lastOutputAt,
    secondsSinceActivity,
    secondsSinceHeartbeat,
    secondsSinceOutput,
    signals: {
      dbStatus: row.status,
      hasPid,
      hasPort,
      hasSessionId,
      hasAgentId: distributed,
      hasWorkdir,
      hasAssignedTask,
      distributed,
    },
  };
}

interface TemplateFileCandidate {
  id: string;
  filename: string;
  path: string;
}

function normalizeTemplateId(value: string): string {
  return value.trim().replace(/\.(ya?ml|toml)$/i, "");
}

async function listTemplateFileCandidates(): Promise<TemplateFileCandidate[]> {
  const coleoDir = getColeoDir();
  const templateDirs = [
    {
      dir: join(coleoDir, "templates"),
      extensions: [".yml", ".yaml"],
    },
    {
      dir: join(coleoDir, "arms"),
      extensions: [".toml"],
    },
  ] as const;

  const candidates: TemplateFileCandidate[] = [];
  for (const templateDir of templateDirs) {
    let files: string[] = [];
    try {
      files = await readdir(templateDir.dir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!templateDir.extensions.some((extension) => file.endsWith(extension))) {
        continue;
      }
      candidates.push({
        id: normalizeTemplateId(file),
        filename: file,
        path: join(templateDir.dir, file),
      });
    }
  }

  return candidates.sort((a, b) => a.filename.localeCompare(b.filename));
}

function extractTemplateDescription(template: ArmTemplate): string {
  return template.personality || `${template.domain} specialist`;
}

function getNestedRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseArmTemplateYaml(content: string): ArmTemplate {
  const result: ArmTemplate = {
    name: "",
    domain: "general",
    harness: "opencode-api",
    contextBudget: 100000,
    config: {},
  };

  let parsed: Record<string, unknown> = {};
  try {
    parsed = (Bun.YAML.parse(content) as Record<string, unknown> | null) ?? {};
  } catch {
    return result;
  }

  const arm = getNestedRecord(parsed.arm);
  const model = getNestedRecord(parsed.model);
  const context = getNestedRecord(parsed.context);
  const personality = getNestedRecord(parsed.personality);
  const convictions = getNestedRecord(parsed.convictions);
  const config = getNestedRecord(parsed.config);

  const name = (arm?.name ?? parsed.name) as string | undefined;
  const domain = (arm?.domain ?? parsed.domain) as string | undefined;
  const harness = (arm?.harness ?? parsed.harness) as string | undefined;
  const provider = (model?.provider ?? parsed.provider) as string | undefined;
  const modelName = (model?.model ?? parsed.model) as string | undefined;
  const budget =
    (context?.budget ?? parsed.contextBudget ?? parsed.budget) as number | undefined;
  const traits = (personality?.traits ?? parsed.description ?? parsed.traits) as
    | string
    | undefined;
  const core = (convictions?.core ?? parsed.core) as string[] | undefined;

  if (name) result.name = name;
  if (domain) result.domain = domain;
  if (harness) result.harness = harness;
  if (provider) result.provider = provider;
  if (modelName) result.model = modelName;
  if (typeof budget === "number") result.contextBudget = budget;
  if (traits) result.personality = traits;
  if (Array.isArray(core)) result.convictions = core.filter((entry) => typeof entry === "string");
  if (config) result.config = config;

  return result;
}

/**
 * Load an arm template from .coleo/templates/*.yml (preferred) or legacy .coleo/arms/*.toml.
 * Searches by filename first, then by name field inside template files.
 */
export async function loadArmTemplate(name: string): Promise<ArmTemplate | null> {
  const normalizedName = normalizeTemplateId(name);
  const candidates = await listTemplateFileCandidates();

  for (const candidate of candidates) {
    if (candidate.id !== normalizedName && candidate.filename !== name) {
      continue;
    }

    try {
      const content = await readFile(candidate.path, "utf-8");
      return candidate.filename.endsWith(".toml")
        ? parseArmTemplate(content)
        : parseArmTemplateYaml(content);
    } catch {
      // Fall through to name-field lookup below.
    }
  }

  for (const candidate of candidates) {
    try {
      const content = await readFile(candidate.path, "utf-8");
      const parsed = candidate.filename.endsWith(".toml")
        ? parseArmTemplate(content)
        : parseArmTemplateYaml(content);
      if (parsed.name === name || parsed.name === normalizedName) {
        return parsed;
      }
    } catch {
      // Skip unreadable files.
    }
  }

  return null;
}

/**
 * Parse arm template TOML content
 */
function parseArmTemplate(content: string): ArmTemplate {
  const result: ArmTemplate = {
    name: "",
    domain: "general",
    harness: "opencode-api",
    contextBudget: 100000,
    config: {},
  };

  try {
    const parsed = parseToml(content) as Record<string, unknown>;
    const arm = parsed.arm as Record<string, unknown> | undefined;
    const model = parsed.model as Record<string, unknown> | undefined;
    const context = parsed.context as Record<string, unknown> | undefined;
    const personality = parsed.personality as Record<string, unknown> | undefined;
    const convictions = parsed.convictions as Record<string, unknown> | undefined;

    const name = (arm?.name ?? parsed.name) as string | undefined;
    const domain = (arm?.domain ?? parsed.domain) as string | undefined;
    const harness = (arm?.harness ?? parsed.harness) as string | undefined;
    const provider = (model?.provider ?? parsed.provider) as string | undefined;
    const modelName = (model?.model ?? parsed.model) as string | undefined;
    const budget = (context?.budget ?? parsed.budget) as number | undefined;
    const traits = (personality?.traits ?? parsed.traits) as string | undefined;
    const core = (convictions?.core ?? parsed.core) as string[] | undefined;

    if (name) result.name = name;
    if (domain) result.domain = domain;
    if (harness) result.harness = harness;
    if (typeof budget === "number") result.contextBudget = budget;
    if (traits) result.personality = traits;
    if (Array.isArray(core)) result.convictions = core;
    if (provider) result.provider = provider;
    if (modelName) result.model = modelName;
    } catch {}

  const nameMatch = content.match(/name\s*=\s*["']([^"']*)["']/);
  const domainMatch = content.match(/domain\s*=\s*["']([^"']*)["']/);
  const harnessMatch = content.match(/harness\s*=\s*["']([^"']*)["']/);
  const budgetMatch = content.match(/budget\s*=\s*(\d+)/);
  const traitsMatch = content.match(/traits\s*=\s*["']([^"']*)["']/);
  const convictionsMatch = content.match(/core\s*=\s*\[([^\]]*)\]/);
  const providerMatch = content.match(/provider\s*=\s*["']([^"']*)["']/);
  const modelMatch = content.match(/model\s*=\s*["']([^"']*)["']/);

  if (!result.name && nameMatch?.[1]) result.name = nameMatch[1];
  if (result.domain === "general" && domainMatch?.[1]) result.domain = domainMatch[1];
  if (result.harness === "opencode-api" && harnessMatch?.[1]) result.harness = harnessMatch[1];
  if (result.contextBudget === 100000 && budgetMatch?.[1]) {
    result.contextBudget = parseInt(budgetMatch[1], 10);
  }
  if (!result.personality && traitsMatch?.[1]) result.personality = traitsMatch[1];
  if (!result.convictions && convictionsMatch?.[1]) {
    result.convictions = convictionsMatch[1].split(",").map((s) => s.trim().replace(/["']/g, ""));
  }
  if (!result.provider && providerMatch?.[1]) result.provider = providerMatch[1];
  if (!result.model && modelMatch?.[1]) result.model = modelMatch[1];

  return result;
}

/**
 * List available arm templates
 */
export async function listArmTemplates(): Promise<string[]> {
  const candidates = await listTemplateFileCandidates();
  return candidates.map((candidate) => candidate.id);
}

export async function listArmTemplateSummaries(): Promise<ArmTemplateSummary[]> {
  const candidates = await listTemplateFileCandidates();
  const templates = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const content = await readFile(candidate.path, "utf-8");
        const parsed = candidate.filename.endsWith(".toml")
          ? parseArmTemplate(content)
          : parseArmTemplateYaml(content);
        return {
          id: candidate.id,
          filename: candidate.filename,
          name: parsed.name || candidate.id,
          description: extractTemplateDescription(parsed),
          domain: parsed.domain,
          harness: parsed.harness,
          contextBudget: parsed.contextBudget,
          provider: parsed.provider,
          model: parsed.model,
        } satisfies ArmTemplateSummary;
      } catch {
        return null;
      }
    }),
  );

  return templates.filter((template) => template !== null) as ArmTemplateSummary[];
}

export function createArmsRoutes() {
  const app = new Hono<ArmsContext>();

  function normalizeArmMessage(message: unknown): unknown {
    if (!message || typeof message !== "object") {
      return message;
    }

    const asRecord = message as Record<string, unknown>;
    const info = asRecord.info;
    if (!info || typeof info !== "object") {
      return asRecord;
    }

    const infoRecord = info as Record<string, unknown>;
    const tokenData =
      infoRecord.tokenData &&
      typeof infoRecord.tokenData === "object" &&
      !Array.isArray(infoRecord.tokenData)
        ? (infoRecord.tokenData as Record<string, unknown>)
        : undefined;
    const messageData =
      infoRecord.messageData &&
      typeof infoRecord.messageData === "object" &&
      !Array.isArray(infoRecord.messageData)
        ? (infoRecord.messageData as Record<string, unknown>)
        : undefined;

    const coerceString = (value: unknown): string | undefined =>
      typeof value === "string" && value.length > 0 ? value : undefined;
    const coerceNumber = (value: unknown): number | undefined => {
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }

      if (typeof value === "string") {
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : undefined;
      }

      return undefined;
    };

    const normalizedModelId =
      coerceString(infoRecord.modelId) ||
      coerceString(infoRecord.modelID) ||
      coerceString(infoRecord.model) ||
      coerceString(messageData?.modelId) ||
      coerceString(messageData?.modelID) ||
      coerceString(messageData?.model);

    const normalizedProviderId =
      coerceString(infoRecord.providerId) ||
      coerceString(infoRecord.providerID) ||
      coerceString(infoRecord.provider) ||
      coerceString(messageData?.providerId) ||
      coerceString(messageData?.providerID) ||
      coerceString(messageData?.provider);

    const normalizedTokens: {
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    } = {};
    const tokenSource =
      infoRecord.tokens &&
      typeof infoRecord.tokens === "object" &&
      !Array.isArray(infoRecord.tokens)
        ? (infoRecord.tokens as Record<string, unknown>)
        : tokenData;

    const cacheFromNested =
      tokenSource &&
      tokenSource.cache &&
      typeof tokenSource.cache === "object" &&
      !Array.isArray(tokenSource.cache)
        ? (tokenSource.cache as Record<string, unknown>)
        : undefined;

    if (tokenSource) {
      const input = coerceNumber(tokenSource.input);
      const output = coerceNumber(tokenSource.output);
      const reasoning = coerceNumber(tokenSource.reasoning);
      const cacheRead = coerceNumber(tokenSource.cacheRead) ?? coerceNumber(cacheFromNested?.read);
      const cacheWrite = coerceNumber(tokenSource.cacheWrite) ?? coerceNumber(cacheFromNested?.write);
      const hasTokenValues =
        input !== undefined ||
        output !== undefined ||
        reasoning !== undefined ||
        cacheRead !== undefined ||
        cacheWrite !== undefined;

      if (hasTokenValues) {
        if (input !== undefined) normalizedTokens.input = input;
        if (output !== undefined) normalizedTokens.output = output;
        if (reasoning !== undefined) normalizedTokens.reasoning = reasoning;
        if (cacheRead !== undefined) {
          normalizedTokens.cache = {
            ...normalizedTokens.cache,
            read: cacheRead,
          };
        }
        if (cacheWrite !== undefined) {
          normalizedTokens.cache = {
            ...normalizedTokens.cache,
            write: cacheWrite,
          };
        }
      }
    }

    const existingMessageData = messageData ? { ...messageData } : undefined;

    if (existingMessageData) {
      if (!existingMessageData.modelId && normalizedModelId) {
        existingMessageData.modelId = normalizedModelId;
      }
      if (!existingMessageData.providerId && normalizedProviderId) {
        existingMessageData.providerId = normalizedProviderId;
      }
    }

    if (normalizedModelId !== undefined) {
      if (!coerceString(infoRecord.model)) infoRecord.model = normalizedModelId;
      if (!coerceString(infoRecord.modelId)) infoRecord.modelId = normalizedModelId;
      if (!coerceString(infoRecord.modelID)) infoRecord.modelID = normalizedModelId;
    }

    if (normalizedProviderId !== undefined) {
      if (!coerceString(infoRecord.provider)) infoRecord.provider = normalizedProviderId;
      if (!coerceString(infoRecord.providerId)) infoRecord.providerId = normalizedProviderId;
      if (!coerceString(infoRecord.providerID)) infoRecord.providerID = normalizedProviderId;
    }

    if (Object.keys(normalizedTokens).length > 0) {
      infoRecord.tokens = normalizedTokens;
    }

    if (existingMessageData) {
      infoRecord.messageData = existingMessageData;
    }

    if (!Object.prototype.hasOwnProperty.call(infoRecord, "cost") && tokenData) {
      const tokenCost = coerceNumber(tokenData.cost);
      if (tokenCost !== undefined) {
        infoRecord.cost = tokenCost;
      }
    }

    return {
      ...asRecord,
      info: {
        ...infoRecord,
      },
    };
  }

  const normalizeMessagesForCostChart = (messages: unknown) => {
    if (!Array.isArray(messages)) {
      return [];
    }

    return messages.map((message) => normalizeArmMessage(message));
  };

  /**
   * List all arms
   * GET /api/arms
   */
  app.get("/", (c) => {
    const db = c.get("db");
    const includeAll = c.req.query("includeAll") === "true";
    
    try {
      const rows = db.query(`
        SELECT
          id, name, domain, harness, status,
          context_budget as contextBudget,
          current_context_used as currentContextUsed,
          created_at as createdAt,
          updated_at as updatedAt,
          last_activity_at as lastActivityAt,
          last_heartbeat as lastHeartbeat,
          last_output_at as lastOutputAt,
          current_task_id as currentTaskId,
          pid, port, provider, model,
          total_tokens as totalTokens,
          total_cost as totalCost,
          current_task_subject as currentTaskSubject,
          current_bug_id as currentBugId,
          current_bug_title as currentBugTitle,
          agent_id as agentId,
          host,
          session_id as sessionId,
          workdir,
          config
        FROM arms
        ${includeAll ? "" : "WHERE NOT (harness = 'manual' AND status = 'idle' AND current_task_subject IS NULL)"}
        ORDER BY name
      `).all() as ArmRow[];

      const arms = rows.map(parseArmRow);
      return c.json({ arms });
    } catch {
      return c.json({ arms: [] });
    }
  });

  /**
   * List available arm templates
   * GET /api/arms/templates
   */
  app.get("/templates", async (c) => {
    const templates = await listArmTemplateSummaries();
    return c.json({ templates });
  });

  /**
   * Get semantic status-history results for one arm.
   * GET /api/arms/:id/status-history
   */
  app.get("/:id/status-history", async (c) => {
    const armId = c.req.param("id");
    const from = c.req.query("from");
    const to = c.req.query("to");
    const limit = Number.parseInt(c.req.query("limit") || "100", 10);

    try {
      const hits = await searchStatusHistory(armId, {
        limit,
        armId,
        since: from ? new Date(from) : undefined,
        until: to ? new Date(to) : undefined,
      });
      return c.json({
        armId,
        events: hits.map((hit) => hit.event),
        total: hits.length,
      });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Arm status history failed" },
        500,
      );
    }
  });

  /**
   * Get a single arm
   * GET /api/arms/:id
   */
  app.get("/:id", (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    const row = db.query(`
      SELECT 
        id, name, domain, harness, status,
        context_budget as contextBudget,
        current_context_used as currentContextUsed,
        created_at as createdAt,
        updated_at as updatedAt,
        last_activity_at as lastActivityAt,
        last_heartbeat as lastHeartbeat,
        last_output_at as lastOutputAt,
        current_task_id as currentTaskId,
        pid, port, provider, model,
        total_tokens as totalTokens,
        total_cost as totalCost,
        current_task_subject as currentTaskSubject,
        current_bug_id as currentBugId,
        current_bug_title as currentBugTitle,
        agent_id as agentId,
        host,
        session_id as sessionId,
        workdir,
        config
      FROM arms
      WHERE id = ?
    `).get(id) as ArmRow | null;

    if (!row) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    return c.json({ arm: parseArmRow(row) });
  });

  /**
   * Create a new arm
   * POST /api/arms
   */
  app.post("/", async (c) => {
    const db = c.get("db");
    const body = await c.req.json<{
      name: string;
      template?: string;
      domain?: string;
      harness?: string;
      provider?: string;
      model?: string;
      workdir?: string;
      contextBudget?: number;
      config?: Record<string, unknown>;
    }>();

    if (!body.name) {
      throw HttpError.badRequest("name is required");
    }

    // Load template if specified
    let template: ArmTemplate | null = null;
    if (body.template) {
      template = await loadArmTemplate(body.template);
      if (!template) {
        throw HttpError.badRequest(`Template not found: ${body.template}`);
      }
    }

    // Load config for defaults
    const config = await loadConfig();
    const defaults = config.defaults;

    const id = body.name;
    const now = new Date().toISOString();

    // Use template values, then body values, then config defaults
    const harness = body.harness || template?.harness || defaults.harness;
    const provider = body.provider || template?.provider || defaults.provider;
    const model = body.model || template?.model || defaults.model;
    const contextBudget = body.contextBudget || template?.contextBudget || defaults.contextBudget;
    const domain = body.domain || template?.domain || "general";

    db.run(`
      INSERT INTO arms (id, name, domain, harness, status, context_budget, current_context_used, created_at, updated_at, pid, provider, model, workdir, config)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      body.name,
      domain,
      harness,
      "starting",
      contextBudget,
      0,
      now,
      now,
      null,
      provider,
      model,
      body.workdir || null,
      JSON.stringify(body.config || template?.config || {}),
    ]);

    // Log activity
    logActivity(db, body.name, "registered", undefined, { domain, harness, provider, model });

    const arm = {
      id,
      name: body.name,
      domain,
      harness,
      status: "starting" as const,
      contextBudget,
      currentContextUsed: 0,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: null,
      lastOutputAt: null,
      pid: undefined,
      provider,
      model,
      workdir: body.workdir,
      runtime: deriveArmRuntime({
        status: "starting",
        pid: null,
        port: null,
        sessionId: null,
        agentId: null,
        workdir: body.workdir || null,
        currentTaskId: null,
        currentTaskSubject: null,
        lastActivityAt: null,
        lastHeartbeat: null,
        lastOutputAt: null,
      }),
      config: body.config || template?.config || {},
    };

    // Broadcast arm creation
    broadcast("arms", "arm.created", { arm });

    return c.json({ arm }, 201);
  });

  /**
   * Update an arm
   * PATCH /api/arms/:id
   */
  app.patch("/:id", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const body = await c.req.json<Partial<ArmProfile>>();

    // Check arm exists
    const existing = db.query("SELECT id FROM arms WHERE id = ?").get(id);
    if (!existing) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    const updates: string[] = [];
    const values: unknown[] = [];

    if (body.name !== undefined) {
      updates.push("name = ?");
      values.push(body.name);
    }
    if (body.domain !== undefined) {
      updates.push("domain = ?");
      values.push(body.domain);
    }
    if (body.harness !== undefined) {
      updates.push("harness = ?");
      values.push(body.harness);
    }
    if (body.status !== undefined) {
      updates.push("status = ?");
      values.push(body.status);
      // Log status change
      logActivity(db, id, "arm.status_changed", undefined, { newStatus: body.status });
    }
    if (body.contextBudget !== undefined) {
      updates.push("context_budget = ?");
      values.push(body.contextBudget);
    }
    if (body.currentContextUsed !== undefined) {
      updates.push("current_context_used = ?");
      values.push(body.currentContextUsed);
    }
    if (body.pid !== undefined) {
      updates.push("pid = ?");
      values.push(body.pid);
    }
    if (body.provider !== undefined) {
      updates.push("provider = ?");
      values.push(body.provider);
    }
    if (body.model !== undefined) {
      updates.push("model = ?");
      values.push(body.model);
    }
    if (body.config !== undefined) {
      updates.push("config = ?");
      values.push(JSON.stringify(body.config));
    }
    if (body.lastActivityAt !== undefined) {
      updates.push("last_activity_at = ?");
      values.push(body.lastActivityAt);
    }
    if (body.lastHeartbeat !== undefined) {
      updates.push("last_heartbeat = ?");
      values.push(body.lastHeartbeat);
    }
    if (body.lastOutputAt !== undefined) {
      updates.push("last_output_at = ?");
      values.push(body.lastOutputAt);
    }
    if (body.currentTaskId !== undefined) {
      updates.push("current_task_id = ?");
      values.push(body.currentTaskId);
    }
    if (body.currentTaskSubject !== undefined) {
      updates.push("current_task_subject = ?");
      values.push(body.currentTaskSubject);
    }
    if (body.currentBugId !== undefined) {
      updates.push("current_bug_id = ?");
      values.push(body.currentBugId);
    }
    if (body.currentBugTitle !== undefined) {
      updates.push("current_bug_title = ?");
      values.push(body.currentBugTitle);
    }
    if (body.workdir !== undefined) {
      updates.push("workdir = ?");
      values.push(body.workdir);
    }
    if (body.sessionId !== undefined) {
      updates.push("session_id = ?");
      values.push(body.sessionId);
    }
    if (body.port !== undefined) {
      updates.push("port = ?");
      values.push(body.port);
    }
    if (body.agentId !== undefined) {
      updates.push("agent_id = ?");
      values.push(body.agentId);
    }
    if (body.host !== undefined) {
      updates.push("host = ?");
      values.push(body.host);
    }

    if (updates.length === 0) {
      throw HttpError.badRequest("No fields to update");
    }

    const updatedAt = new Date().toISOString();
    updates.push("updated_at = ?");
    values.push(updatedAt);
    values.push(id);

    db.run(`UPDATE arms SET ${updates.join(", ")} WHERE id = ?`, values as (string | number | null)[]);

    if (body.currentContextUsed !== undefined || body.contextBudget !== undefined) {
      recordMetricSnapshot(db, id, updatedAt);
    }

    if (body.status === "stopped") {
      const releasedClaims = releaseClaimsForArm(db, id, updatedAt);
      if (releasedClaims > 0) {
        logActivity(db, id, "claims_released", undefined, { releasedClaims });
      }
    }

    // Fetch updated arm
    const row = db.query(`
      SELECT 
        id, name, domain, harness, status,
        context_budget as contextBudget,
        current_context_used as currentContextUsed,
        created_at as createdAt,
        updated_at as updatedAt,
        last_activity_at as lastActivityAt,
        last_heartbeat as lastHeartbeat,
        last_output_at as lastOutputAt,
        current_task_id as currentTaskId,
        pid, port, provider, model,
        current_task_subject as currentTaskSubject,
        current_bug_id as currentBugId,
        current_bug_title as currentBugTitle,
        agent_id as agentId,
        host,
        session_id as sessionId,
        workdir,
        config
      FROM arms
      WHERE id = ?
    `).get(id) as ArmRow;

    const arm = parseArmRow(row);

    // Broadcast arm update
    broadcast("arms", "arm.updated", { arm, changes: body });

    return c.json({ arm });
  });

  /**
   * Flag an active arm for recovery on the brain's next health pass.
   * POST /api/arms/:id/mark-stuck
   */
  app.post("/:id/mark-stuck", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const existing = db.query("SELECT id, status, config FROM arms WHERE id = ?").get(id) as {
      id: string;
      status: string;
      config: string;
    } | null;

    if (!existing) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }
    if (existing.status === "stopped") {
      throw HttpError.badRequest(`Arm ${id} is stopped. Spawn it before marking it stuck.`);
    }

    // Keep the arm eligible for the brain's busy-arm recovery path without faking fresh activity.
    const staleAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const recoveryRequestedAt = new Date().toISOString();
    const config = parseArmConfig(existing.config);
    db.run("UPDATE arms SET status = ?, last_activity_at = ?, updated_at = ?, config = ? WHERE id = ?", [
      "busy",
      staleAt,
      recoveryRequestedAt,
      JSON.stringify({ ...config, recoveryRequestedAt }),
      id,
    ]);
    logActivity(db, "api", "arm.manual_stuck", undefined, {
      armId: id,
      previousStatus: existing.status,
      recoveryRequestedAt,
    });
    console.info(`[arms-api] Recovery requested for stuck arm ${id} at ${recoveryRequestedAt}`);

    const row = db.query(`
      SELECT id, name, domain, harness, status,
        context_budget as contextBudget, current_context_used as currentContextUsed,
        created_at as createdAt, updated_at as updatedAt, last_activity_at as lastActivityAt,
        last_heartbeat as lastHeartbeat, last_output_at as lastOutputAt,
        current_task_id as currentTaskId, pid, port, provider, model,
        total_tokens as totalTokens, total_cost as totalCost,
        current_task_subject as currentTaskSubject, current_bug_id as currentBugId,
        current_bug_title as currentBugTitle, agent_id as agentId, host, session_id as sessionId,
        workdir, config
      FROM arms WHERE id = ?
    `).get(id) as ArmRow;
    const arm = parseArmRow(row);
    broadcast("arms", "arm.updated", { arm });
    return c.json({ arm });
  });

  /**
   * Delete an arm
   * DELETE /api/arms/:id
   */
  app.delete("/:id", (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    const result = db.run("DELETE FROM arms WHERE id = ?", [id]);
    if (result.changes === 0) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    // Log activity
    logActivity(db, id, "removed");

    // Broadcast arm deletion
    broadcast("arms", "arm.deleted", { id });

    return c.json({ deleted: true });
  });

  app.post("/:id/spawn", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const body = await c.req.json<{
      name?: string;
      domain?: string;
      template?: string;
      workdir?: string;
      provider?: string;
      model?: string;
      initialPrompt?: string;
      harness?: string;
      preferAgent?: boolean;
      agentId?: string;
      recover?: boolean;
      allowLocalFallback?: boolean;
    }>();

    // Check if arm exists (include runtime metadata for recovery)
    let row = db.query("SELECT id, name, domain, harness, status, provider, model, port, pid, session_id, agent_id, host, context_budget, workdir, last_activity_at, last_heartbeat, last_output_at, current_task_id, current_task_subject FROM arms WHERE id = ?").get(id) as {
      id: string;
      name: string;
      domain: string;
      harness: string;
      status: string;
      provider: string | null;
      model: string | null;
      port: number | null;
      pid: number | null;
      session_id: string | null;
      agent_id: string | null;
      host: string | null;
      context_budget: number;
      workdir: string | null;
      last_activity_at: string | null;
      last_heartbeat: string | null;
      last_output_at: string | null;
      current_task_id: string | null;
      current_task_subject: string | null;
    } | null;

    console.log(`[spawn] Checking arm ${id}, exists: ${!!row}`);

    // If arm doesn't exist, create it first (for CLI convenience)
    if (!row) {
      console.log(`[spawn] Arm ${id} not found, creating arm record first`);

      // Load config for defaults
      const config = await loadConfig();
      const defaults = config.defaults;
      let template: ArmTemplate | null = null;
      if (body.template) {
        template = await loadArmTemplate(body.template);
        if (!template) {
          throw HttpError.badRequest(`Template not found: ${body.template}`);
        }
      }

      const now = new Date().toISOString();
      const harness = body.harness || template?.harness || defaults.harness;
      const provider = body.provider || template?.provider || defaults.provider;
      const model = body.model || template?.model || defaults.model;
      const contextBudget = template?.contextBudget || defaults.contextBudget;
      const armName = body.name?.trim() || id;
      const armDomain = body.domain?.trim() || template?.domain || "general";

      try {
        // Create the arm record
        db.run(`
          INSERT INTO arms (id, name, domain, harness, status, context_budget, current_context_used, created_at, updated_at, pid, provider, model, workdir, config)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          id,
          armName,
          armDomain,
          harness,
          "starting",
          contextBudget,
          0,
          now,
          now,
          null,
          provider,
          model,
          body.workdir || null,
          JSON.stringify(template?.config || {}),
        ]);

        // Log activity
        logActivity(db, id, "registered", undefined, {
          domain: armDomain,
          harness,
          provider,
          model,
        });
        console.log(`[spawn] Created arm record for ${id}`);

        // Fetch the newly created arm
        row = db.query("SELECT id, name, domain, harness, status, provider, model, port, pid, session_id, agent_id, host, context_budget, workdir, last_activity_at, last_heartbeat, last_output_at, current_task_id, current_task_subject FROM arms WHERE id = ?").get(id) as typeof row;

        if (!row) {
          throw new Error(`Failed to fetch newly created arm record for ${id}`);
        }

        console.log(`[spawn] Successfully created and fetched arm record for ${id}`);
      } catch (err) {
        console.error(`[spawn] Failed to create arm record for ${id}:`, err);
        throw HttpError.internal(`Failed to create arm record for ${id}`);
      }
    }

    // Load config for defaults
    const config = await loadConfig();
    const defaults = config.defaults;

    // Use body > arm record > random preferred model > config defaults
    let provider = body.provider || row.provider;
    let model = body.model || row.model;
    
    // If no provider/model specified, try random preferred model
    if (!provider && !model) {
      const randomModel = getRandomPreferredModel();
      if (randomModel) {
        console.log(`[spawn] Selected random preferred model: ${randomModel.provider}/${randomModel.model}`);
        provider = randomModel.provider;
        model = randomModel.model;
      }
    }
    
    // Fall back to config defaults if still not set
    provider = provider || defaults.provider;
    model = model || defaults.model;
    const workdir = body.workdir || row.workdir || process.env.COLEO_REMOTE_WORKDIR || process.cwd();

    if (row.harness === "opencode-api" || row.harness === "opencode") {
      try {
        await refreshOpenCodeProvidersCache();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[spawn] Failed to refresh OpenCode provider cache: ${message}`);
      }
    }

    const systemPrompt = generateSystemPrompt({
      armId: id,
      name: row.name,
      harness: row.harness,
      workdir,
      provider,
      model,
    });
    const fullInitialPrompt = body.initialPrompt
      ? `${systemPrompt}\n\n---\n\n## Additional Instructions\n\n${body.initialPrompt}`
      : systemPrompt;

    // Hosted control runtimes can require every harness to execute on a remote
    // arm agent, including harnesses that normally support a local fallback.
    const remoteArmsOnly = process.env.COLEO_REMOTE_ARMS_ONLY === "1";
    const daemonManagedHarness = remoteArmsOnly || row.harness === "opencode-api" || row.harness === "opencode";
    const localFallbackEnabled =
      !remoteArmsOnly && (body.allowLocalFallback === true ||
      (body.allowLocalFallback !== false &&
        (process.env.COLEO_ALLOW_LOCAL_HARNESS_FALLBACK === "1" ||
          process.env.NODE_ENV === "test")));

    // Try distributed spawning via ArmClient if available
    const armClient = getArmClient();
    let runtimeSummary = deriveArmRuntime({
      status: row.status,
      pid: row.pid,
      port: row.port,
      sessionId: row.session_id,
      agentId: row.agent_id,
      workdir: row.workdir,
      currentTaskId: row.current_task_id,
      currentTaskSubject: row.current_task_subject,
      lastActivityAt: row.last_activity_at,
      lastHeartbeat: row.last_heartbeat,
      lastOutputAt: row.last_output_at,
    });

    if (body.recover) {
      if (daemonManagedHarness && armClient) {
        const distributedAgentId =
          body.agentId ||
          resolveDistributedAgentId(id, row.agent_id, {
            harness: row.harness,
            host: row.host,
          });

        if (distributedAgentId) {
          const refreshResult = await refreshDistributedRuntimeFromAgent(
            db,
            id,
            distributedAgentId,
            {
              status: row.status,
              pid: row.pid,
              port: row.port,
              sessionId: row.session_id,
              lastActivityAt: row.last_activity_at,
            },
          );

          runtimeSummary = deriveArmRuntime({
            status: refreshResult.snapshot.status,
            pid: refreshResult.snapshot.pid,
            port: refreshResult.snapshot.port,
            sessionId: refreshResult.snapshot.sessionId,
            agentId: distributedAgentId,
            workdir,
            currentTaskId: row.current_task_id,
            currentTaskSubject: row.current_task_subject,
            lastActivityAt: refreshResult.snapshot.lastActivityAt,
            lastHeartbeat: refreshResult.confirmed ? new Date().toISOString() : row.last_heartbeat,
            lastOutputAt: row.last_output_at,
          });

          if (runtimeSummary.state !== "hung" && isDistributedRuntimeReattachable(refreshResult)) {
            const agentHost = armClient.getAgent(distributedAgentId)?.hostname || row.host || hostname();
            const now = new Date().toISOString();
            db.run(
              "UPDATE arms SET status = ?, pid = ?, port = ?, session_id = ?, last_activity_at = COALESCE(?, last_activity_at), agent_id = ?, host = ?, provider = ?, model = ?, workdir = COALESCE(?, workdir), last_heartbeat = ?, updated_at = ? WHERE id = ?",
              [
                refreshResult.snapshot.status,
                refreshResult.snapshot.pid,
                refreshResult.snapshot.port,
                refreshResult.snapshot.sessionId,
                refreshResult.snapshot.lastActivityAt,
                distributedAgentId,
                agentHost,
                provider,
                model,
                workdir,
                now,
                now,
                id,
              ],
            );

            logActivity(db, id, "recovered", undefined, {
              distributed: true,
              recoveryMode: "reattached",
              agentId: distributedAgentId,
              host: agentHost,
              pid: refreshResult.snapshot.pid,
              port: refreshResult.snapshot.port,
              sessionId: refreshResult.snapshot.sessionId,
            });

            broadcast("arms", "arm.spawned", {
              id,
              recovered: true,
              recoveryMode: "reattached",
              distributed: true,
              agentId: distributedAgentId,
              host: agentHost,
              pid: refreshResult.snapshot.pid,
              port: refreshResult.snapshot.port,
              sessionId: refreshResult.snapshot.sessionId,
              status: refreshResult.snapshot.status,
            });

            return c.json({
              spawned: true,
              recovered: true,
              recoveryMode: "reattached",
              distributed: true,
              agentId: distributedAgentId,
              host: agentHost,
              pid: refreshResult.snapshot.pid,
              port: refreshResult.snapshot.port,
              sessionId: refreshResult.snapshot.sessionId,
              provider,
              model,
            });
          }

          if (runtimeSummary.state === "hung") {
            await armClient.killArm(id).catch(() => undefined);
            const now = new Date().toISOString();
            db.run(
              "UPDATE arms SET status = 'stopped', pid = NULL, port = NULL, session_id = NULL, agent_id = ?, host = COALESCE(?, host), updated_at = ? WHERE id = ?",
              [distributedAgentId, row.host, now, id],
            );
          }
        }
      } else {
        const manager = getGlobalHarnessManager();
        if (!manager) {
          throw HttpError.internal("Harness manager not initialized");
        }

        if (manager.hasSession(id) && runtimeSummary.state !== "hung") {
          const session = manager.getSession(id);
          const pid = manager.getPid(id);
          const port = manager.getPort(id);
          const now = new Date().toISOString();
          db.run(
            "UPDATE arms SET status = ?, pid = ?, port = ?, session_id = ?, provider = ?, model = ?, workdir = COALESCE(?, workdir), last_heartbeat = ?, updated_at = ? WHERE id = ?",
            [
              row.status === "error" || row.status === "stopped" ? "idle" : row.status,
              pid ?? null,
              port ?? null,
              session?.session.id ?? null,
              provider,
              model,
              workdir,
              now,
              now,
              id,
            ],
          );

          logActivity(db, id, "recovered", undefined, {
            distributed: false,
            recoveryMode: "reattached",
            pid,
            port,
            sessionId: session?.session.id,
          });

          return c.json({
            spawned: true,
            recovered: true,
            recoveryMode: "reattached",
            distributed: false,
            sessionId: session?.session.id,
            pid,
            port,
            provider,
            model,
          });
        }

        if (manager.hasSession(id) && runtimeSummary.state === "hung") {
          await manager.kill(id).catch(() => undefined);
        } else if (
          runtimeSummary.state !== "hung" &&
          row.port &&
          row.pid &&
          (row.harness === "opencode-api" || row.harness === "opencode-tui")
        ) {
          const recovered = await manager.recover(id, row.harness, row.port, row.pid);
          if (recovered) {
            const now = new Date().toISOString();
            const recoveredSessionId = manager.getSession(id)?.session.id ?? null;
            db.run(
              "UPDATE arms SET status = 'idle', session_id = ?, provider = ?, model = ?, workdir = COALESCE(?, workdir), last_heartbeat = ?, updated_at = ? WHERE id = ?",
              [recoveredSessionId, provider, model, workdir, now, now, id],
            );

            logActivity(db, id, "recovered", undefined, {
              distributed: false,
              recoveryMode: "recovered",
              pid: row.pid,
              port: row.port,
              sessionId: recoveredSessionId,
            });

            broadcast("arms", "arm.spawned", {
              id,
              recovered: true,
              recoveryMode: "recovered",
              pid: row.pid,
              port: row.port,
              status: "idle",
              distributed: false,
            });

            return c.json({
              spawned: true,
              recovered: true,
              recoveryMode: "recovered",
              distributed: false,
              sessionId: recoveredSessionId ?? undefined,
              pid: row.pid,
              port: row.port,
              provider,
              model,
            });
          }
        }
      }
    }

    if (armClient && daemonManagedHarness && !localFallbackEnabled) {
      await ensureDaemonAgentAvailable(armClient, row.harness);
    }

    if (armClient) {
      const persistDistributedSpawn = (
        agentId: string,
        agentHost: string,
        response: Awaited<ReturnType<typeof armClient.spawnArm>>,
      ) => {
        const now = new Date().toISOString();
        db.run(
          "UPDATE arms SET status = 'idle', agent_id = ?, host = ?, pid = ?, port = ?, session_id = ?, provider = ?, model = ?, workdir = ?, last_heartbeat = ?, updated_at = ? WHERE id = ?",
          [agentId, agentHost, response.data?.pid ?? null, response.data?.port ?? null, response.data?.sessionId ?? null, provider, model, workdir, now, now, id],
        );

        logActivity(db, id, "spawned", undefined, {
          agentId,
          host: agentHost,
          pid: response.data?.pid,
          port: response.data?.port,
          provider,
          model,
          distributed: true,
        });

        broadcast("arms", "arm.spawned", {
          id,
          agentId,
          host: agentHost,
          pid: response.data?.pid,
          port: response.data?.port,
          sessionId: response.data?.sessionId,
          status: "idle",
          distributed: true,
        });

        return c.json({
          spawned: true,
          distributed: true,
          agentId,
          host: agentHost,
          pid: response.data?.pid,
          port: response.data?.port,
          sessionId: response.data?.sessionId,
          provider,
          model,
        });
      };

      const spawnOnAgent = async (agentId: string) => {
        const agent = armClient.getAgent(agentId);
        const agentHost = agent?.hostname || row.host || hostname();
        const response = await armClient.spawnArm(agentId, id, {
          name: row.name,
          domain: row.domain,
          harness: row.harness,
          provider,
          model,
          contextBudget: row.context_budget,
          workDir: workdir,
          initialPrompt: fullInitialPrompt,
        });

        if (!response.success) {
          throw new Error(response.error || "Agent spawn failed");
        }

        return { agentHost, response };
      };

      const isAgentReachable = async (agentId: string): Promise<boolean> => {
        try {
          const probe = await armClient.listArmsOnAgent(agentId, 2000);
          return probe.success;
        } catch {
          return false;
        }
      };

      const shouldUseAgent = daemonManagedHarness || body.preferAgent || !!body.agentId;

      if (shouldUseAgent) {
        // Find an agent to spawn on
        let agentId = body.agentId;

        if (!agentId) {
          // Find the best available agent for this harness
          const bestAgent = armClient.findBestAgent(row.harness);
          if (bestAgent) {
            agentId = bestAgent.agentId;
          } else if (daemonManagedHarness) {
            // Fallback to the known local daemon agent ID only if it is reachable.
            const localDaemonKnown = !!armClient.getAgent(AUTO_AGENT_ID);
            if (localDaemonKnown) {
              agentId = AUTO_AGENT_ID;
            } else {
              try {
                const probe = await armClient.listArmsOnAgent(AUTO_AGENT_ID, 2000);
                if (probe.success) {
                  agentId = AUTO_AGENT_ID;
                }
              } catch {
                // No reachable local daemon yet.
              }
            }
          }
        }

        if (agentId || body.preferAgent) {
          if (!agentId) {
            throw HttpError.badRequest(`No agent available for harness: ${row.harness}`);
          }

          // Spawn via agent
          try {
            const { agentHost, response } = await spawnOnAgent(agentId);
            return persistDistributedSpawn(agentId, agentHost, response);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            const retryableDistributedFailure =
              daemonManagedHarness && !(await isAgentReachable(agentId));

            if (retryableDistributedFailure) {
              console.warn(
                `[spawn] Agent ${agentId} became unreachable while spawning ${id}; evicting and retrying once`,
              );
              armClient.markAgentUnavailable(agentId);

              try {
                await ensureDaemonAgentAvailable(armClient, row.harness);
              } catch {
                // Fall through to the regular error handling below.
              }

              let retryAgentId = body.agentId;
              if (!retryAgentId) {
                const retryAgent = armClient.findBestAgent(row.harness);
                retryAgentId = retryAgent?.agentId;
              }

              if (retryAgentId) {
                try {
                  const { agentHost, response } = await spawnOnAgent(retryAgentId);
                  return persistDistributedSpawn(retryAgentId, agentHost, response);
                } catch (retryErr) {
                  const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
                  console.warn(
                    `[spawn] Retry after evicting agent ${agentId} failed for ${id}: ${retryMessage}`,
                  );
                }
              }
            }

            // If this harness should be daemon-managed, fail by default unless explicitly overridden
            if (daemonManagedHarness && !localFallbackEnabled) {
              throw HttpError.internal(`Failed to spawn ${row.harness} arm on daemon agent: ${message}`);
            }
            // If explicitly requested agent spawn, fail
            if (body.preferAgent || body.agentId) {
              throw HttpError.internal(`Failed to spawn arm on agent: ${message}`);
            }
            // Otherwise fall back to local spawn
            console.log(`[spawn] Agent spawn failed, falling back to local: ${message}`);
          }
        }
      }
    }

    if (daemonManagedHarness && !localFallbackEnabled) {
      if (!armClient) {
        throw HttpError.internal(
          `Harness '${row.harness}' requires the arm agent daemon. Distributed arm management is unavailable.`,
        );
      }
      throw HttpError.badRequest(
        `No agent available for harness '${row.harness}'. Start an arm agent daemon with 'coleo agent start'.`,
      );
    }

    // Fall back to local harness spawning
    const manager = getGlobalHarnessManager();
    if (!manager) {
      throw HttpError.internal("Harness manager not initialized");
    }

    // Check if already running in the harness manager
    if (manager.hasSession(id)) {
      throw HttpError.badRequest(`Arm ${id} is already running`);
    }

    try {
      // Spawn via harness
      const session = await manager.spawn(id, row.harness, {
        workdir,
        provider,
        model,
        initialPrompt: fullInitialPrompt,
      });

      // Update database
      const now = new Date().toISOString();
      const pid = manager.getPid(id);
      const port = manager.getPort(id);
      db.run(
        "UPDATE arms SET status = 'idle', pid = ?, port = ?, session_id = ?, agent_id = NULL, host = NULL, provider = ?, model = ?, workdir = ?, last_heartbeat = ?, updated_at = ? WHERE id = ?",
        [pid ?? null, port ?? null, session.session.id, provider, model, workdir, now, now, id]
      );

      // Log activity
      logActivity(db, id, "spawned", undefined, { pid: pid ?? undefined, port: port ?? undefined, workdir, provider, model, distributed: false });

      // Broadcast arm spawned
      broadcast("arms", "arm.spawned", { id, sessionId: session.session.id, pid, port, status: "idle", distributed: false });

      return c.json({
        spawned: true,
        distributed: false,
        sessionId: session.session.id,
        pid,
        port,
        provider,
        model,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw HttpError.internal(`Failed to spawn arm: ${message}`);
    }
  });

  app.post("/:id/recover", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const body = await c.req.json<{
      workdir?: string;
      provider?: string;
      model?: string;
      agentId?: string;
      allowLocalFallback?: boolean;
    }>().catch(() => ({} as {
      workdir?: string;
      provider?: string;
      model?: string;
      agentId?: string;
      allowLocalFallback?: boolean;
    }));

    const row = db.query(
      "SELECT id, name, domain, harness, status, provider, model, port, pid, session_id, agent_id, host, context_budget, workdir, last_activity_at, last_heartbeat, last_output_at, current_task_id, current_task_subject FROM arms WHERE id = ?",
    ).get(id) as {
      id: string;
      name: string;
      domain: string;
      harness: string;
      status: string;
      provider: string | null;
      model: string | null;
      port: number | null;
      pid: number | null;
      session_id: string | null;
      agent_id: string | null;
      host: string | null;
      context_budget: number;
      workdir: string | null;
      last_activity_at: string | null;
      last_heartbeat: string | null;
      last_output_at: string | null;
      current_task_id: string | null;
      current_task_subject: string | null;
    } | null;

    if (!row) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    const config = await loadConfig();
    const provider = body.provider || row.provider || config.defaults.provider;
    const model = body.model || row.model || config.defaults.model;
    const workdir = body.workdir || row.workdir || process.env.COLEO_REMOTE_WORKDIR || process.cwd();
    const remoteArmsOnly = process.env.COLEO_REMOTE_ARMS_ONLY === "1";
    const daemonManagedHarness = remoteArmsOnly || row.harness === "opencode-api" || row.harness === "opencode";
    const localFallbackEnabled =
      !remoteArmsOnly && (body.allowLocalFallback === true ||
      (body.allowLocalFallback !== false &&
        (process.env.COLEO_ALLOW_LOCAL_HARNESS_FALLBACK === "1" ||
          process.env.NODE_ENV === "test")));

    let runtimeSummary = deriveArmRuntime({
      status: row.status,
      pid: row.pid,
      port: row.port,
      sessionId: row.session_id,
      agentId: row.agent_id,
      workdir: row.workdir,
      currentTaskId: row.current_task_id,
      currentTaskSubject: row.current_task_subject,
      lastActivityAt: row.last_activity_at,
      lastHeartbeat: row.last_heartbeat,
      lastOutputAt: row.last_output_at,
    });

    const armClient = getArmClient();
    if (daemonManagedHarness && armClient) {
      if (!localFallbackEnabled) {
        await ensureDaemonAgentAvailable(armClient, row.harness);
      }

      const distributedAgentId =
        body.agentId ||
        resolveDistributedAgentId(id, row.agent_id, {
          harness: row.harness,
          host: row.host,
        });

      if (distributedAgentId) {
        const refreshResult = await refreshDistributedRuntimeFromAgent(
          db,
          id,
          distributedAgentId,
          {
            status: row.status,
            pid: row.pid,
            port: row.port,
            sessionId: row.session_id,
            lastActivityAt: row.last_activity_at,
          },
        );

        runtimeSummary = deriveArmRuntime({
          status: refreshResult.snapshot.status,
          pid: refreshResult.snapshot.pid,
          port: refreshResult.snapshot.port,
          sessionId: refreshResult.snapshot.sessionId,
          agentId: distributedAgentId,
          workdir,
          currentTaskId: row.current_task_id,
          currentTaskSubject: row.current_task_subject,
          lastActivityAt: refreshResult.snapshot.lastActivityAt,
          lastHeartbeat: refreshResult.confirmed ? new Date().toISOString() : row.last_heartbeat,
          lastOutputAt: row.last_output_at,
        });

        if (runtimeSummary.state !== "hung" && isDistributedRuntimeReattachable(refreshResult)) {
          const agentHost = armClient.getAgent(distributedAgentId)?.hostname || row.host || hostname();
          const now = new Date().toISOString();
          db.run(
            "UPDATE arms SET status = ?, pid = ?, port = ?, session_id = ?, last_activity_at = COALESCE(?, last_activity_at), agent_id = ?, host = ?, provider = ?, model = ?, workdir = COALESCE(?, workdir), last_heartbeat = ?, updated_at = ? WHERE id = ?",
            [
              refreshResult.snapshot.status,
              refreshResult.snapshot.pid,
              refreshResult.snapshot.port,
              refreshResult.snapshot.sessionId,
              refreshResult.snapshot.lastActivityAt,
              distributedAgentId,
              agentHost,
              provider,
              model,
              workdir,
              now,
              now,
              id,
            ],
          );

          logActivity(db, id, "recovered", undefined, {
            distributed: true,
            recoveryMode: "reattached",
            agentId: distributedAgentId,
            host: agentHost,
            pid: refreshResult.snapshot.pid,
            port: refreshResult.snapshot.port,
            sessionId: refreshResult.snapshot.sessionId,
          });

          broadcast("arms", "arm.spawned", {
            id,
            recovered: true,
            recoveryMode: "reattached",
            distributed: true,
            agentId: distributedAgentId,
            host: agentHost,
            pid: refreshResult.snapshot.pid,
            port: refreshResult.snapshot.port,
            sessionId: refreshResult.snapshot.sessionId,
            status: refreshResult.snapshot.status,
          });

          return c.json({
            spawned: true,
            recovered: true,
            recoveryMode: "reattached",
            distributed: true,
            agentId: distributedAgentId,
            host: agentHost,
            pid: refreshResult.snapshot.pid,
            port: refreshResult.snapshot.port,
            sessionId: refreshResult.snapshot.sessionId,
            provider,
            model,
          });
        }

        if (runtimeSummary.state === "hung") {
          await armClient.killArm(id).catch(() => undefined);
        }

        const restartAgentId = findReachableAgentForHarness(row.harness, {
          preferredAgentId: body.agentId || distributedAgentId,
          preferredHost: row.host,
        });
        if (restartAgentId) {
          const agent = armClient.getAgent(restartAgentId);
          const response = await armClient.spawnArm(restartAgentId, id, {
            name: row.name,
            domain: row.domain,
            harness: row.harness,
            provider,
            model,
            contextBudget: row.context_budget,
            workDir: workdir,
          });

          if (!response.success) {
            throw HttpError.internal(response.error || "Failed to restart arm on agent");
          }

          const now = new Date().toISOString();
          db.run(
            "UPDATE arms SET status = 'idle', agent_id = ?, host = ?, pid = ?, port = ?, session_id = ?, provider = ?, model = ?, workdir = ?, last_heartbeat = ?, updated_at = ? WHERE id = ?",
            [restartAgentId, agent?.hostname || row.host || hostname(), response.data?.pid ?? null, response.data?.port ?? null, response.data?.sessionId ?? null, provider, model, workdir, now, now, id],
          );

          logActivity(db, id, "recovered", undefined, {
            distributed: true,
            recoveryMode: "restarted",
            agentId: restartAgentId,
            host: agent?.hostname || row.host || hostname(),
            pid: response.data?.pid,
            port: response.data?.port,
            sessionId: response.data?.sessionId,
          });

          broadcast("arms", "arm.spawned", {
            id,
            recovered: true,
            recoveryMode: "restarted",
            distributed: true,
            agentId: restartAgentId,
            host: agent?.hostname || row.host || hostname(),
            pid: response.data?.pid,
            port: response.data?.port,
            sessionId: response.data?.sessionId,
            status: "idle",
          });

          return c.json({
            spawned: true,
            recovered: true,
            recoveryMode: "restarted",
            distributed: true,
            agentId: restartAgentId,
            host: agent?.hostname || row.host || hostname(),
            pid: response.data?.pid,
            port: response.data?.port,
            sessionId: response.data?.sessionId,
            provider,
            model,
          });
        }
      }

      if (!localFallbackEnabled) {
        throw HttpError.internal(
          `Harness '${row.harness}' requires the arm agent daemon. Distributed arm management is unavailable.`,
        );
      }
    }

    const manager = getGlobalHarnessManager();
    if (!manager) {
      throw HttpError.internal("Harness manager not initialized");
    }

    if (manager.hasSession(id) && runtimeSummary.state !== "hung") {
      const session = manager.getSession(id);
      const pid = manager.getPid(id);
      const port = manager.getPort(id);
      const now = new Date().toISOString();
      db.run(
        "UPDATE arms SET status = ?, pid = ?, port = ?, session_id = ?, agent_id = NULL, host = NULL, provider = ?, model = ?, workdir = COALESCE(?, workdir), last_heartbeat = ?, updated_at = ? WHERE id = ?",
        [
          row.status === "error" || row.status === "stopped" ? "idle" : row.status,
          pid ?? null,
          port ?? null,
          session?.session.id ?? null,
          provider,
          model,
          workdir,
          now,
          now,
          id,
        ],
      );

      logActivity(db, id, "recovered", undefined, {
        distributed: false,
        recoveryMode: "reattached",
        pid,
        port,
        sessionId: session?.session.id,
      });

      return c.json({
        spawned: true,
        recovered: true,
        recoveryMode: "reattached",
        distributed: false,
        sessionId: session?.session.id,
        pid,
        port,
        provider,
        model,
      });
    }

    if (manager.hasSession(id)) {
      await manager.kill(id).catch(() => undefined);
    } else if (
      runtimeSummary.state !== "hung" &&
      row.port &&
      row.pid &&
      (row.harness === "opencode-api" || row.harness === "opencode-tui")
    ) {
      const recovered = await manager.recover(id, row.harness, row.port, row.pid);
      if (recovered) {
        const now = new Date().toISOString();
        const recoveredSessionId = manager.getSession(id)?.session.id ?? null;
        db.run(
          "UPDATE arms SET status = 'idle', session_id = ?, provider = ?, model = ?, workdir = COALESCE(?, workdir), last_heartbeat = ?, updated_at = ? WHERE id = ?",
          [recoveredSessionId, provider, model, workdir, now, now, id],
        );

        logActivity(db, id, "recovered", undefined, {
          distributed: false,
          recoveryMode: "recovered",
          pid: row.pid,
          port: row.port,
          sessionId: recoveredSessionId,
        });

        return c.json({
          spawned: true,
          recovered: true,
          recoveryMode: "recovered",
          distributed: false,
          sessionId: recoveredSessionId,
          pid: row.pid,
          port: row.port,
          provider,
          model,
        });
      }
    }

    const systemPrompt = generateSystemPrompt({
      armId: id,
      name: row.name,
      harness: row.harness,
      workdir,
      provider,
      model,
    });
    const session = await manager.spawn(id, row.harness, {
      workdir,
      provider,
      model,
      initialPrompt: systemPrompt,
    });

    const now = new Date().toISOString();
    const pid = manager.getPid(id);
    const port = manager.getPort(id);
    db.run(
      "UPDATE arms SET status = 'idle', pid = ?, port = ?, session_id = ?, agent_id = NULL, host = NULL, provider = ?, model = ?, workdir = ?, last_heartbeat = ?, updated_at = ? WHERE id = ?",
      [pid ?? null, port ?? null, session.session.id, provider, model, workdir, now, now, id],
    );

    logActivity(db, id, "recovered", undefined, {
      distributed: false,
      recoveryMode: "restarted",
      pid,
      port,
      sessionId: session.session.id,
    });

    return c.json({
      spawned: true,
      recovered: true,
      recoveryMode: "restarted",
      distributed: false,
      sessionId: session.session.id,
      pid,
      port,
      provider,
      model,
    });
  });

  /**
   * Kill an arm's harness session (local or distributed)
   * POST /api/arms/:id/kill
   */
  app.post("/:id/kill", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    // Check if arm exists and get agent info
    const row = db.query("SELECT id, agent_id FROM arms WHERE id = ?").get(id) as { id: string; agent_id: string | null } | null;
    if (!row) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    // If arm is on an agent, kill via ArmClient
    if (row.agent_id) {
      const armClient = getArmClient();
      if (armClient) {
        try {
          const response = await armClient.killArm(id);
          if (!response.success) {
            throw new Error(response.error || "Agent kill failed");
          }
          
          // Update database
          const now = new Date().toISOString();
          db.run("UPDATE arms SET status = 'stopped', pid = NULL, port = NULL, session_id = NULL, agent_id = NULL, host = NULL, updated_at = ? WHERE id = ?", [now, id]);
          const releasedClaims = releaseClaimsForArm(db, id, now);

          // Log activity
          logActivity(db, id, "killed", undefined, { distributed: true, agentId: row.agent_id, releasedClaims });

          // Broadcast arm killed
          broadcast("arms", "arm.killed", { id, status: "stopped", distributed: true });

          return c.json({ killed: true, distributed: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Still try to clean up DB state even if agent kill fails
          const now = new Date().toISOString();
          db.run("UPDATE arms SET status = 'stopped', pid = NULL, port = NULL, session_id = NULL, agent_id = NULL, host = NULL, updated_at = ? WHERE id = ?", [now, id]);
          releaseClaimsForArm(db, id, now);
          console.log(`[kill] Agent kill failed, cleaned up DB state: ${message}`);
        }
      }
    }

    // Kill via local harness manager
    const manager = getGlobalHarnessManager();
    if (!manager) {
      throw HttpError.internal("Harness manager not initialized");
    }

    // Kill the session
    await manager.kill(id);

    // Update database
    const now = new Date().toISOString();
    db.run("UPDATE arms SET status = 'stopped', pid = NULL, port = NULL, updated_at = ? WHERE id = ?", [now, id]);
    const releasedClaims = releaseClaimsForArm(db, id, now);

    // Log activity
    logActivity(db, id, "killed", undefined, { releasedClaims });

    // Broadcast arm killed
    broadcast("arms", "arm.killed", { id, status: "stopped" });

    return c.json({ killed: true });
  });

  /**
   * Pause an arm
   * POST /api/arms/:id/pause
   */
  app.post("/:id/pause", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    // Check if arm exists
    const row = db.query("SELECT id, status FROM arms WHERE id = ?").get(id) as { id: string; status: string } | null;
    if (!row) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    if (row.status === "paused") {
      throw HttpError.badRequest(`Arm ${id} is already paused`);
    }

    if (row.status === "stopped") {
      throw HttpError.badRequest(`Cannot pause a stopped arm`);
    }

    // Update database
    const now = new Date().toISOString();
    db.run("UPDATE arms SET status = 'paused', updated_at = ? WHERE id = ?", [now, id]);

    // Log activity
    logActivity(db, id, "paused");

    // Broadcast arm paused
    broadcast("arms", "arm.paused", { id, status: "paused" });

    return c.json({ paused: true, status: "paused" });
  });

  /**
   * Resume a paused arm
   * POST /api/arms/:id/resume
   */
  app.post("/:id/resume", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    // Check if arm exists
    const row = db.query("SELECT id, status FROM arms WHERE id = ?").get(id) as { id: string; status: string } | null;
    if (!row) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    if (row.status !== "paused") {
      throw HttpError.badRequest(`Arm ${id} is not paused (current status: ${row.status})`);
    }

    // Update database
    const now = new Date().toISOString();
    db.run("UPDATE arms SET status = 'idle', updated_at = ? WHERE id = ?", [now, id]);

    // Log activity
    logActivity(db, id, "resumed");

    // Broadcast arm resumed
    broadcast("arms", "arm.resumed", { id, status: "idle" });

    return c.json({ resumed: true, status: "idle" });
  });

  /**
   * Update arm metrics (tokens, cost, current task)
   * POST /api/arms/:id/metrics
   */
  app.post("/:id/metrics", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    const body = await c.req.json<{
      tokens?: { input?: number; output?: number };
      cost?: number;
      currentTask?: { id: string; subject: string } | null;
      currentBug?: { id: string; title: string } | null;
    }>();

    // Check if arm exists
    const row = db.query("SELECT id FROM arms WHERE id = ?").get(id) as { id: string } | null;
    if (!row) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    const now = new Date().toISOString();
    const updates: string[] = ["updated_at = ?"];
    const params: (string | number | null)[] = [now];

    if (body.tokens) {
      const currentTokens = db.query("SELECT total_tokens FROM arms WHERE id = ?").get(id) as { total_tokens: number } | null;
      const inputDelta = body.tokens.input || 0;
      const outputDelta = body.tokens.output || 0;
      const newTotal = (currentTokens?.total_tokens || 0) + inputDelta + outputDelta;
      updates.push("total_tokens = ?");
      params.push(newTotal);
    }

    if (body.cost !== undefined) {
      const currentCost = db.query("SELECT total_cost FROM arms WHERE id = ?").get(id) as { total_cost: number } | null;
      const newCost = (currentCost?.total_cost || 0) + body.cost;
      updates.push("total_cost = ?");
      params.push(newCost);
    }

    if (body.currentTask !== undefined) {
      updates.push("current_task_id = ?");
      params.push(body.currentTask?.id || null);
      updates.push("current_task_subject = ?");
      params.push(body.currentTask?.subject || null);
    }

    if (body.currentBug !== undefined) {
      updates.push("current_bug_id = ?");
      params.push(body.currentBug?.id || null);
      updates.push("current_bug_title = ?");
      params.push(body.currentBug?.title || null);
    }

    params.push(id);
    db.run(`UPDATE arms SET ${updates.join(", ")} WHERE id = ?`, params);
    recordMetricSnapshot(db, id, now);

    return c.json({ success: true });
  });

  /**
   * Get the current arm metrics used by summary and sparkline views.
   * GET /api/arms/:id/metrics
   */
  app.get("/:id/metrics", (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const arm = db.query(
      `SELECT id, status, current_context_used as contextUsed, context_budget as contextBudget,
              total_tokens as totalTokens, total_cost as totalCost, updated_at as updatedAt
       FROM arms WHERE id = ?`,
    ).get(id) as {
      id: string;
      status: string;
      contextUsed: number;
      contextBudget: number;
      totalTokens: number | null;
      totalCost: number | null;
      updatedAt: string;
    } | null;
    if (!arm) throw HttpError.notFound(`Arm not found: ${id}`);

    return c.json({
      armId: arm.id,
      status: arm.status,
      timestamp: arm.updatedAt,
      context: {
        used: arm.contextUsed,
        budget: arm.contextBudget,
        utilization: arm.contextBudget > 0 ? arm.contextUsed / arm.contextBudget : 0,
      },
      tokens: arm.totalTokens ?? 0,
      cost: arm.totalCost ?? 0,
    });
  });

  /**
   * Get bounded context samples captured while the arm is active.
   * GET /api/arms/:id/context-history
   */
  app.get("/:id/context-history", (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const requestedWindowMs = Number.parseInt(c.req.query("windowMs") || "1800000", 10);
    const windowMs = Number.isFinite(requestedWindowMs)
      ? Math.min(Math.max(requestedWindowMs, 60_000), 24 * 60 * 60 * 1000)
      : 30 * 60 * 1000;
    const since = new Date(Date.now() - windowMs).toISOString();
    const arm = db.query(
      "SELECT current_context_used as used, context_budget as budget, updated_at as updatedAt FROM arms WHERE id = ?",
    ).get(id) as { used: number; budget: number; updatedAt: string } | null;
    if (!arm) throw HttpError.notFound(`Arm not found: ${id}`);

    let samples: Array<{ timestamp: string; used: number; budget: number }> = [];
    try {
      samples = db.query(
        `SELECT timestamp, context_used as used, context_budget as budget
         FROM arm_metric_history WHERE arm_id = ? AND timestamp >= ? ORDER BY timestamp`,
      ).all(id, since) as typeof samples;
    } catch {
      // The current reading is still useful during a rolling migration.
    }
    if (samples.length === 0) samples = [{ timestamp: arm.updatedAt, used: arm.used, budget: arm.budget }];

    return c.json({ armId: id, windowMs, samples });
  });

  /**
   * Get bounded cumulative cost samples captured while the arm is active.
   * GET /api/arms/:id/cost-history
   */
  app.get("/:id/cost-history", (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const requestedWindowMs = Number.parseInt(c.req.query("windowMs") || "1800000", 10);
    const windowMs = Number.isFinite(requestedWindowMs)
      ? Math.min(Math.max(requestedWindowMs, 60_000), 24 * 60 * 60 * 1000)
      : 30 * 60 * 1000;
    const since = new Date(Date.now() - windowMs).toISOString();
    const arm = db.query(
      "SELECT total_cost as cost, total_tokens as tokens, updated_at as updatedAt FROM arms WHERE id = ?",
    ).get(id) as { cost: number | null; tokens: number | null; updatedAt: string } | null;
    if (!arm) throw HttpError.notFound(`Arm not found: ${id}`);

    let samples: Array<{ timestamp: string; cost: number; tokens: number }> = [];
    try {
      samples = db.query(
        `SELECT timestamp, total_cost as cost, total_tokens as tokens
         FROM arm_metric_history WHERE arm_id = ? AND timestamp >= ? ORDER BY timestamp`,
      ).all(id, since) as typeof samples;
    } catch {
      // The current reading is still useful during a rolling migration.
    }
    if (samples.length === 0) {
      samples = [{ timestamp: arm.updatedAt, cost: arm.cost ?? 0, tokens: arm.tokens ?? 0 }];
    }

    return c.json({ armId: id, windowMs, samples });
  });

  /**
   * Get arm's harness state (for brain to check arm status)
   * GET /api/arms/:id/state
   */
  app.get("/:id/state", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    // Check if arm exists
    const row = db.query(
      "SELECT id, status, pid, port, session_id, agent_id, harness, host FROM arms WHERE id = ?",
    ).get(id) as {
      id: string;
      status: string;
      pid: number | null;
      port: number | null;
      session_id: string | null;
      agent_id: string | null;
      harness: string | null;
      host: string | null;
    } | null;
    if (!row) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    const distributedAgentId = resolveDistributedAgentId(id, row.agent_id, {
      harness: row.harness,
      host: row.host,
    });
    if (distributedAgentId) {
      const { snapshot } = await refreshDistributedRuntimeFromAgent(
        db,
        id,
        distributedAgentId,
        {
          status: row.status,
          pid: row.pid,
          port: row.port,
          sessionId: row.session_id,
          lastActivityAt: null,
        },
      );
      const hasSession = !!(snapshot.sessionId || snapshot.port);

      return c.json({
        state: mapDistributedStatusToHarnessState(snapshot.status),
        hasSession,
        distributed: true,
        agentId: distributedAgentId,
      });
    }

    // Get the harness manager to check session state
    const manager = getGlobalHarnessManager();
    if (!manager) {
      return c.json({ state: "unknown", hasSession: false });
    }

    const hasSession = manager.hasSession(id);
    let state = "stopped";

    if (hasSession) {
      try {
        state = await manager.getState(id);
      } catch {
        // If we can't get state, report as unknown
        state = "unknown";
      }
    }

    return c.json({ state, hasSession });
  });

  /**
   * Reset arm's OpenCode session to clear stale context
   * POST /api/arms/:id/reset-session
   * 
   * Used by the brain after task completion to ensure the arm gets
   * fresh context for the next task assignment. This prevents stale
   * task IDs from previous sessions causing foreign key errors.
   */
  app.post("/:id/reset-session", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    // Check if arm exists
    const row = db.query("SELECT id, name FROM arms WHERE id = ?").get(id) as { id: string; name: string } | null;
    if (!row) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    // Get the harness manager
    const manager = getGlobalHarnessManager();
    if (!manager) {
      throw HttpError.internal("Harness manager not available");
    }

    if (!manager.hasSession(id)) {
      throw HttpError.badRequest(`Arm ${id} has no active session to reset`);
    }

    // Reset the session
    const newSessionId = await manager.resetSession(id);
    
    if (!newSessionId) {
      throw HttpError.internal(`Failed to reset session for arm ${id}`);
    }

    // Log the activity
    logActivity(db, id, "session_reset", undefined, { newSessionId });

    return c.json({ 
      success: true, 
      armId: id,
      newSessionId,
      message: `Session reset for arm ${row.name}. Fresh context ready for new task.`
    });
  });

  /**
   * Get arm's current context (files, tokens)
   * GET /api/arms/:id/context
   */
  app.get("/:id/context", (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    const row = db.query(`
      SELECT 
        id, 
        context_budget as contextBudget,
        current_context_used as currentContextUsed
      FROM arms
      WHERE id = ?
    `).get(id) as { id: string; contextBudget: number; currentContextUsed: number } | null;

    if (!row) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    // Get file claims for this arm
    let files: Array<{ path: string; claimedAt: string }> = [];
    try {
      const claims = db.query(`
        SELECT file_path as path, claimed_at as claimedAt
        FROM claims
        WHERE arm_id = ?
        ORDER BY claimed_at DESC
      `).all(id) as Array<{ path: string; claimedAt: string }>;
      files = claims;
    } catch {
      // Claims table may not exist yet
    }

    return c.json({
      context: {
        budget: row.contextBudget,
        used: row.currentContextUsed,
        utilization: row.contextBudget > 0 ? row.currentContextUsed / row.contextBudget : 0,
        files,
      },
    });
  });

  /**
   * Get arm's session messages (text logs for viewer)
   * GET /api/arms/:id/messages
   */
  app.get("/:id/messages", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const parsedLimit = Number.parseInt(c.req.query("limit") || "50", 10);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 200) : 50;

    const row = db.query("SELECT id, status, pid, port, session_id, agent_id, harness, host FROM arms WHERE id = ?").get(id) as {
      id: string;
      status: string;
      pid: number | null;
      port: number | null;
      session_id: string | null;
      agent_id: string | null;
      harness: string | null;
      host: string | null;
    } | null;

    if (!row) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    const distributedAgentId = resolveDistributedAgentId(id, row.agent_id, {
      harness: row.harness,
      host: row.host,
    });
    if (row.status === "stopped" && !distributedAgentId) {
      return c.json({ messages: [], error: "Arm not running" });
    }

    if (distributedAgentId) {
      await refreshDistributedRuntimeFromAgent(
        db,
        id,
        distributedAgentId,
        {
          status: row.status,
          pid: null,
          port: row.port,
          sessionId: row.session_id,
          lastActivityAt: null,
        },
      );

      const armClient = getArmClient();
      if (!armClient) {
        return c.json({
          messages: [],
          sessionId: row.session_id,
          error: "Arm agent client not available",
        });
      }

      let response;
      try {
        response = await armClient.getMessages(id, { limit }, DISTRIBUTED_OBSERVABILITY_COMMAND_TIMEOUT_MS);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({
          messages: [],
          sessionId: row.session_id,
          error: `Distributed message fetch unavailable: ${message}`,
        });
      }

      if (!response.success) {
        return c.json({
          messages: [],
          sessionId: row.session_id,
          error: response.error || "Failed to fetch distributed messages",
        });
      }

      return c.json({
        messages: normalizeMessagesForCostChart(response.data?.messages),
        sessionId: response.data?.sessionId || row.session_id,
        distributed: true,
      });
    }

    const manager = getGlobalHarnessManager();
    if (!manager) {
      return c.json({
        messages: [],
        sessionId: row.session_id,
        error: "Harness manager not initialized",
      });
    }

    if (!manager.hasSession(id)) {
      if (
        (row.harness === "opencode-api" || row.harness === "opencode-tui") &&
        row.port !== null &&
        row.pid !== null
      ) {
        try {
          const recovered = await manager.recover(id, row.harness, row.port, row.pid);
          if (recovered) {
            const now = new Date().toISOString();
            const recoveredSessionId = manager.getSession(id)?.session.id ?? null;
            db.run(
              "UPDATE arms SET session_id = ?, last_heartbeat = ?, updated_at = ? WHERE id = ?",
              [recoveredSessionId, now, now, id],
            );
          }
        } catch (err) {
          console.warn(`[messages] Auto-recovery attempt failed for ${id}: ${err}`);
        }
      }
    }

    if (!manager.hasSession(id)) {
      return c.json({ messages: [], error: "Arm has no active harness session" });
    }

    try {
      const messages = await manager.getMessages(id, { limit });
      const sessionId = manager.getSession(id)?.session.id;

      return c.json({
        messages: normalizeMessagesForCostChart(messages),
        sessionId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const sessionId = manager.getSession(id)?.session.id;
      return c.json({
        messages: [],
        sessionId,
        error: `Failed to fetch messages: ${message}`,
      });
    }
  });

  /**
   * Get arm's activity log from JetStream
   * GET /api/arms/:id/activity
   */
  app.get("/:id/activity", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 100);

    // Check if arm exists
    const exists = db.query("SELECT id FROM arms WHERE id = ?").get(id);
    if (!exists) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    try {
      if (!eventStore.isInitialized()) {
        return c.json({
          activity: [],
          pagination: { limit, offset: 0, total: 0 },
          message: "JetStream not available",
        });
      }

      const events = await eventStore.getArmEvents(id, limit);
      
      const activity = events.map(event => ({
        timestamp: event.timestamp,
        actor: event.armId || (event.data.actor as string) || "unknown",
        action: event.type,
        target: event.armId,
        details: event.data,
      }));

      return c.json({
        activity,
        pagination: {
          limit,
          offset: 0,
          total: events.length, // JetStream doesn't provide easy total counts
        },
      });
    } catch {
      return c.json({
        activity: [],
        pagination: { limit, offset: 0, total: 0 },
      });
    }
  });

  /**
   * Get arm's todos via ArmAgent (distributed) or HarnessManager (local)
   * GET /api/arms/:id/todos
   */
  app.get("/:id/todos", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    // Get arm with port and session info
    const row = db.query("SELECT id, port, status, session_id, agent_id, harness, host FROM arms WHERE id = ?").get(id) as {
      id: string;
      port: number | null;
      status: string;
      session_id: string | null;
      agent_id: string | null;
      harness: string | null;
      host: string | null;
    } | null;

    if (!row) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    const distributedAgentId = resolveDistributedAgentId(id, row.agent_id, {
      harness: row.harness,
      host: row.host,
    });
    if (distributedAgentId) {
      await refreshDistributedRuntimeFromAgent(
        db,
        id,
        distributedAgentId,
        {
          status: row.status,
          pid: null,
          port: row.port,
          sessionId: row.session_id,
          lastActivityAt: null,
        },
      );

      const armClient = getArmClient();
      if (!armClient) {
        return c.json({ todos: [], message: "Arm agent client not available" });
      }

      let response;
      try {
        response = await armClient.getTodos(id, DISTRIBUTED_OBSERVABILITY_COMMAND_TIMEOUT_MS);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({
          todos: [],
          message: `Distributed todo fetch unavailable: ${message}`,
        });
      }

      if (!response.success) {
        return c.json({
          todos: [],
          message: response.error || "Failed to fetch distributed todos",
        });
      }

      return c.json({
        todos: response.data?.todos || [],
        distributed: true,
      });
    }

    if (row.status === "stopped") {
      return c.json({ todos: [], message: "Arm not running" });
    }

    const manager = getGlobalHarnessManager();
    if (!manager) {
      return c.json({ todos: [], message: "Harness manager not initialized" });
    }

    if (!manager.hasSession(id)) {
      return c.json({ todos: [], message: "Arm has no active harness session" });
    }

    try {
      const todos = await manager.getTodos(id);
      return c.json({ todos });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ todos: [], message: `Failed to fetch todos: ${message}` });
    }
  });

  /**
   * SSE stream for arm events from JetStream
   * GET /api/arms/:id/events
   */
  app.get("/:id/events", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");

    const exists = db.query("SELECT id FROM arms WHERE id = ?").get(id);
    if (!exists) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    if (!eventStore.isInitialized()) {
      return new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "error",
                  properties: { error: "JetStream not available" },
                })}\n\n`,
              ),
            );
            controller.close();
          },
        }),
        {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          },
        }
      );
    }

    let closed = false;
    let pollTimeout: ReturnType<typeof setTimeout> | null = null;
    let heartbeatHandle: ReturnType<typeof setInterval> | null = null;
    let closeStreamRef: (() => void) | null = null;
    const requestSignal = c.req.raw.signal;

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        let lastPollTime = new Date(Date.now() - 2_000);
        let lastSequence = 0;

        const writeChunk = (value: string): boolean => {
          if (closed) {
            return false;
          }

          try {
            controller.enqueue(encoder.encode(value));
            return true;
          } catch {
            closed = true;
            if (pollTimeout) {
              clearTimeout(pollTimeout);
              pollTimeout = null;
            }
            if (heartbeatHandle) {
              clearInterval(heartbeatHandle);
              heartbeatHandle = null;
            }
            return false;
          }
        };

        const writeEvent = (_eventName: string, data: unknown): boolean => {
          return writeChunk(`data: ${JSON.stringify(data)}\n\n`);
        };

        const poll = async (): Promise<void> => {
          if (closed) {
            return;
          }

          try {
            const pollUntil = new Date();
            const events = await eventStore.queryEvents({
              subject: `coleo.events.arm.${id}.>`,
              since: lastPollTime,
              until: pollUntil,
              limit: 100,
            });
            lastPollTime = pollUntil;

            events
              .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
              .forEach((event) => {
                if (typeof event.sequence === "number" && event.sequence <= lastSequence) {
                  return;
                }
                const written = writeEvent(event.type, {
                  type: event.type,
                  properties: event.data,
                  timestamp: event.timestamp,
                  armId: event.armId || id,
                  sequence: event.sequence,
                });
                if (written && typeof event.sequence === "number") {
                  lastSequence = event.sequence;
                }
              });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            writeEvent("error", { type: "error", properties: { error: message } });
          } finally {
            if (!closed) {
              pollTimeout = setTimeout(() => {
                void poll();
              }, 1000);
            }
          }
        };

        writeEvent("connected", { type: "connected", properties: { armId: id } });
        heartbeatHandle = setInterval(() => {
          writeChunk(`: keepalive ${Date.now()}\n\n`);
        }, 5000);
        void poll();

        const closeStream = (): void => {
          if (closed) {
            return;
          }
          closed = true;
          if (pollTimeout) {
            clearTimeout(pollTimeout);
            pollTimeout = null;
          }
          if (heartbeatHandle) {
            clearInterval(heartbeatHandle);
            heartbeatHandle = null;
          }
          try {
            controller.close();
          } catch {
            // noop
          }
        };

        closeStreamRef = closeStream;
        requestSignal?.addEventListener("abort", closeStream, { once: true });
      },
      cancel() {
        if (closeStreamRef) {
          closeStreamRef();
          return;
        }
        closed = true;
        if (pollTimeout) {
          clearTimeout(pollTimeout);
          pollTimeout = null;
        }
        if (heartbeatHandle) {
          clearInterval(heartbeatHandle);
          heartbeatHandle = null;
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });

  /**
   * Send a prompt to an arm
   * POST /api/arms/:id/prompt
   *
   * Sends a prompt to a running arm (local harness or distributed agent).
   */
  app.post("/:id/prompt", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const body = await c.req.json<{
      prompt: string;
      interrupt?: boolean;
      attachments?: TaskAttachment[];
    }>();

    if (!body.prompt) {
      throw HttpError.badRequest("prompt is required");
    }

    // Check if arm exists
    const row = db.query("SELECT id, status, agent_id, harness, host, pid, port, provider, model FROM arms WHERE id = ?").get(id) as {
      id: string;
      status: string;
      agent_id: string | null;
      harness: string;
      host: string | null;
      pid: number | null;
      port: number | null;
      provider: string | null;
      model: string | null;
    } | null;

    if (!row) {
      throw HttpError.notFound(`Arm not found: ${id}`);
    }

    const distributedAgentId = resolveDistributedAgentId(id, row.agent_id, {
      harness: row.harness,
      host: row.host,
    });
    const requestedAttachments = body.attachments || [];
    const apiUrl =
      process.env.COLEO_API_URL ||
      (process.env.COLEO_API_PORT
        ? `http://localhost:${process.env.COLEO_API_PORT}`
        : "http://localhost:8080");
    const supportsNativeImages =
      requestedAttachments.length > 0 &&
      (row.harness === "opencode-api" || row.harness === "opencode-tui") &&
      (await supportsInputModality(row.provider, row.model, "image", apiUrl)) === true;
    const promptText = supportsNativeImages
      ? body.prompt
      : appendTaskAttachmentsToPromptText(body.prompt, requestedAttachments);
    const promptAttachments = supportsNativeImages ? requestedAttachments : undefined;

    // Check if arm is running
    if (row.status === "stopped" && !distributedAgentId) {
      return c.json({ error: `Arm ${id} is stopped. Spawn it first.` }, 400);
    }

    // Check if arm is still starting up
    if (row.status === "starting") {
      return c.json({ error: `Arm ${id} is still starting up. Wait for it to finish spawning.` }, 400);
    }

    // Distributed arm prompt via agent
    if (distributedAgentId) {
      const armClient = getArmClient();
      if (!armClient) {
        return c.json(
          { error: `Arm ${id} is assigned to agent ${distributedAgentId}, but distributed arm management is currently unavailable. Retry shortly.` },
          503,
        );
      }

      await refreshDistributedRuntimeFromAgent(
        db,
        id,
        distributedAgentId,
        {
          status: row.status,
          pid: row.pid,
          port: row.port,
          sessionId: null,
          lastActivityAt: null,
        },
      );

      try {
        const response = await armClient.sendPrompt(
          id,
          promptText,
          promptAttachments,
          body.interrupt,
        );
        if (!response.success) {
          return c.json(
            { error: `Arm ${id} is currently unreachable on distributed agent ${distributedAgentId}. Retry shortly.` },
            503,
          );
        }

        const now = new Date().toISOString();
        db.run(
          "UPDATE arms SET status = 'busy', last_heartbeat = ?, updated_at = ? WHERE id = ?",
          [now, now, id],
        );

        logActivity(db, id, "prompt_sent", undefined, {
          promptLength: body.prompt.length,
          interrupt: body.interrupt,
          attachmentCount: requestedAttachments.length,
          nativeAttachments: promptAttachments ? promptAttachments.length : 0,
          distributed: true,
          agentId: distributedAgentId,
        });

        return c.json({
          success: true,
          message: `Prompt sent to arm ${id}`,
          distributed: true,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: `Failed to send prompt: ${message}` }, 500);
      }
    }

    // Get the harness manager
    const manager = getGlobalHarnessManager();
    if (!manager) {
      throw HttpError.internal("Harness manager not initialized");
    }

    // Check if arm has an active session
    if (!manager.hasSession(id)) {
      // Best-effort auto-recovery after API restart for OpenCode harnesses.
      if (
        (row.harness === "opencode-api" || row.harness === "opencode-tui") &&
        row.port !== null &&
        row.pid !== null
      ) {
        try {
          const recovered = await manager.recover(
            id,
            row.harness,
            row.port,
            row.pid,
          );
          if (recovered) {
            const now = new Date().toISOString();
            const recoveredSessionId = manager.getSession(id)?.session.id ?? null;
            db.run(
              "UPDATE arms SET session_id = ?, last_heartbeat = ?, updated_at = ? WHERE id = ?",
              [recoveredSessionId, now, now, id],
            );
          }
        } catch (err) {
          console.warn(`[prompt] Auto-recovery attempt failed for ${id}: ${err}`);
        }
      }

      if (!manager.hasSession(id)) {
        let isAlive = false;
        if (typeof row.pid === "number") {
          try {
            process.kill(row.pid, 0);
            isAlive = true;
          } catch {
            isAlive = false;
          }
        }

        if (!isAlive) {
          const now = new Date().toISOString();
          db.run(
            "UPDATE arms SET status = 'stopped', pid = NULL, port = NULL, updated_at = ? WHERE id = ?",
            [now, id],
          );
          releaseClaimsForArm(db, id, now);
          console.warn(
            `[prompt] Arm ${id} has no active session and PID is not alive; marking as stopped`,
          );
          return c.json(
            { error: `Arm ${id} is no longer running. Spawn it first.` },
            400,
          );
        }

        console.warn(
          `[prompt] Arm ${id} process appears alive but session is not attached yet; keeping status '${row.status}'`,
        );
        return c.json(
          { error: `Arm ${id} is still reconnecting after server restart. Retry shortly.` },
          503,
        );
      }
    }

    try {
      // Send the prompt via harness manager
      await manager.sendPrompt(id, promptText, {
        interrupt: body.interrupt,
        attachments: promptAttachments,
      });

      // Log activity
      logActivity(db, id, "prompt_sent", undefined, {
        promptLength: body.prompt.length,
        interrupt: body.interrupt,
        attachmentCount: requestedAttachments.length,
        nativeAttachments: promptAttachments ? promptAttachments.length : 0,
      });

      return c.json({
        success: true,
        message: `Prompt sent to arm ${id}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw HttpError.internal(`Failed to send prompt: ${message}`);
    }
  });

  return app;
}

// Internal types for database rows
interface ArmRow {
  id: string;
  name: string;
  domain: string;
  harness: string;
  status: string;
  contextBudget: number;
  currentContextUsed: number;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
  lastHeartbeat: string | null;
  lastOutputAt: string | null;
  currentTaskId: string | null;
  pid: number | null;
  port: number | null;
  provider: string | null;
  model: string | null;
  totalTokens: number | null;
  totalCost: number | null;
  currentTaskSubject: string | null;
  currentBugId: string | null;
  currentBugTitle: string | null;
  agentId: string | null;
  host: string | null;
  sessionId: string | null;
  workdir: string | null;
  config: string;
}

function parseArmRow(row: ArmRow): ArmProfile {
  const config = parseArmConfig(row.config);
  const recoveryRequestedAt =
    typeof config.recoveryRequestedAt === "string" ? config.recoveryRequestedAt : undefined;

  return {
    ...row,
    status: row.status as ArmProfile["status"],
    pid: row.pid ?? undefined,
    port: row.port ?? undefined,
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    totalTokens: row.totalTokens ?? 0,
    totalCost: row.totalCost ?? 0,
    currentTaskId: row.currentTaskId ?? undefined,
    currentTaskSubject: row.currentTaskSubject ?? undefined,
    currentBugId: row.currentBugId ?? undefined,
    currentBugTitle: row.currentBugTitle ?? undefined,
    agentId: row.agentId ?? undefined,
    host: row.host ?? undefined,
    sessionId: row.sessionId ?? undefined,
    workdir: row.workdir ?? undefined,
    lastOutputAt: row.lastOutputAt,
    recoveryRequestedAt,
    runtime: deriveArmRuntime({
      status: row.status,
      pid: row.pid,
      port: row.port,
      sessionId: row.sessionId,
      agentId: row.agentId,
      workdir: row.workdir,
      currentTaskId: row.currentTaskId,
      currentTaskSubject: row.currentTaskSubject,
      lastActivityAt: row.lastActivityAt,
      lastHeartbeat: row.lastHeartbeat,
      lastOutputAt: row.lastOutputAt,
    }),
    config,
  };
}
