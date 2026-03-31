export type EventCallback = (event: OpenCodeEvent) => void;

export interface OpenCodeEvent {
  type: string;
  properties: Record<string, unknown>;
}

export interface EventStreamOptions {
  serverUrl: string;
  armId: string;
  sessionId: string;
  onEvent: EventCallback;
  onError?: (error: Error) => void;
  onClose?: () => void;
}

export interface PersistenceCheckResult {
  shouldPersist: boolean;
  reason: string;
  tokenData?: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
  };
  fileChanges?: string[];
  messageData?: {
    messageId: string;
    role: string;
    modelId?: string;
    providerId?: string;
    agent?: string;
    completedAt: number;
  };
}
