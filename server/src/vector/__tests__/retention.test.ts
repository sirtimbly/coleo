import { describe, expect, it, spyOn, afterEach } from "bun:test";
import {
	buildExpiredFilter,
	computeRetentionPlan,
	applyStatusHistoryRetention,
} from "../retention";
import { getRetentionDaysForType, STATUS_HISTORY_RETENTION_DAYS } from "../status-history";
import { qdrantStore } from "../../qdrant";
import { getProjectCollectionName } from "../../project-scope";

describe("status history retention", () => {
	afterEach(() => {
		// restore env overrides used in tests
		delete process.env.COLEO_STATUS_HISTORY_RETENTION_STATUS_REPORT;
		delete process.env.COLEO_STATUS_HISTORY_RETENTION_ARM_EVENT;
	});

	it("keeps task completions and critical types forever", () => {
		expect(STATUS_HISTORY_RETENTION_DAYS.task_completion).toBeNull();
		expect(STATUS_HISTORY_RETENTION_DAYS.discovery).toBeNull();
		expect(STATUS_HISTORY_RETENTION_DAYS.bug_report).toBeNull();
		expect(getRetentionDaysForType("task_completion")).toBeNull();
	});

	it("defaults status_report to 90 days and arm_event to 7", () => {
		expect(getRetentionDaysForType("status_report")).toBe(90);
		expect(getRetentionDaysForType("arm_event")).toBe(7);
	});

	it("allows env override of retention days", () => {
		process.env.COLEO_STATUS_HISTORY_RETENTION_STATUS_REPORT = "14";
		expect(getRetentionDaysForType("status_report")).toBe(14);
		process.env.COLEO_STATUS_HISTORY_RETENTION_ARM_EVENT = "forever";
		expect(getRetentionDaysForType("arm_event")).toBeNull();
	});

	it("builds Qdrant filter for expired points", () => {
		const filter = buildExpiredFilter("status_report", "2026-01-01T00:00:00.000Z");
		expect(filter).toEqual({
			must: [
				{ key: "type", match: { value: "status_report" } },
				{ key: "timestamp", range: { lt: "2026-01-01T00:00:00.000Z" } },
			],
		});
	});

	it("computeRetentionPlan sets cutoffs relative to now", () => {
		const now = new Date("2026-07-10T00:00:00.000Z");
		const plan = computeRetentionPlan(now, ["status_report", "task_completion", "arm_event"]);
		const status = plan.find((p) => p.type === "status_report");
		const forever = plan.find((p) => p.type === "task_completion");
		const arm = plan.find((p) => p.type === "arm_event");

		expect(forever?.cutoff).toBeNull();
		expect(status?.days).toBe(90);
		expect(status?.cutoff).toBe(
			new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString(),
		);
		expect(arm?.days).toBe(7);
	});

	it("applyStatusHistoryRetention dry-run does not call Qdrant delete", async () => {
		const deleteSpy = spyOn(qdrantStore, "deleteByFilter").mockImplementation(async () => {});
		const initSpy = spyOn(qdrantStore, "initialize").mockImplementation(async () => {});

		const result = await applyStatusHistoryRetention({ dryRun: true });

		expect(result.dryRun).toBe(true);
		expect(deleteSpy).not.toHaveBeenCalled();
		expect(initSpy).not.toHaveBeenCalled();
		expect(result.results.some((r) => r.type === "task_completion" && r.reason === "forever")).toBe(
			true,
		);
		expect(result.results.some((r) => r.type === "status_report" && r.reason?.startsWith("dry-run"))).toBe(
			true,
		);

		deleteSpy.mockRestore();
		initSpy.mockRestore();
	});

	it("applyStatusHistoryRetention deletes expired types only", async () => {
		const deleteSpy = spyOn(qdrantStore, "deleteByFilter").mockImplementation(async () => {});
		const initSpy = spyOn(qdrantStore, "initialize").mockImplementation(async () => {});

		const result = await applyStatusHistoryRetention({
			dryRun: false,
			types: ["status_report", "task_completion", "arm_event"],
		});

		expect(initSpy).toHaveBeenCalled();
		// forever types not deleted
		expect(result.purgedTypes).toContain("status_report");
		expect(result.purgedTypes).toContain("arm_event");
		expect(result.purgedTypes).not.toContain("task_completion");
		expect(deleteSpy).toHaveBeenCalledTimes(2);
		expect(deleteSpy.mock.calls.every(([collection]) => (
			collection === getProjectCollectionName("status-history")
		))).toBe(true);

		deleteSpy.mockRestore();
		initSpy.mockRestore();
	});
});
