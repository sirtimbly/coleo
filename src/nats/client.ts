/**
 * NATS Client for Octopai
 * 
 * Provides typed pub/sub and request/reply patterns
 * for communication between API server and agents.
 */

import { connect, type NatsConnection, JSONCodec, type Subscription, type Msg } from 'nats';
import { 
  TOPICS, 
  type AgentCommand, 
  type CommandResponse,
  type AgentInfo,
  type AgentHeartbeat,
  type OctopaiEvent,
  type ArmState,
} from './types';

const jc = JSONCodec<unknown>();

export interface NatsClientOptions {
  serverUrl: string;
  clientId: string;
  debug?: boolean;
}

export class NatsClient {
  private connection: NatsConnection | null = null;
  private subscriptions: Subscription[] = [];
  private serverUrl: string;
  private clientId: string;
  private debug: boolean;
  private isConnected = false;

  constructor(options: NatsClientOptions) {
    this.serverUrl = options.serverUrl;
    this.clientId = options.clientId;
    this.debug = options.debug || false;
  }

  /**
   * Connect to the NATS server
   */
  async connect(): Promise<void> {
    if (this.isConnected) return;

    try {
      this.connection = await connect({
        servers: this.serverUrl,
        name: this.clientId,
      });

      this.isConnected = true;
      this.log('Connected to NATS server');

      // Handle disconnection
      (async () => {
        if (this.connection) {
          const done = this.connection.closed();
          const err = await done;
          if (err) {
            this.log(`Connection closed with error: ${err.message}`, 'error');
          } else {
            this.log('Connection closed');
          }
          this.isConnected = false;
        }
      })();
    } catch (err) {
      this.log(`Failed to connect: ${err}`, 'error');
      throw err;
    }
  }

  /**
   * Disconnect from the NATS server
   */
  async disconnect(): Promise<void> {
    // Unsubscribe from all subscriptions
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions = [];

    if (this.connection) {
      await this.connection.drain();
      await this.connection.close();
      this.connection = null;
    }

    this.isConnected = false;
    this.log('Disconnected from NATS server');
  }

  /**
   * Check if connected
   */
  connected(): boolean {
    return this.isConnected && this.connection !== null;
  }

  // ============================================
  // Publishing Methods
  // ============================================

  /**
   * Publish a message to a topic
   */
  async publish<T>(topic: string, data: T): Promise<void> {
    this.ensureConnected();
    this.connection!.publish(topic, jc.encode(data));
    this.log(`Published to ${topic}`, 'debug');
  }

  /**
   * Send a command to a specific agent and wait for response
   */
  async sendCommand<T>(agentId: string, command: AgentCommand, timeoutMs = 30000): Promise<CommandResponse<T>> {
    this.ensureConnected();

    const topic = TOPICS.agentCommand(agentId);
    const replyTopic = TOPICS.agentResponse(agentId, command.requestId);

    // Subscribe to response first
    const sub = this.connection!.subscribe(replyTopic, { max: 1 });
    
    // Publish command
    this.connection!.publish(topic, jc.encode(command));
    this.log(`Sent command ${command.type} to agent ${agentId}`, 'debug');

    // Wait for response with timeout
    try {
      for await (const msg of sub) {
        const response = jc.decode(msg.data) as CommandResponse<T>;
        return response;
      }
      throw new Error('No response received');
    } catch (err) {
      if ((err as Error).message.includes('timeout')) {
        return {
          requestId: command.requestId,
          success: false,
          error: `Command timed out after ${timeoutMs}ms`,
        };
      }
      throw err;
    }
  }

  /**
   * Register an agent with the system
   */
  async registerAgent(info: AgentInfo): Promise<void> {
    await this.publish(TOPICS.AGENT_REGISTER, info);
  }

  /**
   * Send agent heartbeat
   */
  async sendHeartbeat(heartbeat: AgentHeartbeat): Promise<void> {
    await this.publish(TOPICS.AGENT_HEARTBEAT, heartbeat);
  }

  /**
   * Publish an arm event
   */
  async publishArmEvent(armId: string, event: OctopaiEvent): Promise<void> {
    await this.publish(TOPICS.armEvent(armId), event);
    // Also publish to broadcast channel
    await this.publish(TOPICS.BROADCAST_ARMS, event);
  }

  // ============================================
  // Subscription Methods
  // ============================================

  /**
   * Subscribe to a topic with a handler
   */
  subscribe<T>(topic: string, handler: (data: T, msg: Msg) => void | Promise<void>): Subscription {
    this.ensureConnected();

    const sub = this.connection!.subscribe(topic);
    this.subscriptions.push(sub);

    (async () => {
      for await (const msg of sub) {
        try {
          const data = jc.decode(msg.data) as T;
          await handler(data, msg);
        } catch (err) {
          this.log(`Error handling message on ${topic}: ${err}`, 'error');
        }
      }
    })();

    this.log(`Subscribed to ${topic}`, 'debug');
    return sub;
  }

  /**
   * Subscribe to commands for this agent
   */
  subscribeToCommands(agentId: string, handler: (command: AgentCommand) => Promise<CommandResponse>): Subscription {
    const topic = TOPICS.agentCommand(agentId);
    
    return this.subscribe<AgentCommand>(topic, async (command, msg) => {
      const response = await handler(command);
      
      // Send response to the reply topic
      const replyTopic = TOPICS.agentResponse(agentId, command.requestId);
      await this.publish(replyTopic, response);
    });
  }

  /**
   * Subscribe to agent registrations
   */
  subscribeToAgentRegistrations(handler: (info: AgentInfo) => void | Promise<void>): Subscription {
    return this.subscribe(TOPICS.AGENT_REGISTER, handler);
  }

  /**
   * Subscribe to agent heartbeats
   */
  subscribeToAgentHeartbeats(handler: (heartbeat: AgentHeartbeat) => void | Promise<void>): Subscription {
    return this.subscribe(TOPICS.AGENT_HEARTBEAT, handler);
  }

  /**
   * Subscribe to all arm events
   */
  subscribeToArmEvents(handler: (event: OctopaiEvent) => void | Promise<void>): Subscription {
    return this.subscribe(TOPICS.BROADCAST_ARMS, handler);
  }

  /**
   * Subscribe to events for a specific arm
   */
  subscribeToArmEventsForArm(armId: string, handler: (event: OctopaiEvent) => void | Promise<void>): Subscription {
    return this.subscribe(TOPICS.armEvent(armId), handler);
  }

  // ============================================
  // Utility Methods
  // ============================================

  private ensureConnected(): void {
    if (!this.connection) {
      throw new Error('Not connected to NATS. Call connect() first.');
    }
  }

  private log(message: string, level: 'debug' | 'info' | 'error' = 'info'): void {
    if (!this.debug && level === 'debug') return;
    const prefix = `[NATS:${this.clientId}]`;
    if (level === 'error') {
      console.error(prefix, message);
    } else {
      console.log(prefix, message);
    }
  }
}

/**
 * Generate a unique request ID
 */
export function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
