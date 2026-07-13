/**
 * ArmClient - API Server's interface to distributed agents
 * 
 * Subscribes to agent events and provides methods to send commands to agents.
 * Used by the API server to manage arms running on remote hosts.
 */

import { NatsClient, generateRequestId } from './client';
import type {
  AgentInfo,
  AgentHeartbeat,
  OctopaiEvent,
  ArmState,
  SpawnArmCommand,
  KillArmCommand,
  SendPromptCommand,
  AbortCommand,
  CommandResponse,
  SpawnResponse,
  ListArmsResponse,
  GetMessagesResponse,
  GetTodosResponse,
} from './types';
import type { TaskAttachment } from "../types";

export interface ArmClientOptions {
  natsUrl: string;
  token?: string;
  debug?: boolean;
  onAgentConnected?: (agent: AgentInfo) => void;
  onAgentDisconnected?: (agentId: string) => void;
  onAgentHeartbeat?: (heartbeat: AgentHeartbeat) => void;
  onArmEvent?: (event: OctopaiEvent) => void;
}

interface TrackedAgent {
  info: AgentInfo;
  lastHeartbeat: Date;
  arms: string[];
}

export class ArmClient {
  private natsClient: NatsClient;
  private debug: boolean;
  private agents: Map<string, TrackedAgent> = new Map();
  private armToAgent: Map<string, string> = new Map(); // armId -> agentId
  
  private onAgentConnected?: (agent: AgentInfo) => void;
  private onAgentDisconnected?: (agentId: string) => void;
  private onAgentHeartbeat?: (heartbeat: AgentHeartbeat) => void;
  private onArmEvent?: (event: OctopaiEvent) => void;
  
  private heartbeatCheckTimer: ReturnType<typeof setInterval> | null = null;
  private isConnected = false;

  constructor(options: ArmClientOptions) {
    this.debug = options.debug || false;
    this.onAgentConnected = options.onAgentConnected;
    this.onAgentDisconnected = options.onAgentDisconnected;
    this.onAgentHeartbeat = options.onAgentHeartbeat;
    this.onArmEvent = options.onArmEvent;

    this.natsClient = new NatsClient({
      serverUrl: options.natsUrl,
      clientId: 'api-server',
      token: options.token,
      debug: options.debug,
    });
  }

  /**
   * Connect to NATS and start listening for agents
   */
  async connect(): Promise<void> {
    if (this.isConnected) return;

    await this.natsClient.connect();

    // Subscribe to agent registrations
    this.natsClient.subscribeToAgentRegistrations((info) => this.handleAgentRegistration(info));

    // Subscribe to agent heartbeats
    this.natsClient.subscribeToAgentHeartbeats((heartbeat) => this.handleAgentHeartbeat(heartbeat));

    // Subscribe to arm events
    this.natsClient.subscribeToArmEvents((event) => this.handleArmEvent(event));

    // Start heartbeat checking
    this.startHeartbeatCheck();

    this.isConnected = true;
    this.log('ArmClient connected to NATS');
  }

  /**
   * Disconnect from NATS
   */
  async disconnect(): Promise<void> {
    if (!this.isConnected) return;

    if (this.heartbeatCheckTimer) {
      clearInterval(this.heartbeatCheckTimer);
      this.heartbeatCheckTimer = null;
    }

    await this.natsClient.disconnect();
    this.isConnected = false;
    this.log('ArmClient disconnected from NATS');
  }

  // ============================================
  // Agent Discovery
  // ============================================

  /**
   * Get all connected agents
   */
  getAgents(): AgentInfo[] {
    return Array.from(this.agents.values()).map(a => a.info);
  }

  /**
   * Get a specific agent
   */
  getAgent(agentId: string): AgentInfo | undefined {
    return this.agents.get(agentId)?.info;
  }

  /**
   * Remove an agent from the live registry and clear any arm mappings that point to it.
   * This is used when a command path proves an agent is no longer reachable before
   * heartbeat-based stale detection has caught up.
   */
  markAgentUnavailable(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return;
    }

    this.agents.delete(agentId);
    for (const armId of agent.arms) {
      this.armToAgent.delete(armId);
    }

