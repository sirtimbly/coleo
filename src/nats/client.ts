/**
 * NATS Client for Octopai
 * 
 * Provides typed pub/sub and request/reply patterns
 * for communication between API server and agents.
 */

import { type NatsConnection, JSONCodec, type Subscription, type Msg, type JetStreamClient } from 'nats';
import { connectToNats } from './transport';
import {
  TOPICS,
  type AgentCommand,
  type CommandResponse,
  type AgentInfo,
  type AgentHeartbeat,
  type OctopaiEvent,
  type ArmState,
  type BrainMessage,
} from './types';
import { commandSubjectForEnvelope, type CommandEnvelope } from './command-types';
import { ensureCommandStream } from './command-stream';
import { initializeJetStreamEventStore } from './jetstream';

const jc = JSONCodec<unknown>();

export interface NatsClientOptions {
  serverUrl: string;
  clientId: string;
  token?: string;
  debug?: boolean;
}

class PayloadTooLargeError extends Error {
  readonly topic: string;
  readonly payloadBytes: number;
  readonly maxPayloadBytes: number;

  constructor(topic: string, payloadBytes: number, maxPayloadBytes: number) {
    super(
      `Payload for ${topic} is ${payloadBytes} bytes, which exceeds NATS max payload ${maxPayloadBytes} bytes`,
    );
    this.name = 'PayloadTooLargeError';
    this.topic = topic;
    this.payloadBytes = payloadBytes;
    this.maxPayloadBytes = maxPayloadBytes;
  }
}

export class NatsClient {
  private connection: NatsConnection | null = null;
  private subscriptions: Subscription[] = [];
  private serverUrl: string;
  private clientId: string;
  private token?: string;
  private debug: boolean;
  private isConnected = false;
  private jetStream: JetStreamClient | null = null;

  constructor(options: NatsClientOptions) {
    this.serverUrl = options.serverUrl;
    this.clientId = options.clientId;
    this.token = options.token;
    this.debug = options.debug || false;
  }

