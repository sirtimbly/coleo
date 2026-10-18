import {
  AckPolicy,
  DiscardPolicy,
  DeliverPolicy,
  JSONCodec,
  ReplayPolicy,
  RetentionPolicy,
  StorageType,
  type ConsumerConfig,
  type NatsConnection,
  type StreamConfig,
} from "nats";
import type { JsMsg, JetStreamManager } from "nats";
import {
  COMMAND_STREAM_NAME,
  COMMAND_STREAM_SUBJECTS,
  commandSubjectForEnvelope,
  type CommandEnvelope,
} from "./command-types";

const codec = JSONCodec<CommandEnvelope>();

let ensuredStreamPromise: Promise<void> | null = null;
const ensuredConsumerPromises = new Map<string, Promise<void>>();

export function resetCommandStreamBootstrapForTests(): void {
  ensuredStreamPromise = null;
  ensuredConsumerPromises.clear();
}

export async function ensureCommandStream(
  connection: NatsConnection,
  log?: (message: string) => void,
): Promise<void> {
  if (!ensuredStreamPromise) {
    ensuredStreamPromise = ensureCommandStreamInternal(connection, log).catch((err) => {
      ensuredStreamPromise = null;
      throw err;
    });
  }
  return ensuredStreamPromise;
}

export async function ensureProjectorConsumer(
  connection: NatsConnection,
  durableName: string,
  log?: (message: string) => void,
): Promise<void> {
  const existing = ensuredConsumerPromises.get(durableName);
  if (existing) {
    await existing;
    return;
  }
  const promise = ensureProjectorConsumerInternal(connection, durableName, log).catch((err) => {
    ensuredConsumerPromises.delete(durableName);
    throw err;
  });
  ensuredConsumerPromises.set(durableName, promise);
  await promise;
}

export async function publishCommandEnvelope(
  connection: NatsConnection,
  envelope: CommandEnvelope,
): Promise<{ stream: string; seq: number; subject: string }> {
  await ensureCommandStream(connection);

  const subject = commandSubjectForEnvelope(envelope);
  const payload = codec.encode(envelope);
  const maxPayload = connection.info?.max_payload;
  if (typeof maxPayload === "number" && Number.isFinite(maxPayload) && payload.length > maxPayload) {
    throw new Error(
      `command payload exceeds NATS max payload (${payload.length} > ${maxPayload})`,
    );
  }

  const ack = await connection.jetstream().publish(subject, payload, {
    msgID: envelope.id,
  });
  return {
    stream: ack.stream,
    seq: ack.seq,
    subject,
  };
}

export function decodeCommandEnvelope(msg: JsMsg): CommandEnvelope {
  return codec.decode(msg.data);
}

async function ensureCommandStreamInternal(
  connection: NatsConnection,
  log?: (message: string) => void,
): Promise<void> {
  const jsm = await connection.jetstreamManager();
  const info = await jsm.streams.info(COMMAND_STREAM_NAME).catch(() => null);

  if (!info) {
    const config: Partial<StreamConfig> = {
      name: COMMAND_STREAM_NAME,
      subjects: [...COMMAND_STREAM_SUBJECTS],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      discard: DiscardPolicy.Old,
      max_age: 7 * 24 * 60 * 60 * 1_000_000_000,
      duplicate_window: 2 * 60 * 1_000_000_000,
    };
    await jsm.streams.add(config as StreamConfig);
    log?.(`[command-stream] Created stream ${COMMAND_STREAM_NAME}`);
    return;
  }

  const currentSubjects = new Set(info.config.subjects || []);
  let changed = false;
  for (const required of COMMAND_STREAM_SUBJECTS) {
    if (!currentSubjects.has(required)) {
      currentSubjects.add(required);
      changed = true;
    }
  }

  if (changed) {
    await jsm.streams.update(COMMAND_STREAM_NAME, {
      ...info.config,
      subjects: Array.from(currentSubjects),
    } as StreamConfig);
    log?.(`[command-stream] Updated subjects on stream ${COMMAND_STREAM_NAME}`);
  }
}

async function ensureProjectorConsumerInternal(
  connection: NatsConnection,
  durableName: string,
  log?: (message: string) => void,
): Promise<void> {
  await ensureCommandStream(connection, log);
  const jsm = await connection.jetstreamManager();
  const info = await jsm.consumers.info(COMMAND_STREAM_NAME, durableName).catch(() => null);
  if (info) {
    return;
  }

  const config: Partial<ConsumerConfig> = {
    durable_name: durableName,
    filter_subject: "coleo.cmd.>",
    deliver_policy: DeliverPolicy.All,
    ack_policy: AckPolicy.Explicit,
    replay_policy: ReplayPolicy.Instant,
    max_deliver: -1,
  };

  await addConsumer(jsm, config as ConsumerConfig);
  log?.(`[command-stream] Created durable consumer ${durableName}`);
}

async function addConsumer(jsm: JetStreamManager, config: ConsumerConfig): Promise<void> {
  await jsm.consumers.add(COMMAND_STREAM_NAME, config);
}
