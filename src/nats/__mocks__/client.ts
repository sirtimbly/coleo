/**
 * Mock NATS Client for Testing
 * 
 * Provides a mock implementation of NatsClient that:
 * - Tracks published messages in memory
 * - Supports subscription callbacks
 * - No actual network connections required
 */

import type { BrainMessage } from "../types";
import type { CommandEnvelope } from "../command-types";

interface MockSubscription {
  topic: string;
  handler: (data: unknown, msg: unknown) => void | Promise<void>;
}

interface MockNatsOptions {
  connectFail?: boolean;
  publishFail?: boolean;
}

export class MockNatsClient {
  private isConnectedFlag = false;
  private subscriptions: MockSubscription[] = [];
  private publishedMessages: Array<{ topic: string; data: unknown }> = [];
  private options: MockNatsOptions;

  constructor(options: MockNatsOptions = {}) {
    this.options = options;
  }

  async connect(): Promise<void> {
    if (this.options.connectFail) {
      throw new Error("Mock connect failed");
    }
    this.isConnectedFlag = true;
  }

  async disconnect(): Promise<void> {
    this.isConnectedFlag = false;
    this.subscriptions = [];
  }

  isConnected(): boolean {
    return this.isConnectedFlag;
  }

  async publish<T>(topic: string, data: T): Promise<void> {
    if (!this.isConnectedFlag) {
      throw new Error("Not connected to NATS");
    }
    if (this.options.publishFail) {
      throw new Error("Mock publish failed");
    }
    this.publishedMessages.push({ topic, data });
  }

  async publishBrainMessage(message: BrainMessage): Promise<void> {
    await this.publish("coleo.brain.messages", message);
  }

  async publishCommandEnvelope(message: CommandEnvelope): Promise<void> {
    const subject = message.to === "brain" ? "coleo.cmd.to.brain" : `coleo.cmd.to.arm.${message.to}`;
    await this.publish(subject, message);
  }

  subscribe<T>(topic: string, handler: (data: T, msg: unknown) => void | Promise<void>): { unsubscribe: () => void } {
    const sub: MockSubscription = { topic, handler: handler as (data: unknown, msg: unknown) => void | Promise<void> };
    this.subscriptions.push(sub);
    return {
      unsubscribe: () => {
        const idx = this.subscriptions.findIndex(s => s === sub);
        if (idx >= 0) {
          this.subscriptions.splice(idx, 1);
        }
      },
    };
  }

  async triggerMessage<T>(topic: string, data: T): Promise<void> {
    const subs = this.subscriptions.filter(s => s.topic === topic);
    for (const sub of subs) {
      await sub.handler(data, { subject: topic });
    }
  }

  getPublishedMessages(): Array<{ topic: string; data: unknown }> {
    return [...this.publishedMessages];
  }

  getPublishedMessagesByType<T>(topic: string): T[] {
    return this.publishedMessages
      .filter(m => m.topic === topic)
      .map(m => m.data as T);
  }

  getBrainMessages(): BrainMessage[] {
    return this.getPublishedMessagesByType<BrainMessage>("coleo.brain.messages");
  }

  clearMessages(): void {
    this.publishedMessages = [];
  }

  clearSubscriptions(): void {
    this.subscriptions = [];
  }
}

export function createMockNatsClient(options?: MockNatsOptions): MockNatsClient {
  return new MockNatsClient(options);
}

export class NatsClientMockFactory {
  private clients: MockNatsClient[] = [];

  create(options?: MockNatsOptions): MockNatsClient {
    const client = new MockNatsClient(options);
    this.clients.push(client);
    return client;
  }

  reset(): void {
    for (const client of this.clients) {
      client.clearMessages();
      client.clearSubscriptions();
    }
  }

  getAllMessages(): Array<{ topic: string; data: unknown }> {
    return this.clients.flatMap(c => c.getPublishedMessages());
  }
}
