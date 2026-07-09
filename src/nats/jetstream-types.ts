import type { JetStreamClient, JetStreamManager } from 'nats';

export interface EventData {
  type: string;
  armId?: string;
  sessionId?: string;
  data: Record<string, unknown>;
  timestamp: string;
}

export interface QueryOptions {
  subject?: string;
  subjects?: string[];
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

export interface IEventStore {
  publishEvent(subject: string, data: EventData): Promise<void>;
  queryEvents(options: QueryOptions): Promise<EventData[]>;
  getArmEvents(armId: string, limit?: number): Promise<EventData[]>;
  getEventsByType(eventType: string, limit?: number): Promise<EventData[]>;
  getRecentEvents(limit?: number, since?: Date): Promise<EventData[]>;
  getStreamMetrics(): Promise<StreamMetrics>;
  isInitialized(): boolean;
}

export interface IEventStoreInternal extends IEventStore {
  initialize(js: JetStreamClient, jsm: JetStreamManager): Promise<void>;
}
