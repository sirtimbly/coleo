import { describe, expect, it } from "bun:test";

import { StatusEventsConsumer } from "../status-consumer";
import type { EventData } from "../jetstream";

function makeConsumer(entityType?: "arm" | "task" | "system", entityId?: string): StatusEventsConsumer {
	return new StatusEventsConsumer({
		name: "test-consumer",
		onStatusChange: () => {},
		entityType,
		entityId,
	});
}

describe("StatusEventsConsumer", () => {
	it("builds entity-aware JetStream filter subjects", () => {
		expect(
			(makeConsumer("arm") as unknown as { buildFilterSubjects: () => string[] }).buildFilterSubjects(),
		).toEqual(["coleo.events.arm.*.status_changed"]);
		expect(
			(makeConsumer("arm", "arm-1") as unknown as { buildFilterSubjects: () => string[] }).buildFilterSubjects(),
		).toEqual(["coleo.events.arm.arm-1.status_changed"]);
		expect(
			(makeConsumer("task") as unknown as { buildFilterSubjects: () => string[] }).buildFilterSubjects(),
		).toEqual(["coleo.events.task.*.status_changed"]);
		expect(
			(makeConsumer() as unknown as { buildFilterSubjects: () => string[] }).buildFilterSubjects(),
		).toEqual([
			"coleo.events.arm.*.status_changed",
			"coleo.events.task.*.status_changed",
			"coleo.events.system.status",
		]);
	});

	it("parses distributed arm status_changed events", () => {
		const event: EventData = {
			type: "arm.status_changed",
			armId: "arm-1",
			data: { from: "idle", to: "busy", agentId: "agent-1" },
			timestamp: "2026-07-09T21:00:00.000Z",
		};

		expect(makeConsumer("arm").parseStatusEvent(event)).toEqual({
			type: "arm.status_changed",
			entityId: "arm-1",
			oldStatus: "idle",
			newStatus: "busy",
			timestamp: "2026-07-09T21:00:00.000Z",
			data: event.data,
		});
	});

	it("parses legacy arm status_changed events", () => {
		const event: EventData = {
			type: "status_changed",
			armId: "arm-1",
			data: { oldStatus: "busy", newStatus: "idle" },
			timestamp: "2026-07-09T21:00:00.000Z",
		};

		expect(makeConsumer("arm").parseStatusEvent(event)?.newStatus).toBe("idle");
	});

	it("parses task and system status events", () => {
		const consumer = makeConsumer();
		const taskEvent: EventData = {
			type: "task.status_changed",
			data: { taskId: "task-1", from: "pending", to: "completed" },
			timestamp: "2026-07-09T21:00:00.000Z",
		};
		const systemEvent: EventData = {
			type: "system.status",
			data: { status: "healthy" },
			timestamp: "2026-07-09T21:00:01.000Z",
		};

		expect(consumer.parseStatusEvent(taskEvent)?.entityId).toBe("task-1");
		expect(consumer.parseStatusEvent(taskEvent)?.newStatus).toBe("completed");
		expect(consumer.parseStatusEvent(systemEvent)?.newStatus).toBe("healthy");
	});
});
