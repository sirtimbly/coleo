import { randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import { JSONCodec, type NatsConnection, type Subscription } from "nats";
import { queueMessage, recordDeadLetterMessage } from "../db/state";
import { TOPICS, type BrainMessage } from "../nats";
import {
	isBrainInboxMessageType,
	validateBrainInboxPayload,
} from "../types/brain-inbox";

interface BridgeOptions {
	connection: NatsConnection;
	db: Database;
	log?: (message: string) => void;
}

interface BridgeHandle {
	close: () => void;
}

const codec = JSONCodec<BrainMessage>();

function isBrainMessage(value: unknown): value is BrainMessage {
	if (!value || typeof value !== "object") {
		return false;
	}

	const candidate = value as Partial<BrainMessage>;
	return (
		typeof candidate.from === "string" &&
		candidate.from.length > 0 &&
		candidate.to === "brain" &&
		typeof candidate.type === "string" &&
		candidate.type.length > 0 &&
		typeof candidate.timestamp === "string"
	);
}

export function startBrainMessageBridge(options: BridgeOptions): BridgeHandle {
	const { connection, db, log } = options;
	const subscription: Subscription = connection.subscribe(TOPICS.BRAIN_MESSAGES);

	(async () => {
		for await (const msg of subscription) {
			let decoded: BrainMessage | null = null;
			try {
				decoded = codec.decode(msg.data);
				if (!isBrainMessage(decoded)) {
					log?.("[brain-message-bridge] Ignored invalid brain message payload");
					recordDeadLetterMessage(db, {
						id: `deadletter-${randomUUID()}`,
						from: "unknown",
						type: "invalid_brain_message",
						payload: decoded,
						reason: "invalid brain message envelope",
						source: "nats_bridge",
					});
					continue;
				}
				if (!isBrainInboxMessageType(decoded.type)) {
					log?.(
						`[brain-message-bridge] Ignored unsupported brain message type: ${decoded.type}`,
					);
					recordDeadLetterMessage(db, {
						id: `deadletter-${randomUUID()}`,
						from: decoded.from,
						type: decoded.type,
						payload: decoded.payload,
						reason: `unsupported brain message type: ${decoded.type}`,
						source: "nats_bridge",
					});
					continue;
				}
				const payloadError = validateBrainInboxPayload(decoded.type, decoded.payload);
				if (payloadError) {
					log?.(
						`[brain-message-bridge] Ignored invalid payload for ${decoded.type}: ${payloadError}`,
					);
					recordDeadLetterMessage(db, {
						id: `deadletter-${randomUUID()}`,
						from: decoded.from,
						type: decoded.type,
						payload: decoded.payload,
						reason: payloadError,
						source: "nats_bridge",
					});
					continue;
				}

				const id = `nats-${randomUUID()}`;
				queueMessage(db, {
					id,
					from: decoded.from,
					to: decoded.to,
					type: decoded.type,
					payload: decoded.payload,
				});
			} catch (err) {
				log?.(`[brain-message-bridge] Failed to queue brain message: ${err}`);
				recordDeadLetterMessage(db, {
					id: `deadletter-${randomUUID()}`,
					from: decoded?.from || "unknown",
					type: decoded?.type || "decode_error",
					payload: decoded?.payload || {},
					reason: String(err),
					source: "nats_bridge",
				});
			}
		}
	})();

	log?.(`[brain-message-bridge] Subscribed to ${TOPICS.BRAIN_MESSAGES}`);

	return {
		close: () => subscription.unsubscribe(),
	};
}
