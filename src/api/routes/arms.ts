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
import { getArmClient } from "../server";
import { generateSystemPrompt } from "../../arm/prompts";
import { eventStore } from "../../nats/jetstream";
import { releaseClaimsForArm } from "../claim-cleanup";
import { refreshOpenCodeProvidersCache } from "./opencode";
import { getCliEntrypoint } from "../../cli/entrypoint";
import { hostname } from "os";
import { appendTaskAttachmentsToPromptText } from "../../lib/prompt-attachments";
import { supportsInputModality } from "../../harness/model-resolver";
import type { TaskAttachment } from "../../types";

interface ArmsContext {
  Variables: {
    db: Database;
  };
}

const AUTO_AGENT_ID = `agent-${hostname()}-autostart`;
const AUTO_AGENT_WAIT_MS_DEFAULT = 8000;
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
  if (persistedAgentId || mapped) {
    return persistedAgentId || mapped || null;
  }

  const daemonManagedHarness =
    options?.harness === "opencode-api" || options?.harness === "opencode";
  if (!daemonManagedHarness) {
    return null;
  }

  if (options?.host) {
    const matchingAgent = armClient.getAgents().find((agent) => agent.hostname === options.host);
    if (matchingAgent) {
      return matchingAgent.agentId;
    }
  }

  // Local daemon fallback for bootstrap/restart windows before heartbeats populate mappings.
  if (armClient.getAgent(AUTO_AGENT_ID)) {
    return AUTO_AGENT_ID;
  }

  return null;
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

