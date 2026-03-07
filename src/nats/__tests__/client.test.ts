import { describe, it, expect } from "bun:test";
import { JSONCodec } from "nats";

import { NatsClient } from "../client";
import type { AgentCommand, CommandResponse } from "../types";

const jc = JSONCodec<unknown>();

type ReplyMessage = { data: Uint8Array };

class MockSubscription implements AsyncIterableIterator<ReplyMessage> {
  private queue: ReplyMessage[] = [];
  private waiting: Array<(result: IteratorResult<ReplyMessage>) => void> = [];
  private closed = false;
  public unsubscribeCalled = false;

  push(message: ReplyMessage): void {
    if (this.closed) return;
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ done: false, value: message });
      return;
    }
    this.queue.push(message);
  }

  unsubscribe(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeCalled = true;
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift();
      waiter?.({ done: true, value: undefined as never });
    }
  }

  async next(): Promise<IteratorResult<ReplyMessage>> {
    if (this.queue.length > 0) {
      return { done: false, value: this.queue.shift()! };
    }
    if (this.closed) {
      return { done: true, value: undefined as never };
    }
    return await new Promise<IteratorResult<ReplyMessage>>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<ReplyMessage> {
    return this;
  }
}

class MockConnection {
  public lastSubscription: MockSubscription | null = null;
  public publishedTopics: string[] = [];
  public info: { max_payload: number } | undefined;

  subscribe(): MockSubscription {
    this.lastSubscription = new MockSubscription();
    return this.lastSubscription;
  }

  publish(topic: string): void {
    this.publishedTopics.push(topic);
  }
}

function setMockConnection(client: NatsClient, connection: MockConnection): void {
  (client as unknown as { connection: MockConnection }).connection = connection;
}

function makeCommand(requestId: string): AgentCommand {
  return {
    type: "list_arms",
    requestId,
  };
}

function makePromptCommand(requestId: string, prompt: string): AgentCommand {
  return {
    type: "prompt",
    requestId,
    armId: "arm-test",
    prompt,
  };
}

describe("NatsClient.sendCommand", () => {
  it("returns timeout error when no response arrives", async () => {
    const client = new NatsClient({
      serverUrl: "nats://localhost:4222",
      clientId: "test-client",
    });
    const connection = new MockConnection();
    setMockConnection(client, connection);

    const result = await client.sendCommand("agent-test", makeCommand("req-timeout"), 20);

    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
    expect(connection.lastSubscription?.unsubscribeCalled).toBe(true);
  });

  it("returns decoded response when agent replies before timeout", async () => {
    const client = new NatsClient({
      serverUrl: "nats://localhost:4222",
      clientId: "test-client",
    });
    const connection = new MockConnection();
    setMockConnection(client, connection);

    const pending = client.sendCommand<{ ok: boolean }>("agent-test", makeCommand("req-success"), 200);
    const response: CommandResponse<{ ok: boolean }> = {
      requestId: "req-success",
      success: true,
      data: { ok: true },
    };
    connection.lastSubscription?.push({ data: jc.encode(response) });

    const result = await pending;
    expect(result.success).toBe(true);
    expect(result.data?.ok).toBe(true);
  });

  it("returns an error when command payload exceeds server max payload", async () => {
    const client = new NatsClient({
      serverUrl: "nats://localhost:4222",
      clientId: "test-client",
    });
    const connection = new MockConnection();
    connection.info = { max_payload: 512 };
    setMockConnection(client, connection);

    const result = await client.sendCommand(
      "agent-test",
      makePromptCommand("req-too-large", "x".repeat(5000)),
      200,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("exceeds NATS max payload");
    expect(connection.publishedTopics).toEqual([]);
    expect(connection.lastSubscription?.unsubscribeCalled).toBe(true);
  });
});
