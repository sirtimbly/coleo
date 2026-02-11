/**
 * BrainMessageHandler Tests
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { BrainMessageHandler } from "../message-handler";
import type { MessageHandlerOptions, MessageHandlerCallbacks } from "../message-handler";
import type { BrainMessage } from "../../../nats";

describe("BrainMessageHandler", () => {
	let handler: BrainMessageHandler;
	let callbacks: MessageHandlerCallbacks;
	let brainMessages: BrainMessage[] = [];
	let armEvents: Array<{ armId: string; type: string; properties: Record<string, unknown> }> = [];
	let armBroadcasts: Array<{ armId: string; type: string }> = [];

	const options: MessageHandlerOptions = {
		natsUrl: "nats://localhost:4222",
		clientId: "test-brain",
		debug: false,
	};

	beforeEach(() => {
		brainMessages = [];
		armEvents = [];
		armBroadcasts = [];

		callbacks = {
			onBrainMessage: async (message: BrainMessage) => {
				brainMessages.push(message);
			},
			onArmEvent: async (
				armId: string,
				eventType: string,
				properties: Record<string, unknown>,
			) => {
				armEvents.push({ armId, type: eventType, properties });
			},
			onArmBroadcast: (event: { armId: string; type: string }) => {
				armBroadcasts.push(event);
			},
		};

		handler = new BrainMessageHandler(options, callbacks);
	});

	describe("initialization", () => {
		it("should initialize with provided options", () => {
			expect(handler.isConnected()).toBe(false);
			expect(handler.getNatsClient()).toBeNull();
		});

		it("should store debug option", () => {
			const debugHandler = new BrainMessageHandler(
				{ ...options, debug: true },
				callbacks,
			);
			expect(debugHandler).toBeDefined();
		});
	});

	describe("message conversion", () => {
		it("should convert BrainMessage to QueueMessage", () => {
			const brainMessage: BrainMessage = {
				from: "arm-1",
				to: "brain",
				type: "heartbeat",
				payload: { status: "idle" },
				timestamp: new Date().toISOString(),
			};

			const queueMessage = BrainMessageHandler.convertToQueueMessage(brainMessage);

			expect(queueMessage.from).toBe("arm-1");
			expect(queueMessage.to).toBe("brain");
			expect(queueMessage.type).toBe("heartbeat");
			expect(queueMessage.payload).toEqual({ status: "idle" });
			expect(queueMessage.timestamp).toBeInstanceOf(Date);
		});

		it("should use custom message ID when provided", () => {
			const brainMessage: BrainMessage = {
				from: "arm-1",
				to: "brain",
				type: "heartbeat",
				payload: {},
				timestamp: new Date().toISOString(),
			};

			const queueMessage = BrainMessageHandler.convertToQueueMessage(
				brainMessage,
				"custom-id",
			);

			expect(queueMessage.id).toBe("custom-id");
		});

		it("should generate nats prefix ID when not provided", () => {
			const brainMessage: BrainMessage = {
				from: "arm-1",
				to: "brain",
				type: "heartbeat",
				payload: {},
				timestamp: new Date().toISOString(),
			};

			const queueMessage = BrainMessageHandler.convertToQueueMessage(brainMessage);

			expect(queueMessage.id).toMatch(/^nats-\d+$/);
		});
	});

	describe("connection state", () => {
		it("should report not connected initially", () => {
			expect(handler.isConnected()).toBe(false);
		});

		it("should return null for getNatsClient when not connected", () => {
			expect(handler.getNatsClient()).toBeNull();
		});
	});

	describe("publish", () => {
		it("should return false when not connected", async () => {
			const result = await handler.publish("test.subject", { data: "test" });
			expect(result).toBe(false);
		});
	});

	describe("disconnect", () => {
		it("should handle disconnect when not connected", async () => {
			await handler.disconnect();
			expect(handler.isConnected()).toBe(false);
		});
	});
});