    this.onAgentDisconnected?.(agentId);
  }

  /**
   * Find the best agent to spawn an arm on
   */
  findBestAgent(harness: string): AgentInfo | undefined {
    let bestAgent: TrackedAgent | undefined;
    let lowestLoad = Infinity;

    for (const agent of this.agents.values()) {
      // Check if agent supports the harness
      if (!agent.info.capabilities.includes(harness)) continue;

      // Check if agent has capacity
      if (agent.arms.length >= agent.info.maxArms) continue;

      // Use the agent with the lowest arm count
      if (agent.arms.length < lowestLoad) {
        lowestLoad = agent.arms.length;
        bestAgent = agent;
      }
    }

    return bestAgent?.info;
  }

  /**
   * Get the agent hosting a specific arm
   */
  getAgentForArm(armId: string): string | undefined {
    return this.armToAgent.get(armId);
  }

  // ============================================
  // Arm Commands
  // ============================================

  /**
   * Spawn an arm on a specific agent
   */
  async spawnArm(
    agentId: string,
    armId: string,
    options: {
      name: string;
      domain: string;
      harness: string;
      provider?: string;
      model?: string;
      contextBudget?: number;
      personality?: string;
      convictions?: string[];
      workDir?: string;
      initialPrompt?: string;
    },
    timeoutMs = 60000
  ): Promise<CommandResponse<SpawnResponse>> {
    const command: SpawnArmCommand = {
      type: 'spawn',
      requestId: generateRequestId(),
      armId,
      ...options,
    };

    const response = await this.natsClient.sendCommand<SpawnResponse>(agentId, command, timeoutMs);

    if (response.success && response.data) {
      // Track the arm -> agent mapping
      this.armToAgent.set(armId, agentId);
      
      // Update agent's arm list
      const agent = this.agents.get(agentId);
      if (agent && !agent.arms.includes(armId)) {
        agent.arms.push(armId);
      }
    }

    return response;
  }

  /**
   * Kill an arm
   */
  async killArm(armId: string, timeoutMs = 30000): Promise<CommandResponse> {
    const agentId = this.armToAgent.get(armId);
    if (!agentId) {
      return {
        requestId: generateRequestId(),
        success: false,
        error: `No agent found for arm ${armId}`,
      };
    }

    const command: KillArmCommand = {
      type: 'kill',
      requestId: generateRequestId(),
      armId,
    };

    const response = await this.natsClient.sendCommand(agentId, command, timeoutMs);

    if (response.success) {
      // Remove tracking
      this.armToAgent.delete(armId);
      
      // Update agent's arm list
      const agent = this.agents.get(agentId);
      if (agent) {
        agent.arms = agent.arms.filter(id => id !== armId);
      }
    }

    return response;
  }

  /**
   * Send a prompt to an arm
   */
  async sendPrompt(
    armId: string,
    prompt: string,
    attachments?: TaskAttachment[],
    timeoutMs = 30000,
  ): Promise<CommandResponse> {
    const agentId = this.armToAgent.get(armId);
    if (!agentId) {
      return {
        requestId: generateRequestId(),
        success: false,
        error: `No agent found for arm ${armId}`,
      };
    }

    const command: SendPromptCommand = {
      type: 'prompt',
      requestId: generateRequestId(),
      armId,
      prompt,
      attachments,
    };

    return this.natsClient.sendCommand(agentId, command, timeoutMs);
  }

  /**
   * Abort current operation on an arm
   */
  async abortArm(armId: string, timeoutMs = 10000): Promise<CommandResponse> {
    const agentId = this.armToAgent.get(armId);
    if (!agentId) {
      return {
        requestId: generateRequestId(),
        success: false,
        error: `No agent found for arm ${armId}`,
      };
    }

    const command: AbortCommand = {
      type: 'abort',
      requestId: generateRequestId(),
      armId,
    };

    return this.natsClient.sendCommand(agentId, command, timeoutMs);
  }

  /**
   * Get recent messages for an arm from the hosting agent.
   */
  async getMessages(
    armId: string,
    options?: { limit?: number },
    timeoutMs = 10000,
  ): Promise<CommandResponse<GetMessagesResponse>> {
    const agentId = this.armToAgent.get(armId);
    if (!agentId) {
      return {
        requestId: generateRequestId(),
        success: false,
        error: `No agent found for arm ${armId}`,
      };
    }

    return this.natsClient.sendCommand<GetMessagesResponse>(
      agentId,
      {
        type: 'get_messages',
        requestId: generateRequestId(),
        armId,
        limit: options?.limit,
      },
      timeoutMs,
    );
  }

  /**
   * Get todos for an arm from the hosting agent.
   */
  async getTodos(
    armId: string,
    timeoutMs = 10000,
  ): Promise<CommandResponse<GetTodosResponse>> {
    const agentId = this.armToAgent.get(armId);
    if (!agentId) {
      return {
        requestId: generateRequestId(),
        success: false,
        error: `No agent found for arm ${armId}`,
      };
    }

    return this.natsClient.sendCommand<GetTodosResponse>(
      agentId,
      {
        type: 'get_todos',
        requestId: generateRequestId(),
        armId,
      },
      timeoutMs,
    );
  }

  /**
   * Get state of an arm
   */
  async getArmState(armId: string, timeoutMs = 10000): Promise<CommandResponse<ArmState>> {
    const agentId = this.armToAgent.get(armId);
    if (!agentId) {
      return {
        requestId: generateRequestId(),
        success: false,
        error: `No agent found for arm ${armId}`,
      };
    }

    return this.natsClient.sendCommand<ArmState>(agentId, {
      type: 'get_state',
      requestId: generateRequestId(),
      armId,
    }, timeoutMs);
  }

  /**
   * List all arms on an agent
   */
  async listArmsOnAgent(agentId: string, timeoutMs = 10000): Promise<CommandResponse<ListArmsResponse>> {
    const response = await this.natsClient.sendCommand<ListArmsResponse>(agentId, {
      type: 'list_arms',
      requestId: generateRequestId(),
    }, timeoutMs);

    if (response.success && response.data?.arms) {
      const agent = this.agents.get(agentId);
      const trackedArmIds: string[] = [];
      for (const arm of response.data.arms) {
        this.armToAgent.set(arm.armId, agentId);
        trackedArmIds.push(arm.armId);
      }
      if (agent) {
        agent.arms = trackedArmIds;
      }
    }

    return response;
  }

  // ============================================
  // Event Handlers
  // ============================================

  private handleAgentRegistration(info: AgentInfo): void {
    this.log(`Agent registered: ${info.agentId} (${info.hostname})`);

    this.agents.set(info.agentId, {
      info,
      lastHeartbeat: new Date(),
      arms: [],
    });

    this.onAgentConnected?.(info);
  }

  private handleAgentHeartbeat(heartbeat: AgentHeartbeat): void {
    let agent = this.agents.get(heartbeat.agentId);

    if (!agent && heartbeat.info) {
      this.log(`Discovered agent from heartbeat: ${heartbeat.agentId}`, 'debug');
      this.agents.set(heartbeat.agentId, {
        info: heartbeat.info,
        lastHeartbeat: new Date(),
        arms: [...heartbeat.activeArms],
      });
      this.onAgentConnected?.(heartbeat.info);
      agent = this.agents.get(heartbeat.agentId);
    }

    if (!agent) {
      this.log(`Unknown agent heartbeat without registration info: ${heartbeat.agentId}`, 'debug');
      this.onAgentHeartbeat?.(heartbeat);
      return;
    }

    agent.lastHeartbeat = new Date();
    if (heartbeat.info) {
      agent.info = heartbeat.info;
    }
    agent.arms = heartbeat.activeArms;

    // Update arm -> agent mappings
    for (const armId of heartbeat.activeArms) {
      this.armToAgent.set(armId, heartbeat.agentId);
    }

    this.onAgentHeartbeat?.(heartbeat);
  }

  private handleArmEvent(event: OctopaiEvent): void {
    this.log(`Arm event: ${event.type}`, 'debug');

    // Track arm -> agent mapping from events
    if ('armId' in event && 'agentId' in event) {
      this.armToAgent.set(event.armId, event.agentId);
    }

    // Handle specific events
    if (event.type === 'arm.killed' && 'armId' in event) {
      this.armToAgent.delete(event.armId);
      
      // Remove from agent's arm list
      if ('agentId' in event) {
        const agent = this.agents.get(event.agentId);
        if (agent) {
          agent.arms = agent.arms.filter(id => id !== event.armId);
        }
      }
    }

    this.onArmEvent?.(event);
  }

  // ============================================
  // Heartbeat Monitoring
  // ============================================

  private startHeartbeatCheck(): void {
    const STALE_THRESHOLD_MS = 90000; // 90 seconds

    this.heartbeatCheckTimer = setInterval(() => {
      const now = Date.now();

      for (const [agentId, agent] of this.agents) {
        const msSinceHeartbeat = now - agent.lastHeartbeat.getTime();

        if (msSinceHeartbeat > STALE_THRESHOLD_MS) {
          this.log(`Agent ${agentId} is stale (${Math.round(msSinceHeartbeat / 1000)}s since last heartbeat)`);
          
          // Remove agent and its arms
          this.agents.delete(agentId);
          for (const armId of agent.arms) {
            this.armToAgent.delete(armId);
          }

          this.onAgentDisconnected?.(agentId);
        }
      }
    }, 30000);
  }

  // ============================================
  // Utility
  // ============================================

  private log(message: string, level: 'debug' | 'info' | 'error' = 'info'): void {
    if (!this.debug && level === 'debug') return;
    const prefix = '[ArmClient]';
    if (level === 'error') {
      console.error(prefix, message);
    } else {
      console.log(prefix, message);
    }
  }
}
