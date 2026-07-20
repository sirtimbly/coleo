import {
  AckPolicy,
  DeliverPolicy,
  ReplayPolicy,
} from "nats";
import type { ConsumerConfig, JsMsg, NatsConnection } from "nats";
import type { EventData } from "./jetstream-types";

export const STATUS_HISTORY_STREAM = "coleo-events";
export const STATUS_HISTORY_DURABLE = "status-history-consumer-v1";
export const STATUS_HISTORY_FILTER_SUBJECT = "coleo.events.>";

export type ConsumedStatusEventType =
  | "status_report"
  | "task_completion"
  | "discovery"
  | "bug_report";

export interface StatusEventStreamMetadata {
  stream: string;
  subject: string;
  streamSequence: number | null;
  deliverySequence: number | null;
  redeliveryCount: number;
  publishedAt: string | null;
  receivedAt: string;
}

export interface ConsumedStatusEvent {
  type: ConsumedStatusEventType;
  event: EventData;
  rawPayload: string;
  metadata: StatusEventStreamMetadata;
}

export interface StatusHistoryConsumerOptions {
  connection: NatsConnection;
  onEvent: (event: ConsumedStatusEvent) => void | Promise<void>;
  durableName?: string;
  batchSize?: number;
  fetchExpiresMs?: number;
  log?: (message: string) => void;
}

export interface StatusHistoryConsumerHandle {
  close: () => void;
}

const EVENT_TYPE_ALIASES: Record<string, ConsumedStatusEventType> = {
  "status.report": "status_report",
  "status_report.submitted": "status_report",
  "task.status_reported": "status_report",
  "task.completed": "task_completion",
  "discovery.created": "discovery",
  "task.discovery_reported": "discovery",
  "bug.reported": "bug_report",
  bug_report: "bug_report",
  report_bug: "bug_report",
};

export function classifyStatusHistoryEvent(
  eventType: string,
): ConsumedStatusEventType | null {
  return EVENT_TYPE_ALIASES[eventType] ?? null;
}

export function decodeStatusHistoryMessage(msg: JsMsg): ConsumedStatusEvent | null {
  let rawPayload: string;
  let parsed: unknown;
  try {
    rawPayload = msg.string();
    parsed = JSON.parse(rawPayload) as unknown;
  } catch {
    return null;
  }

  if (!isEventData(parsed)) {
    return null;
  }

  const type = classifyStatusHistoryEvent(parsed.type);
  if (!type) {
    return null;
  }

  const info = messageInfo(msg);
  return {
    type,
    event: parsed,
    rawPayload,
    metadata: {
      stream: info?.stream || STATUS_HISTORY_STREAM,
      subject: msg.subject,
      streamSequence: numberOrNull(info?.streamSequence),
      deliverySequence: numberOrNull(info?.deliverySequence),
      redeliveryCount: typeof info?.redeliveryCount === "number" ? info.redeliveryCount : 0,
      publishedAt: dateToIso(info?.timestamp),
      receivedAt: new Date().toISOString(),
    },
  };
}

export async function processStatusHistoryMessage(
  msg: JsMsg,
  onEvent: StatusHistoryConsumerOptions["onEvent"],
  log?: StatusHistoryConsumerOptions["log"],
): Promise<boolean> {
  const event = decodeStatusHistoryMessage(msg);
  if (!event) {
    msg.ack();
    return false;
  }

  try {
    msg.working();
    await onEvent(event);
    msg.ack();
    return true;
  } catch (err) {
    msg.nak();
    log?.(
      `[status-history-consumer] Handler failed for stream sequence ${event.metadata.streamSequence}: ${err}`,
    );
    return false;
  }
}

export async function ensureStatusHistoryConsumer(
  connection: NatsConnection,
  durableName = STATUS_HISTORY_DURABLE,
  log?: StatusHistoryConsumerOptions["log"],
): Promise<void> {
  const jsm = await connection.jetstreamManager();
  const existing = await jsm.consumers
    .info(STATUS_HISTORY_STREAM, durableName)
    .catch(() => null);
  if (existing) {
    return;
  }

  const config: Partial<ConsumerConfig> = {
    durable_name: durableName,
    filter_subject: STATUS_HISTORY_FILTER_SUBJECT,
    deliver_policy: DeliverPolicy.All,
    ack_policy: AckPolicy.Explicit,
    replay_policy: ReplayPolicy.Instant,
    max_deliver: -1,
  };
  await jsm.consumers.add(STATUS_HISTORY_STREAM, config as ConsumerConfig);
  log?.(`[status-history-consumer] Created durable consumer ${durableName}`);
}

export async function startStatusHistoryConsumer(
  options: StatusHistoryConsumerOptions,
): Promise<StatusHistoryConsumerHandle> {
  const durableName = options.durableName || STATUS_HISTORY_DURABLE;
  const batchSize = positiveInteger(options.batchSize, 64);
  const fetchExpiresMs = positiveInteger(options.fetchExpiresMs, 5000);
  let closed = false;

  await ensureStatusHistoryConsumer(options.connection, durableName, options.log);
  const consumer = await options.connection.jetstream().consumers.get(
    STATUS_HISTORY_STREAM,
    durableName,
  );

  void (async () => {
    options.log?.(`[status-history-consumer] Started durable=${durableName}`);
    while (!closed) {
      try {
        const batch = await consumer.fetch({
          max_messages: batchSize,
          expires: fetchExpiresMs,
        });
        for await (const msg of batch) {
          if (closed) {
            return;
          }
          await processStatusHistoryMessage(msg, options.onEvent, options.log);
        }
      } catch (err) {
        if (!closed) {
          options.log?.(`[status-history-consumer] Fetch failed: ${err}`);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }
  })();

  return {
    close: () => {
      closed = true;
    },
  };
}

function isEventData(value: unknown): value is EventData {
  if (!value || typeof value !== "object") {
    return false;
  }
  const event = value as Record<string, unknown>;
  return (
    typeof event.type === "string" &&
    typeof event.timestamp === "string" &&
    !!event.data &&
    typeof event.data === "object" &&
    !Array.isArray(event.data)
  );
}

function messageInfo(msg: JsMsg): {
  stream?: string;
  streamSequence?: number;
  deliverySequence?: number;
  redeliveryCount?: number;
  timestamp?: Date;
} | null {
  try {
    return msg.info;
  } catch {
    return null;
  }
}

function numberOrNull(value: number | undefined): number | null {
  return typeof value === "number" ? value : null;
}

function dateToIso(value: Date | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}
