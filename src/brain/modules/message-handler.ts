/**
 * BrainMessageHandler - Handles messages from arms via NATS and other sources
 * 
 * Extracted from brain.ts to reduce file size and improve maintainability.
 * Handles: NATS message subscription, message routing, and arm event processing.
 */

import type { NatsClient } from "../../nats";
import type { BrainMessage, TOPICS as NatsTopics } from "../../nats";
import type { QueueMessage, MessageType, Arm, Discovery } from "../../types";

export interface MessageHandlerOptions {
	natsUrl: string;
	clientId: string;
	debug?: boolean;
}

export interface MessageHandlerCallbacks {
	onBrainMessage: (message: BrainMessage) => Promise<void>;
	onArmEvent: (
		armId: string,
		eventType: string,
		properties: Record<string, unknown>,
	) => Promise<void>;
	onArmBroadcast: (event: { armId: string; type: string }) => void;
}

export class BrainMessageHandler {
	private natsClient: NatsClient | null = null;
	private natsUrl: string;
	private clientId: string;
	private debug: boolean;
	private callbacks: MessageHandlerCallbacks;
	private shuttingDown = false;

	constructor(
		options: MessageHandlerOptions,
		callbacks: MessageHandlerCallbacks,
	) {
		this.natsUrl = options.natsUrl;
		this.clientId = options.clientId;
		this.debug = options.debug ?? false;
		this.callbacks = callbacks;
	}

	/**
	 * Check if connected to NATS
	 */
	isConnected(): boolean {
		return this.natsClient !== null;
	}

	/**
	 * Get the NATS client instance
	 */
	getNatsClient(): NatsClient | null {
		return this.natsClient;
	}

	/**
	 * Connect to NATS and subscribe to brain messages
	 */
	async connect(): Promise<boolean> {
		try {
			const { NatsClient, TOPICS } = await import("../../nats");
			
			this.natsClient = new NatsClient({
				serverUrl: this.natsUrl,
				clientId: this.clientId,
				debug: this.debug,
			});

			await this.natsClient.connect();

			// Subscribe to brain messages from arms
			this.natsClient.subscribe<BrainMessage>(
				TOPICS.BRAIN_MESSAGES,
				async (message) => {
					if (!this.shuttingDown) {
						await this.callbacks.onBrainMessage(message);
					}
				},
			);

			// Subscribe to arm events for real-time activity tracking
			this.natsClient.subscribe<{ armId: string; type: string }>(
				TOPICS.BROADCAST_ARMS,
				async (event) => {
					if (!this.shuttingDown && event.armId) {
						this.callbacks.onArmBroadcast(event);
					}
				},
			);

			// Subscribe to individual arm events
			this.natsClient.subscribe<{
				armId: string;
				type: string;
				properties: Record<string, unknown>;
			}>(`arm.>`, async (event) => {
				if (!this.shuttingDown) {
					await this.callbacks.onArmEvent(
						event.armId,
						event.type,
						event.properties,
					);
				}
			});

			return true;
		} catch (err) {
			this.natsClient = null;
			return false;
		}
	}

	/**
	 * Disconnect from NATS
	 */
	async disconnect(): Promise<void> {
		this.shuttingDown = true;
		if (this.natsClient) {
			await this.natsClient.disconnect();
			this.natsClient = null;
		}
	}

	/**
	 * Publish a message to NATS
	 */
	async publish<T>(subject: string, data: T): Promise<boolean> {
		if (!this.natsClient) {
			return false;
		}
		try {
			await this.natsClient.publish(subject, data);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Convert a NATS BrainMessage to QueueMessage format
	 */
	static convertToQueueMessage(
		message: BrainMessage,
		messageId?: string,
	): QueueMessage {
		return {
			id: messageId || `nats-${Date.now()}`,
			from: message.from,
			to: message.to,
			type: message.type as MessageType,
			payload: message.payload,
			timestamp: new Date(message.timestamp),
		};
	}
}
