import { RetentionPolicy, StorageType, DeliverPolicy, AckPolicy, ReplayPolicy } from 'nats';
import type {
  JetStreamClient,
  JetStreamManager,
  ConsumerConfig,
  ConsumerInfo,
} from 'nats';
import type {
  EventData,
  QueryOptions,
  StateReconstructionOptions,
  StreamMetrics,
  TaskState,
  ArmState,
  IEventStore,
} from './jetstream-types';

export type {
  EventData,
  QueryOptions,
  StateReconstructionOptions,
  StreamMetrics,
  TaskState,
  ArmState,
  IEventStore,
};

export class EventStore implements IEventStore {
  private js: JetStreamClient | null = null;
  private jsm: JetStreamManager | null = null;
  private initialized = false;

  async initialize(js: JetStreamClient, jsm: JetStreamManager): Promise<void> {
    this.js = js;
    this.jsm = jsm;

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

  private async ensureEventStream(): Promise<void> {
    if (!this.jsm) throw new Error('JetStream manager not initialized');

    const streamConfig = {
      name: 'coleo-events',
      subjects: [
        'coleo.events.arm.>',
        'coleo.events.brain.>',
        'coleo.events.task.>',
        'coleo.events.api.>',
        'coleo.events.mail.>',
        'coleo.events.mcp.>',
        'coleo.events.system.>',
      ],
      retention: RetentionPolicy.Limits,
      max_age: 7 * 24 * 60 * 60 * 1000,
      max_msgs: 100000,
      max_bytes: 500 * 1024 * 1024,
      storage: StorageType.File,
      allow_rollup_hdrs: true,
    };

    try {
      const existingStream = await this.jsm.streams.info('coleo-events');
      const existingSubjects = existingStream.config.subjects || [];
      const expectedSubjects = streamConfig.subjects;

      if (JSON.stringify(existingSubjects) !== JSON.stringify(expectedSubjects)) {
        console.log(`[EventStore] Updating stream subjects from ${existingSubjects} to ${expectedSubjects}`);
        await this.jsm.streams.update('coleo-events', {
          ...existingStream.config,
          subjects: expectedSubjects,
        });
        console.log('[EventStore] Updated coleo-events stream configuration');
      }
    } catch {
      await this.jsm.streams.add(streamConfig);
      console.log('[EventStore] Created coleo-events stream');
    }
  }

  async publishEvent(subject: string, data: EventData): Promise<void> {
    if (!this.js) throw new Error('JetStream client not initialized');
    const payload = JSON.stringify(data);
    await this.js.publish(subject, payload);
  }

  async queryEvents(options: QueryOptions): Promise<EventData[]> {
    if (!this.js || !this.jsm) {
      console.log('[EventStore] JetStream not initialized, cannot query events');
      return [];
    }

    const events: EventData[] = [];
    const limit = options.limit ?? 100;

    try {
      let filterSubject = options.subject ?? 'coleo.events.>';

      const consumer = await this.js.consumers.get('coleo-events', {
        filterSubjects: [filterSubject],
      });

      const messages = await consumer.fetch({ max_messages: limit, expires: 5000 });

      for await (const msg of messages) {
        try {
          const data = JSON.parse(msg.string()) as EventData;

          if (options.since) {
            const eventTime = new Date(data.timestamp);
            if (eventTime < options.since) continue;
          }
          if (options.until) {
            const eventTime = new Date(data.timestamp);
            if (eventTime > options.until) continue;
          }

          if (options.eventType && data.type !== options.eventType) continue;

          events.push(data);

          if (events.length >= limit) break;
        } catch {
        }
      }
    } catch (err) {
      console.error('[EventStore] Failed to query events:', err);
    }

    return events;
  }

  async getArmEvents(armId: string, limit: number = 50): Promise<EventData[]> {
    return this.queryEvents({
      subject: `coleo.events.arm.${armId}.>`,
      limit,
    });
  }

  async getEventsByType(eventType: string, limit: number = 50): Promise<EventData[]> {
    return this.queryEvents({
      eventType,
      limit,
    });
  }

  async getRecentEvents(limit: number = 50, since?: Date): Promise<EventData[]> {
    return this.queryEvents({
      limit,
      since,
    });
  }

  async getStreamMetrics(): Promise<StreamMetrics> {
    if (!this.jsm) throw new Error('JetStream manager not initialized');

    const streamInfo = await this.jsm.streams.info('coleo-events');

    return {
      messages: streamInfo.state.messages,
      bytes: streamInfo.state.bytes,
      firstSequence: streamInfo.state.first_seq,
      lastSequence: streamInfo.state.last_seq,
      consumerCount: streamInfo.state.consumer_count,
      subjects: streamInfo.config.subjects || [],
    };
  }

  async getEventTypes(): Promise<string[]> {
    const events = await this.queryEvents({
      limit: 1000,
    });

    const eventTypes = new Set<string>();
    events.forEach(event => {
      if (event.type) eventTypes.add(event.type);
    });

    return Array.from(eventTypes).sort();
  }

  async createDurableConsumer(
    name: string,
    config: Partial<ConsumerConfig>
  ): Promise<ConsumerInfo> {
    if (!this.jsm) throw new Error('JetStream manager not initialized');

    const defaultConfig = {
      durable_name: name,
      deliver_policy: DeliverPolicy.Last,
      ack_policy: AckPolicy.None,
      filter_subject: 'coleo.events.>',
      replay_policy: ReplayPolicy.Instant,
      ...config,
    };

    return await this.jsm.consumers.add('coleo-events', defaultConfig as ConsumerConfig);
  }

  async deleteConsumer(name: string): Promise<void> {
    if (!this.jsm) throw new Error('JetStream manager not initialized');

    try {
      await this.jsm.consumers.delete('coleo-events', name);
    } catch (err) {
      console.error(`[EventStore] Failed to delete consumer ${name}:`, err);
    }
  }

  async cleanupOldEvents(): Promise<void> {
    if (!this.jsm) throw new Error('JetStream manager not initialized');
    const streamInfo = await this.jsm.streams.info('coleo-events');
    console.log(`[EventStore] Stream has ${streamInfo.state.messages} messages, ${streamInfo.state.bytes} bytes`);
  }

  async reconstructTaskState(taskId: string, options?: StateReconstructionOptions): Promise<TaskState> {
    const events = await this.queryEvents({
      subject: `coleo.events.task.${taskId}.*`,
      limit: options?.maxEvents || 1000,
    });

    const state: TaskState = {
      id: taskId,
      status: 'pending',
      createdAt: new Date().toISOString(),
      subject: `Task ${taskId}`,
    };

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

  async reconstructArmState(armId: string, options?: StateReconstructionOptions): Promise<ArmState> {
    const events = await this.queryEvents({
      subject: `coleo.events.arm.${armId}.*`,
      limit: options?.maxEvents || 500,
    });

    const state: ArmState = {
      id: armId,
      status: 'idle',
    };

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
          state.status = (event.data.to ?? event.data.newStatus) as ArmState['status'];
          if (event.data.taskId) {
            state.currentTaskId = event.data.taskId as string;
          }
          break;

        case 'arm.heartbeat':
          state.lastHeartbeat = event.timestamp;
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

    if (state.lastHeartbeat) {
      const lastHeartbeat = new Date(state.lastHeartbeat).getTime();
      const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
      if (lastHeartbeat < fiveMinutesAgo && state.status !== 'stopped') {
        state.status = 'stale';
      }
    }

    return state;
  }

  async getArmActivitySummary(armId: string, since: Date): Promise<{
    messageCount: number;
    toolUsage: number;
    fileChanges: number;
    errors: number;
    lastActivity: string | null;
  }> {
    const events = await this.queryEvents({
      subject: `coleo.events.arm.${armId}.*`,
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

  isInitialized(): boolean {
    return this.initialized && this.js !== null && this.jsm !== null;
  }
}
