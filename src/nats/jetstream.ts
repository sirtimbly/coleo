/**
 * JetStream Event Store for Octopai
 *
 * Provides event sourcing capabilities using NATS JetStream:
 * - Event publishing with guaranteed delivery
 * - Event querying with time-based and subject-based filtering
 * - State reconstruction from event streams
 * - Stream management and monitoring
 */

import { RetentionPolicy, StorageType, DeliverPolicy, AckPolicy, ReplayPolicy } from 'nats';
import type {
  JetStreamClient,
  JetStreamManager,
  JetStreamPublishOptions,
  ConsumerConfig,
  ConsumerInfo,
  StreamInfo,
  Msg,
} from 'nats';

export interface EventData {
  type: string;
  armId?: string;
  sessionId?: string;
  data: Record<string, unknown>;
  timestamp: string;
}

export interface QueryOptions {
  subject?: string;
  subjects?: string[]; // Multiple subject patterns
  limit?: number;
  since?: Date;
  until?: Date;
  eventType?: string;
}

export interface StateReconstructionOptions {
  includeDeleted?: boolean;
  maxEvents?: number;
}

export interface StreamMetrics {
  messages: number;
  bytes: number;
  firstSequence: number;
  lastSequence: number;
  consumerCount: number;
  subjects: string[];
}

// State reconstruction types
export interface TaskState {
  id: string;
  status: 'pending' | 'claimed' | 'in_progress' | 'completed' | 'blocked' | 'failed';
  assignedTo?: string;
  claimedAt?: string;
  completedAt?: string;
  blockedReason?: string;
  createdAt: string;
  subject: string;
}

export interface ArmState {
  id: string;
  status: 'idle' | 'busy' | 'starting' | 'stopped' | 'stale';
  currentTaskId?: string;
  sessionId?: string;
  lastHeartbeat?: string;
  startedAt?: string;
  harness?: string;
}

export class EventStore {
  private js: JetStreamClient | null = null;
  private jsm: JetStreamManager | null = null;
  private initialized = false;

  /**
   * Initialize the EventStore with a NATS JetStream client
   */
  async initialize(js: JetStreamClient, jsm: JetStreamManager): Promise<void> {
    this.js = js;
    this.jsm = jsm;
    this.initialized = true;

    // Ensure the main event stream exists
    await this.ensureEventStream();
  }

  /**
   * Ensure the main event stream exists with proper configuration
   */
  private async ensureEventStream(): Promise<void> {
    if (!this.jsm) throw new Error('JetStream manager not initialized');

    try {
      // Check if stream exists
      await this.jsm.streams.info('octopai-events');
    } catch (error) {
      // Stream doesn't exist, create it
      await this.jsm.streams.add({
        name: 'octopai-events',
        subjects: ['octopai.events.arm.*.*'],
        retention: RetentionPolicy.Limits,
        max_age: 7 * 24 * 60 * 60 * 1000,  // 7 days
        max_msgs: 100000,                   // 100K events
        max_bytes: 500 * 1024 * 1024,      // 500MB
        storage: StorageType.File,
        allow_rollup_hdrs: true,           // Allow rollup headers for compaction
      });

      console.log('[EventStore] Created octopai-events stream');
    }
  }

  /**
   * Publish an event to the stream
   */
  async publishEvent(subject: string, data: EventData): Promise<void> {
    if (!this.js) throw new Error('JetStream client not initialized');

    const payload = JSON.stringify(data);
    await this.js.publish(subject, payload);
  }

  /**
   * Query events from the stream
   * TODO: Implement proper JetStream querying with consumers
   */
  async queryEvents(options: QueryOptions): Promise<EventData[]> {
    // Temporary implementation - return empty array
    // Will be implemented with proper JetStream consumer API
    console.log('[EventStore] queryEvents called with options:', options);
    return [];
  }

  /**
   * Get stream metrics and information
   */
  async getStreamMetrics(): Promise<StreamMetrics> {
    if (!this.jsm) throw new Error('JetStream manager not initialized');

    const streamInfo = await this.jsm.streams.info('octopai-events');

    return {
      messages: streamInfo.state.messages,
      bytes: streamInfo.state.bytes,
      firstSequence: streamInfo.state.first_seq,
      lastSequence: streamInfo.state.last_seq,
      consumerCount: streamInfo.state.consumer_count,
      subjects: streamInfo.config.subjects || [],
    };
  }

  /**
   * Get all available event types in the stream
   */
  async getEventTypes(): Promise<string[]> {
    const events = await this.queryEvents({
      limit: 1000, // Sample recent events
    });

    const eventTypes = new Set<string>();
    events.forEach(event => {
      if (event.type) eventTypes.add(event.type);
    });

    return Array.from(eventTypes).sort();
  }

  /**
   * Create a durable consumer for real-time event streaming
   */
  async createDurableConsumer(
    name: string,
    config: Partial<ConsumerConfig>
  ): Promise<ConsumerInfo> {
    if (!this.jsm) throw new Error('JetStream manager not initialized');

    const defaultConfig = {
      durable_name: name,
      deliver_policy: DeliverPolicy.Last,
      ack_policy: AckPolicy.None,
      filter_subject: 'octopai.events.arm.*.*',
      replay_policy: ReplayPolicy.Instant,
      ...config,
    };

    return await this.jsm.consumers.add('octopai-events', defaultConfig as ConsumerConfig);
  }

