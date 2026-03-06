import { randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import type { JsMsg, NatsConnection } from "nats";
import { recordDeadLetterMessage, upsertProjectedMessage } from "../db/state";
import { validateAndRecordCommandEnvelope } from "./brain-command-ingress";
import { COMMAND_STREAM_NAME } from "../nats/command-types";
import { decodeCommandEnvelope, ensureProjectorConsumer } from "../nats/command-stream";

interface BridgeOptions {
	connection: NatsConnection;
	db: Database;
	log?: (message: string) => void;
}

interface BridgeHandle {
	close: () => void;
}

const DEFAULT_PROJECTOR_DURABLE = "cmd-projector-to-db";
const FETCH_MAX_MESSAGES = 64;
const FETCH_EXPIRES_MS = 5000;

interface ProjectionMetadata {
  streamName: string;
  streamSeq: number | null;
}

export function startBrainMessageBridge(options: BridgeOptions): BridgeHandle {
	const { connection, db, log } = options;
  const projectorEnabled = process.env.COLEO_COMMAND_PROJECTOR_ENABLED !== "0";
  const durableName = process.env.COLEO_COMMAND_PROJECTOR_DURABLE || DEFAULT_PROJECTOR_DURABLE;
  let closed = false;

  if (!projectorEnabled) {
    log?.("[brain-message-bridge] JetStream command projector disabled by COLEO_COMMAND_PROJECTOR_ENABLED=0");
    return {
      close: () => {},
    };
  }

  (async () => {
    try {
      await ensureProjectorConsumer(connection, durableName, log);
      const consumer = await connection.jetstream().consumers.get(COMMAND_STREAM_NAME, durableName);
      log?.(
        `[brain-message-bridge] Started JetStream command projector stream=${COMMAND_STREAM_NAME} durable=${durableName}`,
      );

      while (!closed) {
        const batch = await consumer.fetch({
          max_messages: FETCH_MAX_MESSAGES,
          expires: FETCH_EXPIRES_MS,
        });

        for await (const msg of batch) {
          if (closed) {
            return;
          }
          await projectCommandMessage(db, msg, log);
        }
      }
    } catch (err) {
      log?.(`[brain-message-bridge] Projector stopped with error: ${err}`);
    }
  })();

	return {
		close: () => {
      closed = true;
    },
	};
}

export function projectCommandEnvelopeToMessages(
  db: Database,
  envelope: ReturnType<typeof decodeCommandEnvelope>,
  metadata: ProjectionMetadata,
): boolean {
  const validationError = validateAndRecordCommandEnvelope(
    db,
    envelope,
    "jetstream_projector",
  );
  if (validationError) {
    return false;
  }

  return upsertProjectedMessage(db, {
    id: envelope.id,
    from: envelope.from,
    to: envelope.to,
    type: envelope.type,
    payload: envelope.payload,
    createdAt: envelope.createdAt,
    source: "jetstream",
    streamName: metadata.streamName,
    streamSeq: metadata.streamSeq,
    dedupeId: envelope.id,
  });
}

async function projectCommandMessage(
  db: Database,
  msg: JsMsg,
  log?: (message: string) => void,
): Promise<void> {
  let decoded: ReturnType<typeof decodeCommandEnvelope> | null = null;
  try {
    decoded = decodeCommandEnvelope(msg);
    const streamSeq = resolveStreamSeq(msg);
    const inserted = projectCommandEnvelopeToMessages(db, decoded, {
      streamName: COMMAND_STREAM_NAME,
      streamSeq,
    });
    if (!inserted) {
      log?.(`[brain-message-bridge] Duplicate or invalid command skipped id=${decoded.id}`);
    }
    msg.ack();
  } catch (err) {
    const reason = String(err);
    recordDeadLetterMessage(db, {
      id: `deadletter-${randomUUID()}`,
      from: decoded?.from || "unknown",
      type: decoded?.type || "decode_error",
      payload: decoded?.payload || safeRawPayload(msg),
      reason,
      source: "jetstream_projector",
    });
    msg.ack();
    log?.(`[brain-message-bridge] Failed to project command message: ${reason}`);
  }
}

function resolveStreamSeq(msg: JsMsg): number | null {
  const info = (msg as { info?: { streamSequence?: number } }).info;
  if (typeof info?.streamSequence === "number") {
    return info.streamSequence;
  }
  return null;
}

function safeRawPayload(msg: JsMsg): unknown {
  try {
    return { raw: msg.string() };
  } catch {
    return { bytes: msg.data.length };
  }
}
