import { describe, expect, it } from "bun:test";
import { statusReportToHistoryEvent } from "../../scripts/backfill-status-history";

describe("statusReportToHistoryEvent", () => {
	it("maps SQLite status_reports row to StatusHistoryEvent", () => {
		const event = statusReportToHistoryEvent({
			id: "rep-1",
			task_id: "task-9",
			arm_id: "arm-alpha",
			status: "blocked",
			summary: "Waiting on Docker credentials",
			issues: JSON.stringify(["cannot pull qdrant"]),
			blockers: JSON.stringify(["org sign-in"]),
			next_steps: "Authenticate Docker Desktop",
			files_changed: JSON.stringify(["docker-compose.yml"]),
			tests_status: "not_run",
			created_at: "2026-07-01 12:00:00",
		});

		expect(event.id).toBe("status-report-rep-1");
		expect(event.type).toBe("status_report");
		expect(event.armId).toBe("arm-alpha");
		expect(event.taskId).toBe("task-9");
		expect(event.status).toBe("blocked");
		expect(event.source).toBe("arm-alpha");
		expect(event.content).toContain("Waiting on Docker credentials");
		expect(event.content).toContain("cannot pull qdrant");
		expect(event.content).toContain("org sign-in");
		expect(event.content).toContain("Authenticate Docker Desktop");
		expect(event.metadata.backfill).toBe(true);
		expect(event.timestamp).toContain("2026-07-01");
	});

	it("handles empty JSON arrays and ISO timestamps", () => {
		const event = statusReportToHistoryEvent({
			id: "rep-2",
			task_id: "t1",
			arm_id: "a1",
			status: "on_track",
			summary: "All good",
			issues: "[]",
			blockers: "[]",
			next_steps: null,
			files_changed: "[]",
			tests_status: null,
			created_at: "2026-07-10T15:00:00.000Z",
		});

		expect(event.timestamp).toBe("2026-07-10T15:00:00.000Z");
		expect(event.content).toBe("All good");
		expect(event.metadata.issues).toEqual([]);
	});
});
