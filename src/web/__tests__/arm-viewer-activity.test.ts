import { describe, expect, it } from "bun:test";
import {
	getViewerEventActivityId,
	isViewerHeartbeatActivity,
	upsertViewerActivity,
	type ViewerActivityItem,
} from "../src/pages/arm-viewer-activity";

function activity(id: string, timestamp: number): ViewerActivityItem {
	return {
		id,
		type: "session",
		title: id,
		status: "info",
		timestamp,
	};
}

describe("Arm Viewer activity history", () => {
	it("uses the stream sequence as a stable event identity", () => {
		const event = {
			type: "session.updated",
			properties: {},
			timestamp: "2026-07-21T12:00:00.000Z",
			sequence: 42,
		};

		expect(getViewerEventActivityId(event, "generic")).toBe("event-42-generic");
		expect(getViewerEventActivityId(event, "generic")).toBe("event-42-generic");
	});

	it("deduplicates, orders, and caps merged activity", () => {
		let activities: ViewerActivityItem[] = [];
		activities = upsertViewerActivity(activities, activity("three", 3), 3);
		activities = upsertViewerActivity(activities, activity("one", 1), 3);
		activities = upsertViewerActivity(activities, activity("two", 2), 3);
		activities = upsertViewerActivity(activities, activity("four", 4), 3);
		activities = upsertViewerActivity(
			activities,
			{ ...activity("three", 5), status: "completed" },
			3,
		);

		expect(activities.map((item) => item.id)).toEqual(["two", "four", "three"]);
		expect(activities.at(-1)?.status).toBe("completed");
	});

	it("does not let delayed history overwrite a newer live update", () => {
		const live = { ...activity("tool-1", 20), status: "completed" as const };
		const historical = { ...activity("tool-1", 10), status: "running" as const };

		expect(upsertViewerActivity([live], historical, 200)).toEqual([live]);
	});

	it("identifies heartbeat activity without hiding other health events", () => {
		expect(
			isViewerHeartbeatActivity({
				...activity("heartbeat", 1),
				details: { eventType: "arm.heartbeat" },
			}),
		).toBe(true);
		expect(
			isViewerHeartbeatActivity({
				...activity("health", 2),
				title: "Infrastructure alert",
				details: { eventType: "infrastructure_alert" },
			}),
		).toBe(false);
	});
});
