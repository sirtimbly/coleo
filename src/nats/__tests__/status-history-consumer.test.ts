import { describe, expect, it } from "bun:test";
import { AckPolicy, DeliverPolicy } from "nats";
import type { ConsumerConfig, JsMsg, NatsConnection } from "nats";
import {
  STATUS_HISTORY_FILTER_SUBJECT,
  classifyStatusHistoryEvent,
  decodeStatusHistoryMessage,
  ensureStatusHistoryConsumer,
  processStatusHistoryMessage,
} from "../status-history-consumer";

interface MessageState {
  acked: number;
  nacked: number;
  working: number;
}

function makeMessage(
  payload: unknown,
  state: MessageState,
  subject = "coleo.events.task.task-1.task.completed",
): JsMsg {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    subject,
    string: () => raw,
    ack: () => {
      state.acked += 1;
    },
    nak: () => {
      state.nacked += 1;
    },
    working: () => {
      state.working += 1;
    },
    info: {
      stream: "coleo-events",
      streamSequence: 42,
      deliverySequence: 7,
      redeliveryCount: 2,
      timestamp: new Date("2026-07-20T12:00:00.000Z"),
    },
  } as unknown as JsMsg;
}

function event(type: string) {
  return {
    type,
    armId: "arm-1",
    data: {
      taskId: "task-1",
      summary: "Preserve this complete payload",
      issues: ["example"],
      classification: "development",
    },
    timestamp: "2026-07-20T11:59:00.000Z",
  };
}

describe("status history consumer", () => {
  it("creates a durable replayable explicit-ack consumer", async () => {
    let addedConfig: ConsumerConfig | null = null;
    const connection = {
      jetstreamManager: async () => ({
        consumers: {
          info: async () => {
            throw new Error("consumer missing");
          },
          add: async (_stream: string, config: ConsumerConfig) => {
            addedConfig = config;
          },
        },
      }),
    } as unknown as NatsConnection;

    await ensureStatusHistoryConsumer(connection, "status-history-test");

    expect(addedConfig).toMatchObject({
      durable_name: "status-history-test",
      filter_subject: STATUS_HISTORY_FILTER_SUBJECT,
      deliver_policy: DeliverPolicy.All,
      ack_policy: AckPolicy.Explicit,
      max_deliver: -1,
    });
  });

  it("normalizes current and canonical status event names", () => {
    expect(classifyStatusHistoryEvent("task.status_reported")).toBe(
      "status_report",
    );
    expect(classifyStatusHistoryEvent("status_report.submitted")).toBe(
      "status_report",
    );
    expect(classifyStatusHistoryEvent("task.completed")).toBe("task_completion");
    expect(classifyStatusHistoryEvent("task.discovery_reported")).toBe(
      "discovery",
    );
    expect(classifyStatusHistoryEvent("discovery.created")).toBe("discovery");
    expect(classifyStatusHistoryEvent("report_bug")).toBe("bug_report");
    expect(classifyStatusHistoryEvent("bug.reported")).toBe("bug_report");
    expect(classifyStatusHistoryEvent("arm.heartbeat")).toBeNull();
  });

  it("preserves the event envelope, raw payload, and JetStream metadata", () => {
    const state = { acked: 0, nacked: 0, working: 0 };
    const original = event("task.status_reported");
    const msg = makeMessage(original, state);
    const decoded = decodeStatusHistoryMessage(msg);

    expect(decoded).not.toBeNull();
    expect(decoded?.type).toBe("status_report");
    expect(decoded?.classification).toBe("development");
    expect(decoded?.event).toEqual(original);
    expect(JSON.parse(decoded?.rawPayload || "{}")).toEqual(original);
    expect(decoded?.metadata).toMatchObject({
      stream: "coleo-events",
      subject: "coleo.events.task.task-1.task.completed",
      streamSequence: 42,
      deliverySequence: 7,
      redeliveryCount: 2,
      publishedAt: "2026-07-20T12:00:00.000Z",
    });
  });

  it("acks only after successful downstream processing", async () => {
    const state = { acked: 0, nacked: 0, working: 0 };
    const seen: unknown[] = [];
    const processed = await processStatusHistoryMessage(
      makeMessage(event("task.completed"), state),
      async (consumed) => {
        expect(state.acked).toBe(0);
        seen.push(consumed);
      },
    );

    expect(processed).toBe(true);
    expect(seen).toHaveLength(1);
    expect(state).toEqual({ acked: 1, nacked: 0, working: 1 });
  });

  it("naks handler failures so JetStream can redeliver", async () => {
    const state = { acked: 0, nacked: 0, working: 0 };
    const processed = await processStatusHistoryMessage(
      makeMessage(event("bug.reported"), state),
      () => {
        throw new Error("index unavailable");
      },
    );

    expect(processed).toBe(false);
    expect(state).toEqual({ acked: 0, nacked: 1, working: 1 });
  });

  it("acks malformed and unrelated events without dispatching them", async () => {
    const malformedState = { acked: 0, nacked: 0, working: 0 };
    const unrelatedState = { acked: 0, nacked: 0, working: 0 };
    let calls = 0;

    await processStatusHistoryMessage(makeMessage("not json", malformedState), () => {
      calls += 1;
    });
    await processStatusHistoryMessage(
      makeMessage(event("arm.heartbeat"), unrelatedState),
      () => {
        calls += 1;
      },
    );

    expect(calls).toBe(0);
    expect(malformedState.acked).toBe(1);
    expect(unrelatedState.acked).toBe(1);
  });
});
