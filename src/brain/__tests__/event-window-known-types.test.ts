import { describe, expect, it } from "bun:test";
import { InMemoryEventStore } from "../../nats/jetstream";
import { BrainEventWindow } from "../event-window";

describe("BrainEventWindow known event types", () => {
	it("does not flag known bare arm lifecycle and prompt events as unknown", async () => {
		const store = new InMemoryEventStore();
		store.initialize();

		const armId = "Soleon";
		const timestamp = new Date().toISOString();
		await store.publishEvent(`coleo.events.arm.${armId}.spawned`, {
			type: "spawned",
			armId,
			data: { actor: armId },
			timestamp,
		});
		await store.publishEvent(`coleo.events.arm.${armId}.prompt_sent`, {
			type: "prompt_sent",
			armId,
			data: { actor: armId },
			timestamp,
		});
		await store.publishEvent(`coleo.events.arm.${armId}.arm_initialized`, {
			type: "arm_initialized",
			armId,
			data: { actor: "brain" },
			timestamp,
		});
		await store.publishEvent(`coleo.events.arm.${armId}.status_changed`, {
			type: "status_changed",
			armId,
			data: { newStatus: "idle" },
			timestamp,
		});

		const window = await new BrainEventWindow({
			store,
			log: () => {},
		}).getWindowForArm(armId, { windowMs: 60_000, limit: 20 });

		expect(window.unknownEventTypes).toEqual([]);
	});
});
