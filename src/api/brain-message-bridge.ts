import { randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import { JSONCodec, type NatsConnection, type Subscription } from "nats";
import { queueMessage } from "../db/state";
import { TOPICS, type BrainMessage } from "../nats";
import { isBrainInboxMessageType } from "../types/brain-inbox";

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
			try {
				const decoded = codec.decode(msg.data);
				if (!isBrainMessage(decoded)) {
					log?.("[brain-message-bridge] Ignored invalid brain message payload");
					continue;
				}
				if (!isBrainInboxMessageType(decoded.type)) {
					log?.(
						`[brain-message-bridge] Ignored unsupported brain message type: ${decoded.type}`,
					);
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
			}
		}
	})();

	log?.(`[brain-message-bridge] Subscribed to ${TOPICS.BRAIN_MESSAGES}`);

	return {
		close: () => subscription.unsubscribe(),
	};
}
