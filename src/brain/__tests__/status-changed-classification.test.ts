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
	it("treats a missing telemetry window as low-confidence silence", () => {
		const analyzer = new ArmActivityAnalyzer({
			config: { startupGracePeriodMs: 0 },
			log: () => {},
		});

		const result = analyzer.analyze(createWindow("arm-1", []));

		expect(result.state).toBe("silent");
		expect(result.confidence).toBe("low");
		expect(result.reason).toContain("No event telemetry");
		expect(result.recommendedAction).toBe("none");
	});

	it("counts nested OpenCode tool parts as tool activity", () => {
		const analyzer = new ArmActivityAnalyzer({
			config: { startupGracePeriodMs: 0 },
			log: () => {},
		});
		const result = analyzer.analyze(createWindow("arm-1", [
			{
				type: "message.part.updated",
				armId: "arm-1",
				data: { part: { type: "tool", tool: "bash" } },
				timestamp: new Date().toISOString(),
			},
		]));

		expect(result.metrics.recentToolCount).toBe(1);
	});

	it("does not classify server heartbeats as activity or a loop", () => {
		const analyzer = new ArmActivityAnalyzer({
			config: { startupGracePeriodMs: 0 },
			log: () => {},
		});
		const events = Array.from({ length: 10 }, (_, index): EventData => ({
			type: "server-heartbeat",
			armId: "arm-1",
			data: {},
			timestamp: new Date(Date.now() - index * 1000).toISOString(),
		}));

		const result = analyzer.analyze(createWindow("arm-1", events));

		expect(result.state).toBe("silent");
		expect(result.confidence).toBe("low");
		expect(result.metrics.eventCount).toBe(0);
		expect(result.loopPattern).toBeUndefined();
	});

	it("treats server heartbeats as known event types", async () => {
		const store = new InMemoryEventStore();
		store.initialize();

		for (const type of ["server-heartbeat", "server.heartbeat"]) {
			await store.publishEvent(`coleo.events.arm.arm-1.${type}`, {
				type,
				armId: "arm-1",
				data: {},
				timestamp: new Date().toISOString(),
			});
		}

		const window = await new BrainEventWindow({
			store,
			log: () => {},
		}).getWindowForArm("arm-1", { windowMs: 60_000, limit: 20 });

		expect(window.unknownEventTypes).toEqual([]);
	});

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

	it("treats arm sync, prompts, and compaction as known event types", async () => {
		const store = new InMemoryEventStore();
		store.initialize();

		for (const type of ["arm_status_synced", "prompt_sent", "session.compacted"]) {
			await store.publishEvent(`coleo.events.arm.arm-1.${type}`, {
				type,
				armId: "arm-1",
				data: {},
				timestamp: new Date().toISOString(),
			});
		}

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
		expect(result.confidence).toBe("high");
	});

	it("lets a newer idle transition supersede productive history", () => {
		const analyzer = new ArmActivityAnalyzer({
			config: { startupGracePeriodMs: 0 },
			log: () => {},
		});
		const now = Date.now();
		const result = analyzer.analyze(createWindow("arm-1", [
			{
				type: "file.edited",
				armId: "arm-1",
				data: { file: "src/example.ts" },
				timestamp: new Date(now - 2_000).toISOString(),
			},
			{
				type: "session.status",
				armId: "arm-1",
				data: { status: { type: "idle" } },
				timestamp: new Date(now - 1_000).toISOString(),
			},
		]));

		expect(result.state).toBe("idle");
		expect(result.metrics.recentFileEditCount).toBe(0);
	});

	it("recognizes productive work after an idle transition", () => {
		const analyzer = new ArmActivityAnalyzer({
			config: { startupGracePeriodMs: 0 },
			log: () => {},
		});
		const now = Date.now();
		const result = analyzer.analyze(createWindow("arm-1", [
			{
				type: "session.status",
				armId: "arm-1",
				data: { status: { type: "idle" } },
				timestamp: new Date(now - 2_000).toISOString(),
			},
			{
				type: "file.edited",
				armId: "arm-1",
				data: { file: "src/example.ts" },
				timestamp: new Date(now - 1_000).toISOString(),
			},
		]));

		expect(result.state).toBe("productive");
		expect(result.metrics.recentFileEditCount).toBe(1);
	});

	it("does not keep an old error active after a successful idle transition", () => {
		const analyzer = new ArmActivityAnalyzer({
			config: { startupGracePeriodMs: 0 },
			log: () => {},
		});
		const now = Date.now();
		const result = analyzer.analyze(createWindow("arm-1", [
			{
				type: "session.error",
				armId: "arm-1",
				data: { error: "temporary" },
				timestamp: new Date(now - 2_000).toISOString(),
			},
			{
				type: "session.idle",
				armId: "arm-1",
				data: {},
				timestamp: new Date(now - 1_000).toISOString(),
			},
		]));

		expect(result.state).toBe("idle");
	});

	it("does not infer startup grace from the analyzer process lifetime", () => {
		const analyzer = new ArmActivityAnalyzer({ log: () => {} });
		const result = analyzer.analyze(createWindow("arm-1", [
			{
				type: "message.updated",
				armId: "arm-1",
				data: { info: { role: "assistant" } },
				timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
			},
		]));

		expect(result.state).not.toBe("starting");
	});

	it("classifies busy arm_status_synced as active work", () => {
		const analyzer = new ArmActivityAnalyzer({
			config: { startupGracePeriodMs: 0 },
			log: () => {},
		});
		const result = analyzer.analyze(createWindow("arm-1", [
			{
				type: "arm_status_synced",
				armId: "arm-1",
				data: { status: "busy" },
				timestamp: new Date().toISOString(),
			},
		]));

		expect(result.state).toBe("productive");
		expect(result.confidence).toBe("medium");
	});

	it("classifies prompt_sent as active work", () => {
		const analyzer = new ArmActivityAnalyzer({
			config: { startupGracePeriodMs: 0 },
			log: () => {},
		});
		const result = analyzer.analyze(createWindow("arm-1", [
			{
				type: "prompt_sent",
				armId: "arm-1",
				data: {},
				timestamp: new Date().toISOString(),
			},
		]));

		expect(result.state).toBe("productive");
		expect(result.confidence).toBe("medium");
	});

	it("classifies completed session compaction as idle", () => {
		const analyzer = new ArmActivityAnalyzer({
			config: { startupGracePeriodMs: 0 },
			log: () => {},
		});
		const result = analyzer.analyze(createWindow("arm-1", [
			{
				type: "session.compacted",
				armId: "arm-1",
				data: {},
				timestamp: new Date().toISOString(),
			},
		]));

		expect(result.state).toBe("idle");
		expect(result.confidence).toBe("medium");
	});
});
