/**
 * BrainStateManager Tests
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { BrainStateManager } from "../state-manager";
import type { StateManagerOptions } from "../state-types";
import type { BrainState, Task, Arm } from "../../../types";

describe("BrainStateManager", () => {
	let manager: BrainStateManager;
	const options: StateManagerOptions = {
		coleoDir: "/tmp/test",
		pollIntervalMs: 1000,
		verbose: false,
		apiBaseUrl: "http://localhost:8080",
		apiKey: "test-key",
	};

	beforeEach(() => {
		manager = new BrainStateManager(options);
	});

	describe("initialization", () => {
		it("should initialize with correct default state", () => {
			const state = manager.getState();
			expect(state.status).toBe("stopped");
			expect(state.pollIntervalMs).toBe(1000);
			expect(state.activeArms).toEqual([]);
			expect(state.pendingTasks).toBe(0);
			expect(state.completedToday).toBe(0);
		});

		it("should not be running initially", () => {
			expect(manager.isRunning()).toBe(false);
		});

		it("should not be shutting down initially", () => {
			expect(manager.isShuttingDown()).toBe(false);
		});
	});

	describe("state updates", () => {
		it("should update state properties", () => {
			manager.updateState({ status: "running" });
			expect(manager.getState().status).toBe("running");
		});

		it("should set status directly", () => {
			manager.setStatus("running");
			expect(manager.getState().status).toBe("running");
		});

		it("should track running state", () => {
			manager.setRunning(true);
			expect(manager.isRunning()).toBe(true);
		});

		it("should track shutting down state", () => {
			manager.setShuttingDown(true);
			expect(manager.isShuttingDown()).toBe(true);
		});
	});

	describe("arm management", () => {
		const mockArm: Arm = {
			id: "arm-1",
			name: "Test Arm",
			agent: "opencode",
			status: "idle",
			startedAt: new Date(),
		};

		it("should add an arm", () => {
			manager.addArm(mockArm);
			expect(manager.getArmCount()).toBe(1);
			expect(manager.getArm("arm-1")).toEqual(mockArm);
		});

		it("should remove an arm", () => {
			manager.addArm(mockArm);
			const result = manager.removeArm("arm-1");
			expect(result).toBe(true);
			expect(manager.getArmCount()).toBe(0);
		});

		it("should return false when removing non-existent arm", () => {
			const result = manager.removeArm("non-existent");
			expect(result).toBe(false);
		});

		it("should check if arm exists", () => {
			manager.addArm(mockArm);
			expect(manager.hasArm("arm-1")).toBe(true);
			expect(manager.hasArm("arm-2")).toBe(false);
		});
	});

	describe("task management", () => {
		const mockTask: Task = {
			id: "task-1",
			subject: "Test Task",
			description: "Test description",
			status: "pending",
			priority: "normal",
			createdAt: new Date(),
			updatedAt: new Date(),
		};

		it("should add a task", () => {
			manager.addTask(mockTask);
			expect(manager.getTasks().length).toBe(1);
		});

		it("should set tasks", () => {
			manager.setTasks([mockTask]);
			expect(manager.getTasks().length).toBe(1);
		});

		it("should remove a task", () => {
			manager.addTask(mockTask);
			const result = manager.removeTask("task-1");
			expect(result).toBe(true);
			expect(manager.getTasks().length).toBe(0);
		});

		it("should return false when removing non-existent task", () => {
			const result = manager.removeTask("non-existent");
			expect(result).toBe(false);
		});

		it("should count pending tasks", () => {
			manager.addTask({ ...mockTask, status: "pending" });
			manager.addTask({ ...mockTask, id: "task-2", status: "in_progress" });
			expect(manager.getPendingTaskCount()).toBe(1);
		});
	});

	describe("tracking", () => {
		it("should track arm event times", () => {
			const now = new Date();
			manager.setLastArmEventTime("arm-1", now);
			expect(manager.getLastArmEventTime("arm-1")).toEqual(now);
		});

		it("should track arm detection times", () => {
			const now = new Date();
			manager.setArmDetectionTime("arm-1", now);
			expect(manager.getArmDetectionTime("arm-1")).toEqual(now);
		});
	});

	describe("file subscriptions", () => {
		it("should set file subscriptions", () => {
			const files = new Set(["file1.ts", "file2.ts"]);
			manager.setFileSubscriptions("arm-1", files);
			expect(manager.getFileSubscriptions("arm-1")).toEqual(files);
		});

		it("should add file subscriptions", () => {
			manager.addFileSubscription("arm-1", "file1.ts");
			manager.addFileSubscription("arm-1", "file2.ts");
			const subs = manager.getFileSubscriptions("arm-1");
			expect(subs?.has("file1.ts")).toBe(true);
			expect(subs?.has("file2.ts")).toBe(true);
		});

		it("should remove file subscriptions", () => {
			manager.addFileSubscription("arm-1", "file1.ts");
			const result = manager.removeFileSubscription("arm-1", "file1.ts");
			expect(result).toBe(true);
			expect(manager.getFileSubscriptions("arm-1")?.has("file1.ts")).toBe(false);
		});
	});

	describe("plan file hashes", () => {
		it("should set and get plan file hashes", () => {
			manager.setPlanFileHash("/path/to/plan.md", "abc123");
			expect(manager.getPlanFileHash("/path/to/plan.md")).toBe("abc123");
		});
	});

	describe("infrastructure health", () => {
		it("should update database health", () => {
			manager.updateInfrastructureHealth("database", true);
			const health = manager.getInfrastructureHealth();
			expect(health.database.healthy).toBe(true);
			expect(health.database.lastCheck).not.toBeNull();
		});

		it("should update API server health with error", () => {
			manager.updateInfrastructureHealth("apiServer", false, "Connection refused");
			const health = manager.getInfrastructureHealth();
			expect(health.apiServer.healthy).toBe(false);
			expect(health.apiServer.error).toBe("Connection refused");
		});

		it("should update NATS health", () => {
			manager.updateInfrastructureHealth("nats", true);
			const health = manager.getInfrastructureHealth();
			expect(health.nats.healthy).toBe(true);
			expect(health.nats.optional).toBe(true);
		});
	});

	describe("task completion tracking", () => {
		it("should increment completed task count", () => {
			manager.incrementCompletedTaskCount();
			expect(manager.getCompletedTaskCount()).toBe(1);
			expect(manager.getState().completedTaskCount).toBe(1);
		});
	});

	describe("claims resolution", () => {
		it("should track claims resolution state", () => {
			expect(manager.isResolveClaimsActive()).toBe(false);
			manager.setResolveClaimsActive(true);
			expect(manager.isResolveClaimsActive()).toBe(true);
		});
	});

	describe("snapshots", () => {
		it("should create and restore snapshots", () => {
			manager.setRunning(true);
			manager.incrementCompletedTaskCount();
			
			const snapshot = manager.createSnapshot();
			expect(snapshot.running).toBe(true);
			expect(snapshot.completedTaskCount).toBe(1);
			
			manager.setRunning(false);
			manager.restoreSnapshot(snapshot);
			expect(manager.isRunning()).toBe(true);
			expect(manager.getCompletedTaskCount()).toBe(1);
		});
	});

	describe("subscriptions", () => {
		it("should notify listeners on state changes", () => {
			const changes: Array<{ property: string; oldValue: unknown; newValue: unknown }> = [];
			const unsubscribe = manager.subscribe((change) => {
				changes.push(change);
			});
			
			manager.setRunning(true);
			expect(changes.length).toBeGreaterThan(0);
			expect(changes[0]?.property).toBe("running");
			
			unsubscribe();
		});

		it("should allow unsubscribing", () => {
			let callCount = 0;
			const unsubscribe = manager.subscribe(() => {
				callCount++;
			});
			
			unsubscribe();
			manager.setRunning(true);
			expect(callCount).toBe(0);
		});
	});

	describe("cleanup", () => {
		it("should clear all state", () => {
			manager.addArm({ id: "arm-1", name: "Test", agent: "opencode", status: "idle", startedAt: new Date() });
			manager.addTask({ id: "task-1", subject: "Test", description: "Test", status: "pending", priority: "normal", createdAt: new Date(), updatedAt: new Date() });
			
			manager.clear();
			
			expect(manager.getArmCount()).toBe(0);
			expect(manager.getTasks().length).toBe(0);
		});
	});

	describe("abort controller", () => {
		it("should set and get abort controller", () => {
			const controller = new AbortController();
			manager.setAbortController(controller);
			expect(manager.getAbortController()).toBe(controller);
		});

		it("should abort and clear controller", () => {
			const controller = new AbortController();
			let aborted = false;
			controller.signal.addEventListener("abort", () => {
				aborted = true;
			});
			
			manager.setAbortController(controller);
			manager.abort();
			
			expect(aborted).toBe(true);
			expect(manager.getAbortController()).toBeNull();
		});
	});
});