async function refreshDistributedRuntimeFromAgent(
  db: Database,
  armId: string,
  agentId: string | null,
  current: DistributedRuntimeSnapshot,
): Promise<DistributedRuntimeSnapshot> {
  const armClient = getArmClient();
  if (!armClient) {
    return current;
  }

  let remoteState:
    | {
        status?: string | null;
        pid?: number | null;
        port?: number | null;
        sessionId?: string | null;
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
    return current;
  }

  if (!remoteState) {
    return current;
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
  };

  const now = new Date().toISOString();
  const resolvedHost = agentId ? armClient.getAgent(agentId)?.hostname ?? null : null;
  db.run(
    "UPDATE arms SET status = ?, pid = ?, port = ?, session_id = ?, agent_id = COALESCE(?, agent_id), host = COALESCE(?, host), last_heartbeat = ?, updated_at = ? WHERE id = ?",
    [next.status, next.pid, next.port, next.sessionId, agentId, resolvedHost, now, now, armId],
  );

  return next;
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
  lastHeartbeat?: string | null;
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
      // Legacy template location kept for CLI/API compatibility.
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
  } catch {
    // Fall back to regex parsing below
  }

  // Fill any missing fields via regex for backwards compatibility
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
          current_task_id as currentTaskId,
          pid, port, provider, model,
          total_tokens as totalTokens,
          total_cost as totalCost,
          current_task_subject as currentTaskSubject,
          current_bug_id as currentBugId,
          current_bug_title as currentBugTitle,
          agent_id as agentId,
          host,
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
        current_task_id as currentTaskId,
        pid, port, provider, model,
        total_tokens as totalTokens,
        total_cost as totalCost,
        current_task_subject as currentTaskSubject,
        current_bug_id as currentBugId,
        current_bug_title as currentBugTitle,
        agent_id as agentId,
        host,
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
      INSERT INTO arms (id, name, domain, harness, status, context_budget, current_context_used, created_at, updated_at, pid, provider, model, config)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      pid: undefined,
      provider,
      model,
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
      logActivity(db, id, "status_changed", undefined, { newStatus: body.status });
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

    if (updates.length === 0) {
      throw HttpError.badRequest("No fields to update");
    }

    const updatedAt = new Date().toISOString();
    updates.push("updated_at = ?");
    values.push(updatedAt);
    values.push(id);

    db.run(`UPDATE arms SET ${updates.join(", ")} WHERE id = ?`, values as (string | number | null)[]);

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
        current_task_id as currentTaskId,
        pid, provider, model,
        current_task_subject as currentTaskSubject,
        current_bug_id as currentBugId,
        current_bug_title as currentBugTitle,
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

  /**
   * Spawn an arm via agent daemon (distributed) or local harness fallback
   * POST /api/arms/:id/spawn
   * 
   * Daemon-managed harnesses (`opencode-api`, `opencode`) require an arm agent
   * by default so sessions survive API restarts.
   */
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
      harness?: string; // Allow specifying harness for auto-created arms
      preferAgent?: boolean; // Explicitly request agent spawning
      agentId?: string; // Spawn on a specific agent
      recover?: boolean; // Enable recovery of existing OpenCode server (default: false)
      allowLocalFallback?: boolean; // Allow local fallback for daemon-managed harnesses
    }>();

    // Check if arm exists (include port and pid for potential recovery)
    let row = db.query("SELECT id, name, domain, harness, status, provider, model, port, pid, agent_id, host, context_budget FROM arms WHERE id = ?").get(id) as {
      id: string;
      name: string;
      domain: string;
      harness: string;
      status: string;
      provider: string | null;
      model: string | null;
      port: number | null;
      pid: number | null;
      agent_id: string | null;
      host: string | null;
      context_budget: number;
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
          INSERT INTO arms (id, name, domain, harness, status, context_budget, current_context_used, created_at, updated_at, pid, provider, model, config)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        row = db.query("SELECT id, name, domain, harness, status, provider, model, port, pid, agent_id, host, context_budget FROM arms WHERE id = ?").get(id) as typeof row;

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
    const workdir = body.workdir || process.cwd();

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
      domain: row.domain,
      harness: row.harness,
      workdir,
      provider,
      model,
    });
    const fullInitialPrompt = body.initialPrompt
      ? `${systemPrompt}\n\n---\n\n## Additional Instructions\n\n${body.initialPrompt}`
      : systemPrompt;

    const daemonManagedHarness = row.harness === "opencode-api" || row.harness === "opencode";
    const localFallbackEnabled =
      body.allowLocalFallback === true ||
      process.env.COLEO_ALLOW_LOCAL_HARNESS_FALLBACK === "1" ||
      process.env.NODE_ENV === "test";

    // Try distributed spawning via ArmClient if available
    const armClient = getArmClient();
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
          "UPDATE arms SET status = 'idle', agent_id = ?, host = ?, pid = ?, port = ?, session_id = ?, provider = ?, model = ?, last_heartbeat = ?, updated_at = ? WHERE id = ?",
          [agentId, agentHost, response.data?.pid ?? null, response.data?.port ?? null, response.data?.sessionId ?? null, provider, model, now, now, id],
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

    // If arm was stopped but has port/pid, try to recover existing OpenCode server
    // Recovery is disabled by default - must pass recover: true to enable
    if (body.recover && row.status === "stopped" && row.port && row.pid && row.harness === "opencode-api") {
      console.log(`[spawn] Attempting to recover existing OpenCode server for ${id} (port: ${row.port}, pid: ${row.pid})`);
      const recovered = await manager.recover(id, row.harness, row.port, row.pid);
      if (recovered) {
        // Update database to reflect recovered state
        const now = new Date().toISOString();
        const recoveredSessionId = manager.getSession(id)?.session.id;
        db.run(
          "UPDATE arms SET status = 'idle', session_id = ?, provider = ?, model = ?, last_heartbeat = ?, updated_at = ? WHERE id = ?",
          [recoveredSessionId ?? null, provider, model, now, now, id]
        );
        
        // Log activity
        logActivity(db, id, "recovered", undefined, { port: row.port, pid: row.pid });
        
        // Broadcast arm recovered
        broadcast("arms", "arm.spawned", { id, recovered: true, pid: row.pid, port: row.port, status: "idle" });
        
        return c.json({
          spawned: true,
          recovered: true,
          sessionId: manager.getSession(id)?.session.id,
          pid: row.pid,
          port: row.port,
          provider,
          model,
        });
      }
      // Recovery failed, continue with fresh spawn
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
        "UPDATE arms SET status = 'idle', pid = ?, port = ?, session_id = ?, agent_id = NULL, host = NULL, provider = ?, model = ?, last_heartbeat = ?, updated_at = ? WHERE id = ?",
        [pid ?? null, port ?? null, session.session.id, provider, model, now, now, id]
      );

      // Log activity
      logActivity(db, id, "spawned", undefined, { pid: pid ?? undefined, port: port ?? undefined, workdir: body.workdir, provider, model, distributed: false });

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

    return c.json({ success: true });
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
      const snapshot = await refreshDistributedRuntimeFromAgent(
        db,
        id,
        distributedAgentId,
        {
          status: row.status,
          pid: row.pid,
          port: row.port,
          sessionId: row.session_id,
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
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : 50;

    const row = db.query("SELECT id, status, port, session_id, agent_id, harness, host FROM arms WHERE id = ?").get(id) as {
      id: string;
      status: string;
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
        response = await armClient.getMessages(id, { limit }, 10000);
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
        messages: response.data?.messages || [],
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
      return c.json({ messages: [], error: "Arm has no active harness session" });
    }

    try {
      const messages = await manager.getMessages(id, { limit });
      const sessionId = manager.getSession(id)?.session.id;

      return c.json({
        messages,
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
        },
      );

      const armClient = getArmClient();
      if (!armClient) {
        return c.json({ todos: [], message: "Arm agent client not available" });
      }

      let response;
      try {
        response = await armClient.getTodos(id, 10000);
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
    let intervalHandle: ReturnType<typeof setInterval> | null = null;
    let closeStreamRef: (() => void) | null = null;
    const requestSignal = c.req.raw.signal;

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        let lastPollTime = new Date(Date.now() - 2_000);

        const writeEvent = (eventName: string, data: unknown): boolean => {
          if (closed) {
            return false;
          }

          try {
            controller.enqueue(
              encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`),
            );
            return true;
          } catch {
            // Stream may already be closed/cancelled by the client.
            closed = true;
            if (intervalHandle) {
              clearInterval(intervalHandle);
              intervalHandle = null;
            }
            return false;
          }
        };

        const poll = async (): Promise<void> => {
          if (closed) {
            return;
          }

          try {
            const events = await eventStore.queryEvents({
              subject: `coleo.events.arm.${id}.>`,
              since: lastPollTime,
              limit: 100,
            });
            lastPollTime = new Date();

            events
              .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
              .forEach((event) => {
                writeEvent(event.type, {
                  ...event,
                  armId: event.armId || id,
                });
              });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            writeEvent("error", { error: message });
          }
        };

        intervalHandle = setInterval(() => {
          void poll();
        }, 1000);

        writeEvent("connected", { armId: id });
        void poll();

        const closeStream = (): void => {
          if (closed) {
            return;
          }
          closed = true;
          if (intervalHandle) {
            clearInterval(intervalHandle);
            intervalHandle = null;
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
        if (intervalHandle) {
          clearInterval(intervalHandle);
          intervalHandle = null;
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
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
        },
      );

      try {
        const response = await armClient.sendPrompt(id, promptText, promptAttachments);
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
  config: string;
}

function parseArmRow(row: ArmRow): ArmProfile {
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
    config: JSON.parse(row.config || "{}"),
  };
}