  /**
   * Delete a consumer
   */
  async deleteConsumer(name: string): Promise<void> {
    if (!this.jsm) throw new Error('JetStream manager not initialized');

    try {
      await this.jsm.consumers.delete('octopai-events', name);
    } catch (err) {
      console.error(`[EventStore] Failed to delete consumer ${name}:`, err);
    }
  }

  /**
   * Clean up old events beyond retention policy
   */
  async cleanupOldEvents(): Promise<void> {
    if (!this.jsm) throw new Error('JetStream manager not initialized');

    // JetStream handles retention automatically, but we can force cleanup
    const streamInfo = await this.jsm.streams.info('octopai-events');
    console.log(`[EventStore] Stream has ${streamInfo.state.messages} messages, ${streamInfo.state.bytes} bytes`);
  }

  /**
   * Reconstruct task state from event stream
   */
  async reconstructTaskState(taskId: string, options?: StateReconstructionOptions): Promise<TaskState> {
    const events = await this.queryEvents({
      subject: `octopai.events.task.${taskId}.*`,
      limit: options?.maxEvents || 1000,
    });

    // Default state
    const state: TaskState = {
      id: taskId,
      status: 'pending',
      createdAt: new Date().toISOString(),
      subject: `Task ${taskId}`, // Will be overridden by events
    };

    // Apply events in chronological order
    for (const event of events.sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    )) {
      switch (event.type) {
        case 'task.created':
          state.createdAt = event.timestamp;
          state.subject = (event.data.subject as string) || state.subject;
          break;

        case 'task.assigned':
          state.assignedTo = event.data.armId as string;
          if (state.status === 'pending') {
            state.status = 'claimed';
          }
          break;

        case 'task.claimed':
          state.status = 'in_progress';
          state.claimedAt = event.timestamp;
          break;

        case 'task.completed':
          state.status = 'completed';
          state.completedAt = event.timestamp;
          break;

        case 'task.blocked':
          state.status = 'blocked';
          state.blockedReason = event.data.reason as string;
          break;

        case 'task.failed':
          state.status = 'failed';
          break;
      }
    }

    return state;
  }

  /**
   * Reconstruct arm state from event stream
   */
  async reconstructArmState(armId: string, options?: StateReconstructionOptions): Promise<ArmState> {
    const events = await this.queryEvents({
      subject: `octopai.events.arm.${armId}.*`,
      limit: options?.maxEvents || 500,
    });

    // Default state
    const state: ArmState = {
      id: armId,
      status: 'idle', // Default to idle, will be updated by events
    };

    // Apply events in chronological order
    for (const event of events.sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    )) {
      switch (event.type) {
        case 'arm.spawned':
          state.status = 'idle';
          state.startedAt = event.timestamp;
          state.harness = event.data.harness as string;
          state.sessionId = event.data.sessionId as string;
          break;

        case 'arm.status_changed':
          state.status = event.data.to as ArmState['status'];
          if (event.data.taskId) {
            state.currentTaskId = event.data.taskId as string;
          }
          break;

        case 'arm.heartbeat':
          state.lastHeartbeat = event.timestamp;
          // Mark as not stale if recent heartbeat
          if (state.status === 'stale') {
            state.status = 'idle';
          }
          break;

        case 'arm.killed':
        case 'arm.stopped':
          state.status = 'stopped';
          break;
      }
    }

    // Check if arm is stale (no heartbeat in last 5 minutes)
    if (state.lastHeartbeat) {
      const lastHeartbeat = new Date(state.lastHeartbeat).getTime();
      const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
      if (lastHeartbeat < fiveMinutesAgo && state.status !== 'stopped') {
        state.status = 'stale';
      }
    }

    return state;
  }

  /**
   * Get activity summary for an arm over a time period
   */
  async getArmActivitySummary(armId: string, since: Date): Promise<{
    messageCount: number;
    toolUsage: number;
    fileChanges: number;
    errors: number;
    lastActivity: string | null;
  }> {
    const events = await this.queryEvents({
      subject: `octopai.events.arm.${armId}.*`,
      since,
    });

    const summary = {
      messageCount: 0,
      toolUsage: 0,
      fileChanges: 0,
      errors: 0,
      lastActivity: null as string | null,
    };

    for (const event of events) {
      if (event.timestamp > (summary.lastActivity || '')) {
        summary.lastActivity = event.timestamp;
      }

      // Categorize events
      if (event.type.startsWith('message.')) {
        summary.messageCount++;
      } else if (event.type.startsWith('tool.')) {
        summary.toolUsage++;
      } else if (event.type.startsWith('file.')) {
        summary.fileChanges++;
      } else if (event.type.includes('error') || event.type.includes('failed')) {
        summary.errors++;
      }
    }

    return summary;
  }

  /**
   * Check if JetStream is properly initialized
   */
  isInitialized(): boolean {
    return this.initialized && this.js !== null && this.jsm !== null;
  }
}

// Global EventStore instance
export const eventStore = new EventStore();