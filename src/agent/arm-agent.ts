/**
 * ArmAgent - Local daemon that manages arms on a host
 * 
 * Runs independently of the API server and survives restarts.
 * Communicates via NATS for commands and events.
 */

import { homedir, hostname } from 'os';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { chmod, mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { VERSION } from '../version';
import { 
  NatsClient, 
  type AgentInfo, 
  type AgentHeartbeat,
  type AgentCommand,
  type CommandResponse,
  type ArmState,
  type ArmStatus,
  type SpawnResponse,
  type ListArmsResponse,
  type GetMessagesResponse,
  type GetTodosResponse,
  type OpenCodeProviderInfo,
  type OpenCodeProvidersResponse,
} from '../nats';
import {
  harnessRegistry,
  type AgentHarness,
  type HarnessSession,
  type SpawnConfig,
  type OpenCodeApiHarness,
  type OpenCodeTuiHarness,
  type ArmEventCallback,
} from '../harness';
import { truncateLargeFields } from '../harness/event-stream';
import { LocalRepositoryOnboarding } from '../onboarding/local';
import { parseRepositoryOnboardingOperation } from '../onboarding/types';
import { executeWorkspaceOperation, LocalWorkspaceAccess } from '../workspace';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const MAX_DISTRIBUTED_MESSAGES = 200;
const MAX_DISTRIBUTED_TODOS = 200;
const DISTRIBUTED_OBSERVABILITY_TIMEOUT_MS = 7000;

const API_KEY_PROVIDER_ENV = {
  'anthropic': 'ANTHROPIC_API_KEY',
  'cerebras': 'CEREBRAS_API_KEY',
  'deepinfra': 'DEEPINFRA_API_KEY',
  'friendli': 'FRIENDLI_API_KEY',
  'google': 'GOOGLE_API_KEY',
  'groq': 'GROQ_API_KEY',
  'kimi-for-coding': 'KIMI_FOR_CODING_API_KEY',
  'moonshotai': 'MOONSHOTAI_API_KEY',
  'openai': 'OPENAI_API_KEY',
  'openrouter': 'OPENROUTER_API_KEY',
  'opencode': 'OPENCODE_API_KEY',
  'perplexity': 'PERPLEXITY_API_KEY',
  'xai': 'XAI_API_KEY',
} as const;

const API_KEY_PROVIDER_IDS = new Set<string>(Object.keys(API_KEY_PROVIDER_ENV));

function humanizeIdentifier(value: string): string {
  return value
    .split(/[-_/]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getOpenCodeAuthFilePath(): string {
  return join(process.env.HOME || homedir(), '.local', 'share', 'opencode', 'auth.json');
}

async function readOpenCodeAuth(): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(getOpenCodeAuthFilePath(), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function listOpenCodeProviders(): Promise<OpenCodeProvidersResponse> {
  const [{ stdout }, auth] = await Promise.all([
    execFileAsync('opencode', ['models'], { env: process.env, maxBuffer: 1024 * 1024 * 8 }),
    readOpenCodeAuth(),
  ]);
  const providerModels = new Map<string, Set<string>>();

  for (const rawLine of stdout.split(/\r?\n/g)) {
    const line = rawLine.replace(/\u001b\[[0-9;]*m/g, '').trim();
    const separatorIndex = line.indexOf('/');
    if (separatorIndex <= 0) continue;
    const providerId = line.slice(0, separatorIndex).trim();
    const modelId = line.slice(separatorIndex + 1).trim();
    if (!providerId || !modelId) continue;
    const models = providerModels.get(providerId) || new Set<string>();
    models.add(modelId);
    providerModels.set(providerId, models);
  }

  const providers: OpenCodeProviderInfo[] = [...providerModels.entries()]
    .map(([providerId, models]) => ({
      id: providerId,
      name: humanizeIdentifier(providerId),
      models: [...models].sort().map((modelId) => ({ id: modelId, name: modelId })),
      connected:
        Object.hasOwn(auth, providerId) ||
        (API_KEY_PROVIDER_IDS.has(providerId) &&
          Boolean(process.env[API_KEY_PROVIDER_ENV[providerId as keyof typeof API_KEY_PROVIDER_ENV]]?.trim())),
      authMethod: API_KEY_PROVIDER_IDS.has(providerId)
        ? 'api-key' as const
        : providerId === 'github-copilot'
          ? 'oauth' as const
          : 'external' as const,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { providers };
}

async function setOpenCodeApiKey(providerId: string, apiKey: string): Promise<void> {
  if (!API_KEY_PROVIDER_IDS.has(providerId)) {
    throw new Error(`${providerId} does not support API-key setup in Coleo`);
  }
  if (!apiKey.trim()) {
    throw new Error('API key is required');
  }

  const authPath = getOpenCodeAuthFilePath();
  const auth = await readOpenCodeAuth();
  auth[providerId] = { type: 'api', key: apiKey.trim() };
  await mkdir(dirname(authPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${authPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, authPath);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export interface ArmAgentOptions {
  agentId?: string;
  natsUrl: string;
  natsToken?: string;
  coleoDir: string;
  workspaceRoot?: string;
  maxArms?: number;
  heartbeatIntervalMs?: number;
  debug?: boolean;
}

interface ManagedArm {
  armId: string;
  name: string;
  domain: string;
  harnessName: string;
  harness: AgentHarness;
  session: HarnessSession;
  status: ArmStatus;
  provider: string | null;
  model: string | null;
  startedAt: string;
  lastActivityAt: string | null;
  error: string | null;
}

export class ArmAgent {
  private agentId: string;
  private natsClient: NatsClient;
  private coleoDir: string;
  private workspace: LocalWorkspaceAccess;
  private repositoryOnboarding: LocalRepositoryOnboarding;
  private maxArms: number;
  private heartbeatIntervalMs: number;
  private debug: boolean;
  
  private managedArms: Map<string, ManagedArm> = new Map();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private startedAt: string;

  constructor(options: ArmAgentOptions) {
    this.agentId = options.agentId || `agent-${hostname()}-${process.pid}`;
    this.coleoDir = options.coleoDir;
    const workspaceRoot = options.workspaceRoot || process.env.COLEO_AGENT_WORKDIR || process.cwd();
    this.workspace = new LocalWorkspaceAccess(workspaceRoot);
    this.repositoryOnboarding = new LocalRepositoryOnboarding({
      projectDir: workspaceRoot,
      coleoDir: options.coleoDir,
    });
    this.maxArms = options.maxArms || 10;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs || 30000;
    this.debug = options.debug || false;
    this.startedAt = new Date().toISOString();

    this.natsClient = new NatsClient({
      serverUrl: options.natsUrl,
      clientId: this.agentId,
      token: options.natsToken,
      debug: options.debug,
    });
  }

  /**
   * Start the agent
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    this.log('Starting arm agent...');

    // Connect to NATS
    await this.natsClient.connect();

    // Subscribe to commands
    this.natsClient.subscribeToCommands(this.agentId, (cmd) => this.handleCommand(cmd));

    // Register with the system
    await this.registerAgent();

    // Start heartbeat
    this.startHeartbeat();

    // Recover any existing arms that are still running
    await this.recoverExistingArms();

    this.isRunning = true;
    this.log(`Agent started: ${this.agentId}`);
  }

  /**
   * Stop the agent
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.log('Stopping arm agent...');

    // Stop heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Note: We don't kill managed arms - they should keep running
    // Just disconnect from NATS

    await this.natsClient.disconnect();

    this.isRunning = false;
    this.log('Agent stopped');
  }

  /**
   * Get agent info
   */
  getInfo(): AgentInfo {
    return {
      agentId: this.agentId,
      hostname: hostname(),
      platform: process.platform,
      startedAt: this.startedAt,
      version: VERSION,
      capabilities: [...harnessRegistry.list(), 'workspace-rpc', 'repository-onboarding', 'opencode-provider-auth'],
      maxArms: this.maxArms,
    };
  }

  /**
   * Get state of all managed arms
   */
  getArmStates(): ArmState[] {
    const states: ArmState[] = [];
    
    for (const arm of this.managedArms.values()) {
      states.push(this.armToState(arm));
    }

    return states;
  }

  // ============================================
  // Command Handlers
  // ============================================

  private async handleCommand(command: AgentCommand): Promise<CommandResponse> {
    this.log(`Handling command: ${command.type}`, 'debug');

    try {
      switch (command.type) {
        case 'spawn':
          return await this.handleSpawn(command);
        case 'kill':
          return await this.handleKill(command);
        case 'prompt':
          return await this.handlePrompt(command);
        case 'get_state':
          return await this.handleGetState(command);
        case 'list_arms':
          return await this.handleListArms(command);
        case 'abort':
          return await this.handleAbort(command);
        case 'get_messages':
          return await this.handleGetMessages(command);
        case 'get_todos':
          return await this.handleGetTodos(command);
        case 'workspace':
          return {
            requestId: command.requestId,
            success: true,
            data: await executeWorkspaceOperation(this.workspace, command.operation),
          };
        case 'repository_onboarding':
          return {
            requestId: command.requestId,
            success: true,
            data: await this.repositoryOnboarding.execute(
              parseRepositoryOnboardingOperation(command.operation),
            ),
          };
        case 'get_opencode_providers':
          return {
            requestId: command.requestId,
            success: true,
            data: await listOpenCodeProviders(),
          };
        case 'set_opencode_api_key':
          await setOpenCodeApiKey(command.providerId, command.apiKey);
          return {
            requestId: command.requestId,
            success: true,
            data: await listOpenCodeProviders(),
          };
        default:
          return {
            requestId: (command as AgentCommand).requestId,
            success: false,
            error: `Unknown command type: ${(command as { type: string }).type}`,
          };
      }
    } catch (err) {
      return {
        requestId: command.requestId,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async handleSpawn(command: AgentCommand & { type: 'spawn' }): Promise<CommandResponse<SpawnResponse>> {
    const { armId, name, domain, harness, provider, model, contextBudget, personality, convictions, workDir, initialPrompt } = command;

    // Check if arm already exists
    if (this.managedArms.has(armId)) {
      return {
        requestId: command.requestId,
        success: false,
        error: `Arm ${armId} is already running on this agent`,
      };
    }

    // Check capacity
    if (this.managedArms.size >= this.maxArms) {
      return {
        requestId: command.requestId,
        success: false,
        error: `Agent at capacity (${this.maxArms} arms)`,
      };
    }

    // Get harness
    if (!harnessRegistry.has(harness)) {
      return {
        requestId: command.requestId,
        success: false,
        error: `Unknown harness type: ${harness}. Available: ${harnessRegistry.list().join(', ')}`,
      };
    }

    const harnessInstance = harnessRegistry.get(harness);
    this.registerHarnessEventCallback(harness, harnessInstance);

    // Spawn the arm
    const spawnConfig: SpawnConfig = {
      // A remote agent owns its filesystem namespace. Hosted agents pin arms to
      // their mounted checkout instead of trusting a path from the control host.
      workdir: process.env.COLEO_AGENT_WORKDIR || workDir || process.cwd(),
      env: {
        COLEO_ARM_ID: armId,
        COLEO_DIR: this.coleoDir,
      },
      headless: true,
      provider,
      model,
    };

    const session = await harnessInstance.spawn(spawnConfig);

    // Extract port and sessionId from session if available (for API harness)
    const sessionAny = session as unknown as Record<string, unknown>;
    const port = typeof sessionAny.port === 'number' ? sessionAny.port : null;
    const sessionId = typeof sessionAny.sessionId === 'string' ? sessionAny.sessionId : null;

    // Store managed arm
    const managedArm: ManagedArm = {
      armId,
      name,
      domain,
      harnessName: harness,
      harness: harnessInstance,
      session,
      status: 'idle',
      provider: provider || null,
      model: model || null,
      startedAt: new Date().toISOString(),
      lastActivityAt: null,
      error: null,
    };

    this.managedArms.set(armId, managedArm);

    if (initialPrompt) {
      try {
        await managedArm.harness.sendPrompt(managedArm.session, initialPrompt);
        const oldStatus = managedArm.status;
        managedArm.status = 'busy';
        managedArm.lastActivityAt = new Date().toISOString();

        await this.natsClient.publishArmEvent(armId, {
          type: 'arm.status_changed',
          armId,
          agentId: this.agentId,
          oldStatus,
          newStatus: 'busy',
        });
      } catch (err) {
        this.log(
          `Initial prompt failed for ${armId}: ${err instanceof Error ? err.message : String(err)}`,
          'warn',
        );
      }
    }

    // Publish spawned event
    await this.natsClient.publishArmEvent(armId, {
      type: 'arm.spawned',
      armId,
      agentId: this.agentId,
      state: this.armToState(managedArm),
    });

    this.log(`Spawned arm: ${name} (${armId})`);

    // Get PID from harness if available
    const pid = harnessInstance.getPid ? harnessInstance.getPid(session) : 0;

    return {
      requestId: command.requestId,
      success: true,
      data: {
        armId,
        pid,
        port,
        sessionId,
      },
    };
  }

  private async handleKill(command: AgentCommand & { type: 'kill' }): Promise<CommandResponse> {
    const { armId } = command;

    const managedArm = this.managedArms.get(armId);
    if (!managedArm) {
      return {
        requestId: command.requestId,
        success: false,
        error: `Arm ${armId} not found on this agent`,
      };
    }

    // Kill the arm
    await managedArm.harness.kill(managedArm.session);

    // Remove from managed arms
    this.managedArms.delete(armId);

    // Publish killed event
    await this.natsClient.publishArmEvent(armId, {
      type: 'arm.killed',
      armId,
      agentId: this.agentId,
    });

    this.log(`Killed arm: ${managedArm.name} (${armId})`);

    return {
      requestId: command.requestId,
      success: true,
    };
  }

  private async handlePrompt(command: AgentCommand & { type: 'prompt' }): Promise<CommandResponse> {
    const { armId, prompt, interrupt, attachments } = command;

    const managedArm = this.managedArms.get(armId);
    if (!managedArm) {
      return {
        requestId: command.requestId,
        success: false,
        error: `Arm ${armId} not found on this agent`,
      };
    }

    // Send prompt
    await managedArm.harness.sendPrompt(managedArm.session, prompt, {
      interrupt,
      attachments,
    });

    // Update status
    const oldStatus = managedArm.status;
    managedArm.status = 'busy';
    managedArm.lastActivityAt = new Date().toISOString();

    // Publish status change
    await this.natsClient.publishArmEvent(armId, {
      type: 'arm.status_changed',
      armId,
      agentId: this.agentId,
      oldStatus,
      newStatus: 'busy',
    });

    return {
      requestId: command.requestId,
      success: true,
    };
  }

  private async handleGetState(command: AgentCommand & { type: 'get_state' }): Promise<CommandResponse<ArmState>> {
    const { armId } = command;

    const managedArm = this.managedArms.get(armId);
    if (!managedArm) {
      return {
        requestId: command.requestId,
        success: false,
        error: `Arm ${armId} not found on this agent`,
      };
    }

    try {
      const harnessState = await managedArm.harness.getState(managedArm.session);
      const status = this.mapHarnessState(harnessState);
      if (status) {
        managedArm.status = status;
      }
    } catch (err) {
      this.log(
        `Failed to refresh harness state for ${armId}: ${err instanceof Error ? err.message : String(err)}`,
        'warn',
      );
    }

    return {
      requestId: command.requestId,
      success: true,
      data: this.armToState(managedArm),
    };
  }

  private async handleListArms(command: AgentCommand & { type: 'list_arms' }): Promise<CommandResponse<ListArmsResponse>> {
    return {
      requestId: command.requestId,
      success: true,
      data: {
        arms: this.getArmStates(),
      },
    };
  }

  private async handleAbort(command: AgentCommand & { type: 'abort' }): Promise<CommandResponse> {
    const { armId } = command;

    const managedArm = this.managedArms.get(armId);
    if (!managedArm) {
      return {
        requestId: command.requestId,
        success: false,
        error: `Arm ${armId} not found on this agent`,
      };
    }

    // Interrupt the arm
    await managedArm.harness.interrupt(managedArm.session);

    // Update status
    managedArm.status = 'idle';

    return {
      requestId: command.requestId,
      success: true,
    };
  }

  private async handleGetMessages(
    command: AgentCommand & { type: 'get_messages' },
  ): Promise<CommandResponse<GetMessagesResponse>> {
    const { armId, limit } = command;
    const managedArm = this.managedArms.get(armId);
    if (!managedArm) {
      return {
        requestId: command.requestId,
        success: false,
        error: `Arm ${armId} not found on this agent`,
      };
    }

    if (!managedArm.harness.getMessages) {
      return {
        requestId: command.requestId,
        success: false,
        error: `Harness ${managedArm.harnessName} does not support messages`,
      };
    }

    const cappedLimit =
      typeof limit === 'number' && Number.isFinite(limit) && limit > 0
        ? Math.min(limit, MAX_DISTRIBUTED_MESSAGES)
        : MAX_DISTRIBUTED_MESSAGES;
    const rawMessages = await withTimeout(
      managedArm.harness.getMessages(managedArm.session, {
        limit: cappedLimit,
      }),
      DISTRIBUTED_OBSERVABILITY_TIMEOUT_MS,
      `Fetching messages for arm ${armId}`,
    );
    const messages = truncateLargeFields(
      Array.isArray(rawMessages) ? rawMessages.slice(-cappedLimit) : [],
    ) as unknown[];
    const state = this.armToState(managedArm);
    return {
      requestId: command.requestId,
      success: true,
      data: {
        messages,
        sessionId: state.sessionId,
      },
    };
  }

  private async handleGetTodos(
    command: AgentCommand & { type: 'get_todos' },
  ): Promise<CommandResponse<GetTodosResponse>> {
    const { armId } = command;
    const managedArm = this.managedArms.get(armId);
    if (!managedArm) {
      return {
        requestId: command.requestId,
        success: false,
        error: `Arm ${armId} not found on this agent`,
      };
    }

    if (!managedArm.harness.getTodos) {
      return {
        requestId: command.requestId,
        success: false,
        error: `Harness ${managedArm.harnessName} does not support todos`,
      };
    }

    const rawTodos = await withTimeout(
      managedArm.harness.getTodos(managedArm.session),
      DISTRIBUTED_OBSERVABILITY_TIMEOUT_MS,
      `Fetching todos for arm ${armId}`,
    );
    const todos = truncateLargeFields(
      Array.isArray(rawTodos) ? rawTodos.slice(0, MAX_DISTRIBUTED_TODOS) : [],
    ) as unknown[];
    return {
      requestId: command.requestId,
      success: true,
      data: { todos },
    };
  }

  // ============================================
  // Helper Methods
  // ============================================

  private registerHarnessEventCallback(harnessName: string, harness: AgentHarness): void {
    const callback: ArmEventCallback = (armId, event, data) => {
      void this.handleHarnessEvent(armId, event, data);
    };

    if (harnessName === 'opencode-api') {
      (harness as OpenCodeApiHarness).setEventCallback(callback);
    } else if (harnessName === 'opencode-tui') {
      (harness as OpenCodeTuiHarness).setEventCallback(callback);
    }
  }

  private mapHarnessState(state: unknown): ArmStatus | null {
    if (typeof state !== 'string') {
      return null;
    }

    switch (state.toLowerCase()) {
      case 'idle':
        return 'idle';
      case 'initializing':
        return 'starting';
      case 'busy':
      case 'processing':
      case 'executing':
      case 'running':
      case 'retry':
      case 'waiting_approval':
        return 'busy';
      case 'error':
      case 'failed':
        return 'error';
      case 'dead':
      case 'stopped':
        return 'stopped';
      default:
        return null;
    }
  }

  private mapEventStatus(event: string, data: unknown): ArmStatus | null {
    if (event === 'session.idle') {
      return 'idle';
    }

    if (event === 'session.error') {
      return 'error';
    }

    if (event === 'process.died') {
      return 'stopped';
    }

    if (event === 'session.status' || event === 'session.updated') {
      const rawStatus = (data as { status?: unknown } | null)?.status;
      const status =
        rawStatus && typeof rawStatus === 'object'
          ? (rawStatus as { type?: unknown }).type
          : rawStatus;
      return this.mapHarnessState(status);
    }

    return null;
  }

  private async handleHarnessEvent(armId: string, event: string, data: unknown): Promise<void> {
    const managedArm = this.managedArms.get(armId);
    if (!managedArm) {
      return;
    }

    managedArm.lastActivityAt = new Date().toISOString();

    try {
      await this.natsClient.publishArmEvent(armId, {
        type: 'arm.activity',
        armId,
        agentId: this.agentId,
        activity: {
          type: event,
          data,
        },
      });
    } catch (err) {
      this.log(
        `Failed to publish activity event for ${armId}: ${err instanceof Error ? err.message : String(err)}`,
        'warn',
      );
    }

    const nextStatus = this.mapEventStatus(event, data);
    if (!nextStatus || nextStatus === managedArm.status) {
      return;
    }

    const oldStatus = managedArm.status;
    managedArm.status = nextStatus;
    try {
      await this.natsClient.publishArmEvent(armId, {
        type: 'arm.status_changed',
        armId,
        agentId: this.agentId,
        oldStatus,
        newStatus: nextStatus,
      });
    } catch (err) {
      this.log(
        `Failed to publish status change for ${armId}: ${err instanceof Error ? err.message : String(err)}`,
        'warn',
      );
    }
  }

  private async registerAgent(): Promise<void> {
    await this.natsClient.registerAgent(this.getInfo());
  }

  private startHeartbeat(): void {
    const sendHeartbeat = async () => {
      const heartbeat: AgentHeartbeat = {
        agentId: this.agentId,
        timestamp: new Date().toISOString(),
        activeArms: Array.from(this.managedArms.keys()),
        info: this.getInfo(),
        load: {
          cpu: 0, // TODO: Implement actual CPU monitoring
          memory: process.memoryUsage().heapUsed / process.memoryUsage().heapTotal,
        },
      };

      await this.natsClient.sendHeartbeat(heartbeat);
    };

    void sendHeartbeat().catch((err) => {
      this.log(
        `Failed to send heartbeat: ${err instanceof Error ? err.message : String(err)}`,
        'warn',
      );
    });

    this.heartbeatTimer = setInterval(() => {
      void sendHeartbeat().catch((err) => {
        this.log(
          `Failed to send heartbeat: ${err instanceof Error ? err.message : String(err)}`,
          'warn',
        );
      });
    }, this.heartbeatIntervalMs);
  }

  private async recoverExistingArms(): Promise<void> {
    this.log('Checking for existing arms to recover...', 'debug');

    try {
      // Find running opencode processes
      // We look for processes with COLEO_ARM_ID environment variable
      // Using ps eww -A on macOS/Linux to get environment variables
      const command = process.platform === 'darwin' || process.platform === 'linux' 
        ? 'ps eww -A' 
        : ''; // Windows not supported for recovery yet

      if (!command) {
        this.log('Skipping arm recovery: platform not supported', 'debug');
        return;
      }

      const { stdout } = await execAsync(command, { maxBuffer: 10 * 1024 * 1024 }); // 10MB buffer
      const lines = stdout.split('\n');

      const recoveredArms: Map<string, { pid: number; port: number | null }> = new Map();

      for (const line of lines) {
        // Look for opencode processes
        if (!line.includes('opencode')) continue;
        
        // Extract PID
        const pidMatch = line.trim().match(/^(\d+)/);
        if (!pidMatch || !pidMatch[1]) continue;
        const pidStr = pidMatch[1];
        const pid = parseInt(pidStr, 10);

        // Skip our own PID
        if (pid === process.pid) continue;

        // Extract COLEO_ARM_ID
        const armIdMatch = line.match(/COLEO_ARM_ID=([a-zA-Z0-9_-]+)/);
        if (!armIdMatch || !armIdMatch[1]) continue;
        const armId: string = armIdMatch[1];

        // Check if we already found this arm (might be multiple threads/processes)
        if (recoveredArms.has(armId)) continue;

        // Extract port if available (for API harness)
        // Look for --port argument
        const portMatch = line.match(/--port\s+(\d+)/);
        const port = (portMatch && portMatch[1]) ? parseInt(portMatch[1], 10) : null;

        recoveredArms.set(armId, { pid, port });
      }

      if (recoveredArms.size === 0) {
        this.log('No existing arms found to recover.', 'debug');
        return;
      }

      this.log(`Found ${recoveredArms.size} potential arms to recover: ${Array.from(recoveredArms.keys()).join(', ')}`);

      // Try to recover each arm
      for (const [armId, info] of recoveredArms.entries()) {
        try {
          // Determine harness type - currently only opencode-api supports recovery effectively
          // In the future, we might infer this from process args or other env vars
          const harnessName = info.port ? 'opencode-api' : 'opencode';

          if (harnessName === 'opencode-api' && info.port !== null) {
            this.log(`Attempting to recover arm ${armId} (port ${info.port})...`);
            
            const harness = harnessRegistry.get('opencode-api') as OpenCodeApiHarness;
            if (!harness) {
              this.log(`Skipping ${armId}: opencode-api harness not found`, 'error');
              continue;
            }

            this.registerHarnessEventCallback('opencode-api', harness);
            const session = await harness.recover(armId, info.port, info.pid);
            
            if (session) {
              // Create managed arm entry
              const managedArm: ManagedArm = {
                armId,
                name: armId, // We don't have the original name, use ID
                domain: 'recovered', // Unknown domain
                harnessName: 'opencode-api',
                harness,
                session,
                status: 'idle', // Assume idle initially
                provider: null, // Unknown
                model: null, // Unknown
                startedAt: new Date().toISOString(), // Use now as start time since we just recovered
                lastActivityAt: null,
                error: null,
              };

              this.managedArms.set(armId, managedArm);
              this.log(`Successfully recovered arm: ${armId}`);
              
              // Publish recovery event
              await this.natsClient.publishArmEvent(armId, {
                type: 'arm.recovered',
                armId,
                agentId: this.agentId,
                state: this.armToState(managedArm),
              });
            } else {
              this.log(`Failed to recover session for arm ${armId}`, 'warn');
            }
          } else {
            // PTY-based recovery is harder because we can't easily re-attach to the PTY
            // For now, we just log it
            this.log(`Skipping recovery for PTY-based arm ${armId} (PID ${info.pid}) - re-attachment not supported yet`, 'debug');
          }
        } catch (err) {
          this.log(`Error recovering arm ${armId}: ${err instanceof Error ? err.message : String(err)}`, 'error');
        }
      }
    } catch (err) {
      this.log(`Error scanning for existing arms: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  private armToState(arm: ManagedArm): ArmState {
    // Extract port and sessionId from session if available
    const sessionAny = arm.session as unknown as Record<string, unknown>;
    const port = typeof sessionAny.port === 'number' ? sessionAny.port : null;
    const sessionId = typeof sessionAny.sessionId === 'string' ? sessionAny.sessionId : null;
    const pid = arm.harness.getPid ? arm.harness.getPid(arm.session) : null;

    return {
      armId: arm.armId,
      agentId: this.agentId,
      name: arm.name,
      domain: arm.domain,
      harness: arm.harnessName,
      status: arm.status,
      pid,
      port,
      provider: arm.provider,
      model: arm.model,
      sessionId,
      startedAt: arm.startedAt,
      lastActivityAt: arm.lastActivityAt,
      error: arm.error,
    };
  }

  private log(message: string, level: 'debug' | 'info' | 'warn' | 'error' = 'info'): void {
    if (!this.debug && level === 'debug') return;
    const prefix = `[ArmAgent:${this.agentId}]`;
    if (level === 'error') {
      console.error(prefix, message);
    } else if (level === 'warn') {
      console.warn(prefix, message);
    } else {
      console.log(prefix, message);
    }
  }
}
