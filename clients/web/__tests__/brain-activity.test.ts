import { describe, expect, it } from "bun:test";

import {
	formatBrainActivity,
	mergeBrainActivity,
	parseBrainActivityEntry,
} from "../src/pages/brain-activity";
import type { ActivityEntry } from "../src/lib/api";

function activity(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
	return {
		id: "activity-1",
		sequence: 1,
		timestamp: "2026-07-30T12:00:00.000Z",
		actor: "brain",
		action: "poll_completed",
		target: null,
		details: { pendingTasks: 2, activeArms: 3, durationMs: 1200 },
		...overrides,
	};
}

describe("Brain activity formatting", () => {
	it("summarizes structured poll and intervention activity", () => {
		expect(formatBrainActivity(activity())).toMatchObject({
			category: "operations",
			title: "Poll completed",
			summary: "2 pending tasks, 3 active arms in 1.2s",
		});
		expect(formatBrainActivity(activity({
			action: "arm_stuck_detected",
			target: "arm-a",
			details: { reasoning: "Repeated the same command" },
		}))).toMatchObject({
			category: "arms",
			tone: "warning",
			summary: "arm-a: Repeated the same command",
		});
	});

	it("deduplicates history and live events while retaining append-log order", () => {
		const first = activity();
		const older = activity({ id: "older", sequence: 0, timestamp: "2026-07-30T11:59:00.000Z" });
		const live = activity({ id: "live", sequence: null, timestamp: "2026-07-30T12:01:00.000Z" });

		expect(mergeBrainActivity([first], [live, older, first]).map((entry) => entry.id)).toEqual([
			"older",
			"activity-1",
			"live",
		]);
	});

	it("accepts normalized WebSocket activity entries", () => {
		expect(parseBrainActivityEntry(activity())).toEqual(activity());
		expect(parseBrainActivityEntry({ actor: "brain" })).toBeNull();
	});
});
