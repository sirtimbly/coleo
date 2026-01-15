/**
 * ArmAgent - Local daemon that manages arms on a host
 * 
 * Runs independently of the API server and survives restarts.
 * Communicates via NATS for commands and events.
 */

import { hostname } from 'os';
import { 
  NatsClient, 
  generateRequestId,
  type AgentInfo, 
  type AgentHeartbeat,
  type AgentCommand,
  type CommandResponse,
  type ArmState,
  type ArmStatus,
  type SpawnResponse,
  type ListArmsResponse,
} from '../nats';
import { harnessRegistry, type AgentHarness, type HarnessSession, type SpawnConfig } from '../harness';

export interface ArmAgentOptions {
  agentId?: string;
  natsUrl: string;
  octopaiDir: string;
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
  private octopaiDir: string;
  private maxArms: number;
  private heartbeatIntervalMs: number;
  private debug: boolean;
  
  private managedArms: Map<string, ManagedArm> = new Map();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private startedAt: string;

  constructor(options: ArmAgentOptions) {
    this.agentId = options.agentId || `agent-${hostname()}-${process.pid}`;
    this.octopaiDir = options.octopaiDir;
    this.maxArms = options.maxArms || 10;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs || 30000;
    this.debug = options.debug || false;
    this.startedAt = new Date().toISOString();

    this.natsClient = new NatsClient({
      serverUrl: options.natsUrl,
      clientId: this.agentId,
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
      version: '0.1.0',
      capabilities: harnessRegistry.list(),
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
    const { armId, name, domain, harness, provider, model, contextBudget, personality, convictions, workDir } = command;

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

    // Spawn the arm
    const spawnConfig: SpawnConfig = {
      workdir: workDir || process.cwd(),
      env: {
        OCTOPAI_ARM_ID: armId,
        OCTOPAI_DIR: this.octopaiDir,
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
    const { armId, prompt } = command;

    const managedArm = this.managedArms.get(armId);
    if (!managedArm) {
      return {
        requestId: command.requestId,
        success: false,
        error: `Arm ${armId} not found on this agent`,
      };
    }

    // Send prompt
    await managedArm.harness.sendPrompt(managedArm.session, prompt);

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

  // ============================================
  // Helper Methods
  // ============================================

  private async registerAgent(): Promise<void> {
    await this.natsClient.registerAgent(this.getInfo());
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      const heartbeat: AgentHeartbeat = {
        agentId: this.agentId,
        timestamp: new Date().toISOString(),
        activeArms: Array.from(this.managedArms.keys()),
        load: {
          cpu: 0, // TODO: Implement actual CPU monitoring
          memory: process.memoryUsage().heapUsed / process.memoryUsage().heapTotal,
        },
      };

      await this.natsClient.sendHeartbeat(heartbeat);
    }, this.heartbeatIntervalMs);
  }

  private async recoverExistingArms(): Promise<void> {
    // TODO: Implement recovery of arms that were running before agent restart
    // This would involve:
    // 1. Reading a local state file or checking running processes
    // 2. Re-establishing connections to OpenCode servers
    // 3. Re-registering them with NATS
    this.log('Checking for existing arms to recover...', 'debug');
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

  private log(message: string, level: 'debug' | 'info' | 'error' = 'info'): void {
    if (!this.debug && level === 'debug') return;
    const prefix = `[ArmAgent:${this.agentId}]`;
    if (level === 'error') {
      console.error(prefix, message);
    } else {
      console.log(prefix, message);
    }
  }
}
