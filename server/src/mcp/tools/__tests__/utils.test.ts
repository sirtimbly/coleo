import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createTestEventStore, resetEventStore, setEventStore } from "../../../nats/jetstream";
import { logActivity } from "../utils";

describe("MCP tool logActivity", () => {
	let store: ReturnType<typeof createTestEventStore>;

	beforeEach(() => {
		store = createTestEventStore();
		setEventStore(store);
	});

	afterEach(() => {
		resetEventStore();
	});

	it("publishes mapped task status report events to arm and task streams", async () => {
		logActivity("arm-1", "submit_status_report", "task-9", {
			status: "on_track",
			summary: "status summary text",
			issues: ["issue-1"],
			testsStatus: "passing",
		});

		await Promise.resolve();
		const events = store.getAllEvents();

		const armEvent = events.find((entry) =>
			entry.subject === "coleo.events.arm.arm-1.task.status_reported"
		);
		const taskEvent = events.find((entry) =>
			entry.subject === "coleo.events.task.task-9.task.status_reported"
		);

		expect(armEvent?.data.type).toBe("task.status_reported");
		expect(taskEvent?.data.type).toBe("task.status_reported");
		expect(taskEvent?.data.armId).toBe("arm-1");
		expect(armEvent?.data.data).toMatchObject({
			actor: "arm-1",
			action: "submit_status_report",
			target: "task-9",
			status: "on_track",
			summary: "status summary text",
			issues: ["issue-1"],
			testsStatus: "passing",
		});
		expect(taskEvent?.data.data).toMatchObject({
			actor: "arm-1",
			action: "submit_status_report",
			target: "task-9",
			summary: "status summary text",
			testsStatus: "passing",
		});
	});

	it("publishes non-task actions to MCP visibility stream", async () => {
		logActivity("arm-2", "heartbeat", undefined, { status: "ok" });

		await Promise.resolve();
		const events = store.getAllEvents();

		const armEvent = events.find((entry) =>
			entry.subject === "coleo.events.arm.arm-2.heartbeat"
		);
		const mcpEvent = events.find((entry) =>
			entry.subject === "coleo.events.mcp.heartbeat"
		);

		expect(armEvent?.data.type).toBe("heartbeat");
		expect(mcpEvent?.data.type).toBe("heartbeat");
		expect(mcpEvent?.data.data).toMatchObject({ actor: "arm-2", status: "ok" });
	});
});
