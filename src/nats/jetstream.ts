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

    // Retry stream creation in case JetStream isn't ready immediately
    let retries = 3;
    while (retries > 0) {
      try {
        await this.ensureEventStream();
        this.initialized = true;
        console.log('[EventStore] Successfully initialized JetStream');
        return;
      } catch (err) {
        retries--;
        if (retries > 0) {
          console.log(`[EventStore] JetStream not ready, retrying in 2s... (${retries} retries left)`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
          console.error('[EventStore] Failed to initialize JetStream after retries:', err);
          this.initialized = false;
        }
      }
    }
  }

  /**
   * Ensure the main event stream exists with proper configuration
   */
  private async ensureEventStream(): Promise<void> {
    if (!this.jsm) throw new Error('JetStream manager not initialized');

    const streamConfig = {
      name: 'octopai-events',
      // Capture all event types: arm, brain, and task events
      subjects: [
        'octopai.events.arm.>',
        'octopai.events.brain.>',
        'octopai.events.task.>',
      ],
      retention: RetentionPolicy.Limits,
      max_age: 7 * 24 * 60 * 60 * 1000,  // 7 days
      max_msgs: 100000,                   // 100K events
      max_bytes: 500 * 1024 * 1024,      // 500MB
      storage: StorageType.File,
      allow_rollup_hdrs: true,           // Allow rollup headers for compaction
    };

    try {
      // Check if stream exists
      const existingStream = await this.jsm.streams.info('octopai-events');
      
      // Check if subjects need updating (e.g., from old '*.*' pattern to new '>' pattern)
      const existingSubjects = existingStream.config.subjects || [];
      const expectedSubjects = streamConfig.subjects;
      
      if (JSON.stringify(existingSubjects) !== JSON.stringify(expectedSubjects)) {
        console.log(`[EventStore] Updating stream subjects from ${existingSubjects} to ${expectedSubjects}`);
        await this.jsm.streams.update('octopai-events', {
          ...existingStream.config,
          subjects: expectedSubjects,
        });
        console.log('[EventStore] Updated octopai-events stream configuration');
      }
    } catch (error) {
      // Stream doesn't exist, create it
      await this.jsm.streams.add(streamConfig);
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
   * Query events from the stream using an ephemeral consumer
   */
  async queryEvents(options: QueryOptions): Promise<EventData[]> {
    if (!this.js || !this.jsm) {
      console.log('[EventStore] JetStream not initialized, cannot query events');
      return [];
    }

    const events: EventData[] = [];
    const limit = options.limit ?? 100;
    
    try {
      // Determine the filter subject
      let filterSubject = options.subject ?? 'octopai.events.>';
      
      // Create an ephemeral ordered consumer for querying
      const consumer = await this.js.consumers.get('octopai-events', {
        filterSubjects: [filterSubject],
      });

      // Fetch messages
      const messages = await consumer.fetch({ max_messages: limit, expires: 5000 });
      
      for await (const msg of messages) {
        try {
          const data = JSON.parse(msg.string()) as EventData;
          
          // Apply time filters if specified
          if (options.since) {
            const eventTime = new Date(data.timestamp);
            if (eventTime < options.since) continue;
          }
          if (options.until) {
            const eventTime = new Date(data.timestamp);
            if (eventTime > options.until) continue;
          }
          
          // Apply event type filter if specified
          if (options.eventType && data.type !== options.eventType) continue;
          
          events.push(data);
          
          if (events.length >= limit) break;
        } catch {
          // Skip malformed messages
        }
      }
    } catch (err) {
      console.error('[EventStore] Failed to query events:', err);
    }

    return events;
  }

  /**
   * Get recent events for a specific arm
   */
  async getArmEvents(armId: string, limit: number = 50): Promise<EventData[]> {
    return this.queryEvents({
      subject: `octopai.events.arm.${armId}.>`,
      limit,
    });
  }

  /**
   * Get recent events of a specific type across all arms
   */
  async getEventsByType(eventType: string, limit: number = 50): Promise<EventData[]> {
    return this.queryEvents({
      eventType,
      limit,
    });
  }

  /**
   * Get all recent events (for activity feed)
   */
  async getRecentEvents(limit: number = 50, since?: Date): Promise<EventData[]> {
    return this.queryEvents({
      limit,
      since,
    });
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
      filter_subject: 'octopai.events.>',  // Match all event types: arm, brain, task
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

/**
 * Interface for EventStore implementations
 * Used to allow dependency injection for testing
 */
export interface IEventStore {
  publishEvent(subject: string, data: EventData): Promise<void>;
  queryEvents(options: QueryOptions): Promise<EventData[]>;
  getArmEvents(armId: string, limit?: number): Promise<EventData[]>;
  getEventsByType(eventType: string, limit?: number): Promise<EventData[]>;
  getRecentEvents(limit?: number, since?: Date): Promise<EventData[]>;
  isInitialized(): boolean;
}

/**
 * In-memory EventStore for testing
 * Stores events in memory without requiring NATS/JetStream
 */
export class InMemoryEventStore implements IEventStore {
  private events: Array<{ subject: string; data: EventData }> = [];
  private _initialized = false;

  /**
   * Initialize the in-memory store (always succeeds)
   */
  initialize(): void {
    this._initialized = true;
  }

  /**
   * Clear all events (useful between tests)
   */
  clear(): void {
    this.events = [];
  }

  /**
   * Publish an event to the in-memory store
   */
  async publishEvent(subject: string, data: EventData): Promise<void> {
    this.events.push({ subject, data });
  }

  /**
   * Query events from the in-memory store
   */
  async queryEvents(options: QueryOptions): Promise<EventData[]> {
    let results = this.events.map(e => e.data);
    
    // Apply subject filter
    if (options.subject) {
      const pattern = options.subject.replace(/>/g, '.*').replace(/\*/g, '[^.]*');
      const regex = new RegExp(`^${pattern}$`);
      results = this.events
        .filter(e => regex.test(e.subject))
        .map(e => e.data);
    }
    
    // Apply time filters
    if (options.since) {
      results = results.filter(e => new Date(e.timestamp) >= options.since!);
    }
    if (options.until) {
      results = results.filter(e => new Date(e.timestamp) <= options.until!);
    }
    
    // Apply event type filter
    if (options.eventType) {
      results = results.filter(e => e.type === options.eventType);
    }
    
    // Apply limit
    const limit = options.limit ?? 100;
    return results.slice(0, limit);
  }

  /**
   * Get recent events for a specific arm
   */
  async getArmEvents(armId: string, limit: number = 50): Promise<EventData[]> {
    return this.queryEvents({
      subject: `octopai.events.arm.${armId}.>`,
      limit,
    });
  }

  /**
   * Get recent events of a specific type across all arms
   */
  async getEventsByType(eventType: string, limit: number = 50): Promise<EventData[]> {
    return this.queryEvents({
      eventType,
      limit,
    });
  }

  /**
   * Get all recent events (for activity feed)
   */
  async getRecentEvents(limit: number = 50, since?: Date): Promise<EventData[]> {
    return this.queryEvents({
      limit,
      since,
    });
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this._initialized;
  }

  /**
   * Get all events (for debugging/assertions in tests)
   */
  getAllEvents(): Array<{ subject: string; data: EventData }> {
    return [...this.events];
  }
}

// Global EventStore instance (can be swapped for testing)
let _eventStore: IEventStore = new EventStore();

/**
 * Get the current event store instance
 */
export const eventStore: IEventStore = {
  get publishEvent() { return _eventStore.publishEvent.bind(_eventStore); },
  get queryEvents() { return _eventStore.queryEvents.bind(_eventStore); },
  get getArmEvents() { return _eventStore.getArmEvents.bind(_eventStore); },
  get getEventsByType() { return _eventStore.getEventsByType.bind(_eventStore); },
  get getRecentEvents() { return _eventStore.getRecentEvents.bind(_eventStore); },
  get isInitialized() { return _eventStore.isInitialized.bind(_eventStore); },
};

/**
 * Set a custom event store (for testing)
 */
export function setEventStore(store: IEventStore): void {
  _eventStore = store;
}

/**
 * Reset to the default JetStream-backed event store
 */
export function resetEventStore(): void {
  _eventStore = new EventStore();
}

/**
 * Initialize the JetStream-backed event store
 * Called by NATS client when JetStream is available
 */
export async function initializeJetStreamEventStore(
  js: JetStreamClient,
  jsm: JetStreamManager
): Promise<void> {
  // Ensure we're using the real EventStore, not a test mock
  if (!(_eventStore instanceof EventStore)) {
    _eventStore = new EventStore();
  }
  await (_eventStore as EventStore).initialize(js, jsm);
}

/**
 * Create and configure an in-memory event store for testing
 */
export function createTestEventStore(): InMemoryEventStore {
  const store = new InMemoryEventStore();
  store.initialize();
  return store;
}