  /**
   * Connect to the NATS server
   */
  async connect(): Promise<void> {
    if (this.isConnected) return;

    try {
      this.connection = await connectToNats({
        servers: this.serverUrl,
        name: this.clientId,
        token: this.token,
        timeout: 5000,
        reconnect: true,
        maxReconnectAttempts: -1,
        reconnectTimeWait: 1000,
      });

      this.isConnected = true;
      this.jetStream = this.connection.jetstream();
      this.log('Connected to NATS server');

      // Track transient disconnect/reconnect state for callers relying on connected().
      (async () => {
        if (!this.connection) return;
        for await (const status of this.connection.status()) {
          if (status.type === 'disconnect' || status.type === 'error') {
            this.isConnected = false;
            this.log(`NATS status: ${status.type}`, 'debug');
          } else if (status.type === 'reconnect') {
            this.isConnected = true;
            this.log('NATS status: reconnect', 'debug');
          }
        }
      })();

      // Initialize JetStream EventStore
      try {
        const js = this.jetStream;
        if (!js) {
          throw new Error('JetStream client unavailable');
        }
        const jsm = await this.connection.jetstreamManager();
        await initializeJetStreamEventStore(js, jsm);
        this.log('JetStream EventStore initialized');
      } catch (err) {
        this.log(`Failed to initialize JetStream: ${err}`, 'error');
      }

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
   * @param timeoutMs Maximum time to wait for drain (default 2000ms)
   */
  async disconnect(timeoutMs = 2000): Promise<void> {
    // Unsubscribe from all subscriptions first
    for (const sub of this.subscriptions) {
      try {
        sub.unsubscribe();
      } catch {
        // Ignore errors during unsubscribe
      }
    }
    this.subscriptions = [];

    if (this.connection) {
      try {
        // Use a race between drain and timeout for graceful shutdown
        // If drain takes too long, force close
        const drainPromise = this.connection.drain();
        const timeoutPromise = new Promise<'timeout'>((resolve) => {
          setTimeout(() => resolve('timeout'), timeoutMs);
        });
        
        const result = await Promise.race([drainPromise, timeoutPromise]);
        
        if (result === 'timeout') {
          this.log('NATS drain timed out, forcing close');
        }
      } catch (err) {
        // Drain may fail if connection is already closed
        this.log(`NATS drain error (expected during shutdown): ${err}`, 'debug');
      }
      
      try {
        await this.connection.close();
      } catch {
        // Ignore close errors
      }
      this.connection = null;
      this.jetStream = null;
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
    const payload = this.encodePayload(topic, data);
    this.connection!.publish(topic, payload);
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

    // Wait for response with timeout
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const payload = this.encodePayload(topic, command);
      this.connection!.publish(topic, payload);
      this.log(`Sent command ${command.type} to agent ${agentId}`, 'debug');

      const responsePromise = (async (): Promise<CommandResponse<T>> => {
        const iterator = sub[Symbol.asyncIterator]();
        const result = await iterator.next();
        if (result.done || !result.value) {
          return {
            requestId: command.requestId,
            success: false,
            error: 'No response received',
          };
        }
        return jc.decode(result.value.data) as CommandResponse<T>;
      })();

      const timeoutPromise = new Promise<CommandResponse<T>>((resolve) => {
        timeoutHandle = setTimeout(() => {
          resolve({
            requestId: command.requestId,
            success: false,
            error: `Command timed out after ${timeoutMs}ms`,
          });
        }, timeoutMs);
      });

      return await Promise.race([responsePromise, timeoutPromise]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        requestId: command.requestId,
        success: false,
        error: `Command failed: ${message}`,
      };
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      try {
        sub.unsubscribe();
      } catch {
        // Ignore cleanup errors.
      }
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

   /**
   * Publish a message to the brain
   */
   async publishBrainMessage(message: BrainMessage): Promise<void> {
     await this.publish(TOPICS.BRAIN_MESSAGES, message);
   }

  /**
   * Publish a command envelope to the JetStream command stream.
   */
  async publishCommandEnvelope(envelope: CommandEnvelope): Promise<void> {
    this.ensureConnected();
    if (!this.jetStream) {
      throw new Error('JetStream is not initialized');
    }
    await ensureCommandStream(this.connection!);

    const subject = commandSubjectForEnvelope(envelope);
    const payload = this.encodePayload(subject, envelope);
    await this.jetStream.publish(subject, payload, { msgID: envelope.id });
    this.log(`Published command envelope to ${subject}`, 'debug');
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
    
    return this.subscribe<AgentCommand>(topic, async (command) => {
      const response = await handler(command);
      
      // Send response to the reply topic
      const replyTopic = TOPICS.agentResponse(agentId, command.requestId);
      try {
        await this.publish(replyTopic, response);
      } catch (err) {
        if (!this.isMaxPayloadError(err)) {
          throw err;
        }

        this.log(
          `Response for command ${command.type} exceeded NATS payload limit; sending compact error response`,
          'error',
        );

        const fallbackResponse: CommandResponse = {
          requestId: command.requestId,
          success: false,
          error:
            command.type === 'get_messages'
              ? 'Response too large for NATS. Retry with a smaller messages limit.'
              : 'Response too large for NATS.',
        };

        try {
          await this.publish(replyTopic, fallbackResponse);
        } catch (fallbackErr) {
          this.log(
            `Failed to publish compact fallback response for ${command.type}: ${fallbackErr}`,
            'error',
          );
        }
      }
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

  private getMaxPayloadBytes(): number | null {
    const maxPayload = this.connection?.info?.max_payload;
    if (typeof maxPayload === 'number' && Number.isFinite(maxPayload) && maxPayload > 0) {
      return maxPayload;
    }
    return null;
  }

  private encodePayload(topic: string, data: unknown): Uint8Array {
    const payload = jc.encode(data);
    const maxPayload = this.getMaxPayloadBytes();
    if (maxPayload !== null && payload.length > maxPayload) {
      throw new PayloadTooLargeError(topic, payload.length, maxPayload);
    }
    return payload;
  }

  private isMaxPayloadError(err: unknown): boolean {
    if (err instanceof PayloadTooLargeError) {
      return true;
    }
    if (err instanceof Error) {
      return err.message.includes('MAX_PAYLOAD_EXCEEDED');
    }
    return false;
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
