import { describe, expect, it } from "bun:test";
import type { EventData } from "../../nats/jetstream";
import { InMemoryEventStore } from "../../nats/jetstream";
import type { ArmEventWindow } from "../event-window";
import { BrainEventWindow } from "../event-window";
import { ArmActivityAnalyzer } from "../activity-analyzer";

function createWindow(armId: string, events: EventData[]): ArmEventWindow {
	const byType = new Map<string, EventData[]>();
	const latestByType = new Map<string, EventData>();

	for (const event of events) {
		const existing = byType.get(event.type) || [];
		existing.push(event);
		byType.set(event.type, existing);
		latestByType.set(event.type, event);
	}

	const lastEvent = events[events.length - 1];
	const lastEventAt = lastEvent ? new Date(lastEvent.timestamp) : null;

	return {
		armId,
		events,
		byType,
		latestByType,
		lastEventAt,
		silentDurationMs: lastEventAt ? Date.now() - lastEventAt.getTime() : Number.POSITIVE_INFINITY,
		unknownEventTypes: [],
	};
}

describe("status_changed classification", () => {
	it("treats status_changed as a known event type", async () => {
		const store = new InMemoryEventStore();
		store.initialize();

		await store.publishEvent("coleo.events.arm.arm-1.status_changed", {
			type: "status_changed",
			armId: "arm-1",
			data: { newStatus: "idle" },
			timestamp: new Date().toISOString(),
		});

		const window = await new BrainEventWindow({
			store,
			log: () => {},
		}).getWindowForArm("arm-1", { windowMs: 60_000, limit: 20 });

		expect(window.unknownEventTypes).toEqual([]);
	});

	it("classifies busy status_changed as active work", () => {
		const analyzer = new ArmActivityAnalyzer({
			config: { startupGracePeriodMs: 0 },
			log: () => {},
		});
		const window = createWindow("arm-1", [
			{
				type: "status_changed",
				armId: "arm-1",
				data: { newStatus: "busy" },
				timestamp: new Date().toISOString(),
			},
		]);

		const result = analyzer.analyze(window);

		expect(result.state).toBe("productive");
		expect(result.confidence).toBe("medium");
	});

	it("classifies idle status_changed as idle", () => {
		const analyzer = new ArmActivityAnalyzer({
			config: { startupGracePeriodMs: 0 },
			log: () => {},
		});
		const window = createWindow("arm-1", [
			{
				type: "status_changed",
				armId: "arm-1",
				data: { newStatus: "idle" },
				timestamp: new Date().toISOString(),
			},
		]);

		const result = analyzer.analyze(window);

		expect(result.state).toBe("idle");
		expect(result.confidence).toBe("medium");
	});
});
