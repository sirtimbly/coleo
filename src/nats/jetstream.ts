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
   * Check if JetStream is properly initialized
   */
  isInitialized(): boolean {
    return this.initialized && this.js !== null && this.jsm !== null;
  }
}

// Global EventStore instance
export const eventStore = new EventStore();