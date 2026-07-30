import type { EventData, QueryOptions, StreamMetrics, IEventStore } from './jetstream-types';
import { getProjectScope } from '../project-scope';

export class InMemoryEventStore implements IEventStore {
  private events: Array<{ subject: string; data: EventData }> = [];
  private _initialized = false;

  initialize(): void {
    this._initialized = true;
  }

  clear(): void {
    this.events = [];
  }

  async publishEvent(subject: string, data: EventData): Promise<void> {
    const scope = getProjectScope();
    this.events.push({
      subject,
      data: {
        ...data,
        projectDir: scope.projectDir,
        projectKey: scope.projectKey,
        sequence: data.sequence ?? this.events.length + 1,
      },
    });
  }

  async queryEvents(options: QueryOptions): Promise<EventData[]> {
    let results = this.events.map(e => e.data);
    
    if (options.subject) {
      const pattern = options.subject
        .replace(/\./g, '\\.')
        .replace(/\*/g, '[^.]*')
        .replace(/>/g, '.*');
      const regex = new RegExp(`^${pattern}$`);
      results = this.events
        .filter(e => regex.test(e.subject))
        .map(e => e.data);
    }
    
    if (options.since) {
      results = results.filter(e => new Date(e.timestamp) >= options.since!);
    }
    if (options.until) {
      results = results.filter(e => new Date(e.timestamp) <= options.until!);
    }
    if (options.beforeSequence !== undefined) {
      results = results.filter(e => (e.sequence ?? 0) < options.beforeSequence!);
    }
    
    if (options.eventType) {
      results = results.filter(e => e.type === options.eventType);
    }
    
    const limit = options.limit ?? 100;
    return options.latest || options.beforeSequence !== undefined
      ? results.slice(-limit)
      : results.slice(0, limit);
  }

  async getArmEvents(armId: string, limit: number = 50, since?: Date): Promise<EventData[]> {
    return this.queryEvents({
      subject: `coleo.events.arm.${armId}.>`,
      limit,
      since,
      latest: true,
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
      latest: true,
    });
  }

  async getStreamMetrics(): Promise<StreamMetrics> {
    const messages = this.events.length;
    const subjects = Array.from(new Set(this.events.map(event => event.subject)));
    return {
      messages,
      bytes: 0,
      firstSequence: messages > 0 ? 1 : 0,
      lastSequence: messages,
      consumerCount: 0,
      subjects,
    };
  }

  isInitialized(): boolean {
    return this._initialized;
  }

  getAllEvents(): Array<{ subject: string; data: EventData }> {
    return [...this.events];
  }
}

export function createTestEventStore(): InMemoryEventStore {
  const store = new InMemoryEventStore();
  store.initialize();
  return store;
}
