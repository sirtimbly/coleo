import { describe, expect, it } from "bun:test";
import { mapApiTask } from "../brain-utils";

describe("mapApiTask", () => {
	it("preserves blocked timestamps from the API", () => {
		const blockedAt = "2026-07-16T12:00:00.000Z";
		const task = mapApiTask({
			id: "task-blocked",
			subject: "Blocked task",
			description: "Waiting on a dependency",
			status: "blocked",
			priority: "high",
			createdAt: "2026-07-16T10:00:00.000Z",
			updatedAt: blockedAt,
			blockedAt,
		});

		expect(task.blockedAt).toEqual(new Date(blockedAt));
	});

	it("preserves source metadata from the API", () => {
		const task = mapApiTask({
			id: "maintenance-task",
			subject: "Maintenance task",
			description: "Run maintenance",
			status: "pending",
			priority: "normal",
			sourceType: "manual",
			sourceRef: "maintenance:docs",
			createdAt: "2026-07-16T10:00:00.000Z",
			updatedAt: "2026-07-16T10:00:00.000Z",
		});

		expect(task.sourceType).toBe("manual");
		expect(task.sourceRef).toBe("maintenance:docs");
	});
});
