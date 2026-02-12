/**
 * ClaimConflictDetector Tests
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { ClaimConflictDetector } from "../claim-conflict-detector";
import type {
	ClaimConflictDetectorOptions,
	ClaimConflictDetectorCallbacks,
	ClaimConflict,
} from "../claim-conflict-detector";
import type { Task } from "../../../types";

describe("ClaimConflictDetector", () => {
	let detector: ClaimConflictDetector;
	let logs: string[] = [];
	let blockedTasks: Array<{ taskId: string; status: string }> = [];
	let notifications: Array<{ task: Task; conflicts: ClaimConflict[] }> = [];
	let resolutionAttempts: Array<{ task: Task; conflicts: ClaimConflict[] }> = [];

	const createMockCallbacks = (): ClaimConflictDetectorCallbacks => ({
		log: (message: string) => {
			logs.push(message);
		},
		getActiveFileClaims: async () => [],
		patchTaskStatus: async (taskId: string, status: string) => {
			blockedTasks.push({ taskId, status });
		},
		notifyHumanOfConflict: async (task: Task, conflicts: ClaimConflict[]) => {
			notifications.push({ task, conflicts });
		},
		attemptConflictResolution: async (task: Task, conflicts: ClaimConflict[]) => {
			resolutionAttempts.push({ task, conflicts });
		},
	});

	const createMockTask = (overrides: Partial<Task> = {}): Task => ({
		id: "task-1",
		subject: "Test Task",
		description: "Test description",
		status: "pending",
		priority: "normal",
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	});

	beforeEach(() => {
		logs = [];
		blockedTasks = [];
		notifications = [];
		resolutionAttempts = [];

		const options: ClaimConflictDetectorOptions = {
			resolveClaimsActive: false,
		};

		detector = new ClaimConflictDetector(options, createMockCallbacks());
	});

	describe("initialization", () => {
		it("should initialize with provided options", () => {
			expect(detector.getOptions().resolveClaimsActive).toBe(false);
		});

		it("should allow updating options", () => {
			detector.updateOptions({ resolveClaimsActive: true });
			expect(detector.getOptions().resolveClaimsActive).toBe(true);
		});
	});

	describe("file path extraction", () => {
		it("should extract file paths from artifacts", () => {
			const task = createMockTask({
				artifacts: ["src/file1.ts", "src/file2.ts"],
			});
			const files = detector.extractFilePathsFromTask(task);
			expect(files).toContain("src/file1.ts");
			expect(files).toContain("src/file2.ts");
		});

		it("should extract file paths from discoveries", () => {
			const task = createMockTask({
				context: {
					discoveries: [
						{
							id: "d1",
							kind: "test",
							title: "Test",
							details: "Test",
							filePath: "src/discovery.ts",
							severity: "info",
						},
					],
				},
			});
			const files = detector.extractFilePathsFromTask(task);
			expect(files).toContain("src/discovery.ts");
		});

		it("should extract file paths from description", () => {
			const task = createMockTask({
				description: "Fix the bug in src/components/Button.ts",
			});
			const files = detector.extractFilePathsFromTask(task);
			expect(files).toContain("src/components/Button.ts");
		});

		it("should remove duplicate file paths", () => {
			const task = createMockTask({
				artifacts: ["src/file.ts"],
				description: "Fix src/file.ts",
			});
			const files = detector.extractFilePathsFromTask(task);
			expect(files.length).toBe(1);
			expect(files[0]).toBe("src/file.ts");
		});

		it("should handle tasks with no file paths", () => {
			const task = createMockTask();
			const files = detector.extractFilePathsFromTask(task);
			expect(files.length).toBe(0);
		});
	});

	describe("conflict detection", () => {
		it("should find exact file path conflicts", () => {
			const taskFiles = ["src/file.ts"];
			const activeClaims: ClaimConflict[] = [
				{
					armId: "arm-1",
					filePath: "src/file.ts",
					claimType: "exclusive",
					claimedAt: "2024-01-01",
				},
			];

			const conflicts = detector.findConflicts(taskFiles, activeClaims);
			expect(conflicts.length).toBe(1);
			expect(conflicts[0]?.armId).toBe("arm-1");
		});

		it("should find directory conflicts", () => {
			const taskFiles = ["src/components/Button.tsx"];
			const activeClaims: ClaimConflict[] = [
				{
					armId: "arm-1",
					filePath: "src/components",
					claimType: "exclusive",
					claimedAt: "2024-01-01",
				},
			];

			const conflicts = detector.findConflicts(taskFiles, activeClaims);
			expect(conflicts.length).toBe(1);
		});

		it("should find reverse directory conflicts", () => {
			const taskFiles = ["src"];
			const activeClaims: ClaimConflict[] = [
				{
					armId: "arm-1",
					filePath: "src/components/Button.tsx",
					claimType: "exclusive",
					claimedAt: "2024-01-01",
				},
			];

			const conflicts = detector.findConflicts(taskFiles, activeClaims);
			expect(conflicts.length).toBe(1);
		});

		it("should normalize paths when comparing", () => {
			const taskFiles = ["./src/file.ts"];
			const activeClaims: ClaimConflict[] = [
				{
					armId: "arm-1",
					filePath: "/src/file.ts",
					claimType: "exclusive",
					claimedAt: "2024-01-01",
				},
			];

			const conflicts = detector.findConflicts(taskFiles, activeClaims);
			expect(conflicts.length).toBe(1);
		});

		it("should return empty array when no conflicts", () => {
			const taskFiles = ["src/file1.ts"];
			const activeClaims: ClaimConflict[] = [
				{
					armId: "arm-1",
					filePath: "src/file2.ts",
					claimType: "exclusive",
					claimedAt: "2024-01-01",
				},
			];

			const conflicts = detector.findConflicts(taskFiles, activeClaims);
			expect(conflicts.length).toBe(0);
		});
	});

	describe("conflict report generation", () => {
		it("should generate conflict report", () => {
			const task = createMockTask({
				subject: "Fix Bug",
				id: "task-123",
			});
			const conflicts: ClaimConflict[] = [
				{
					armId: "arm-1",
					filePath: "src/file.ts",
					claimType: "exclusive",
					claimedAt: "2024-01-01",
				},
			];

			const report = detector.generateConflictReport(task, conflicts);
			expect(report.subject).toContain("Fix Bug");
			expect(report.body).toContain("task-123");
			expect(report.body).toContain("arm-1");
			expect(report.body).toContain("src/file.ts");
		});
	});

	describe("checkAndBlockTasks", () => {
		it("should block tasks with conflicts", async () => {
			const callbacks = createMockCallbacks();
			callbacks.getActiveFileClaims = async () => [
				{
					armId: "arm-1",
					filePath: "src/file.ts",
					claimType: "exclusive",
					claimedAt: "2024-01-01",
				},
			];

			detector = new ClaimConflictDetector(
				{ resolveClaimsActive: false },
				callbacks,
			);

			const task = createMockTask({
				id: "task-1",
				description: "Fix src/file.ts",
			});

			await detector.checkAndBlockTasks([task]);

			expect(blockedTasks.length).toBe(1);
			expect(blockedTasks[0]?.taskId).toBe("task-1");
			expect(blockedTasks[0]?.status).toBe("blocked");
			expect(notifications.length).toBe(1);
		});

		it("should not block tasks without conflicts", async () => {
			const callbacks = createMockCallbacks();
			callbacks.getActiveFileClaims = async () => [];

			detector = new ClaimConflictDetector(
				{ resolveClaimsActive: false },
				callbacks,
			);

			const task = createMockTask({ id: "task-1" });
			await detector.checkAndBlockTasks([task]);

			expect(blockedTasks.length).toBe(0);
			expect(notifications.length).toBe(0);
		});

		it("should attempt resolution when enabled", async () => {
			const callbacks = createMockCallbacks();
			callbacks.getActiveFileClaims = async () => [
				{
					armId: "arm-1",
					filePath: "src/file.ts",
					claimType: "exclusive",
					claimedAt: "2024-01-01",
				},
			];

			detector = new ClaimConflictDetector(
				{ resolveClaimsActive: true },
				callbacks,
			);

			const task = createMockTask({
				id: "task-1",
				description: "Fix src/file.ts",
			});

			await detector.checkAndBlockTasks([task]);

			expect(resolutionAttempts.length).toBe(1);
		});

		it("should handle errors gracefully", async () => {
			const callbacks = createMockCallbacks();
			callbacks.getActiveFileClaims = async () => {
				throw new Error("Database error");
			};

			detector = new ClaimConflictDetector(
				{ resolveClaimsActive: false },
				callbacks,
			);

			const task = createMockTask({ id: "task-1" });
			await detector.checkAndBlockTasks([task]);

			// Should not throw, just log error
			expect(logs.length).toBeGreaterThan(0);
			expect(logs[0]).toContain("Error checking file claim conflicts");
		});
	});

	describe("checkTaskForConflicts", () => {
		it("should return conflicts when found", async () => {
			const callbacks = createMockCallbacks();
			callbacks.getActiveFileClaims = async () => [
				{
					armId: "arm-1",
					filePath: "src/file.ts",
					claimType: "exclusive",
					claimedAt: "2024-01-01",
				},
			];

			detector = new ClaimConflictDetector(
				{ resolveClaimsActive: false },
				callbacks,
			);

			const task = createMockTask({
				description: "Fix src/file.ts",
			});

			const result = await detector.checkTaskForConflicts(task);

			expect(result.hasConflict).toBe(true);
			expect(result.conflicts.length).toBe(1);
		});

		it("should return no conflicts when none found", async () => {
			const callbacks = createMockCallbacks();
			callbacks.getActiveFileClaims = async () => [];

			detector = new ClaimConflictDetector(
				{ resolveClaimsActive: false },
				callbacks,
			);

			const task = createMockTask();
			const result = await detector.checkTaskForConflicts(task);

			expect(result.hasConflict).toBe(false);
			expect(result.conflicts.length).toBe(0);
		});
	});
});
