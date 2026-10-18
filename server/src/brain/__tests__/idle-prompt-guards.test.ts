import { describe, expect, it } from "bun:test";
import { Brain } from "../brain";
import type { Arm } from "../../types";

describe("Brain idle prompt guards", () => {
	it("preserves a discovered busy arm state after a brain restart", async () => {
		const brain = new Brain({
			coleoDir: "/tmp",
			pollIntervalMs: 1000,
			verbose: false,
		});
		const patches: Array<Record<string, unknown>> = [];

		(
			brain as unknown as {
				listArmsFromApi: (_includeStopped?: boolean) => Promise<Array<Record<string, unknown>>>;
			}
		).listArmsFromApi = async () => [
			{
				id: "arm-1",
				name: "arm-1",
				pid: process.pid,
				status: "busy",
				domain: "general",
				harness: "manual",
			},
		];
		(
			brain as unknown as {
				patchArmViaApi: (_armId: string, patch: Record<string, unknown>) => Promise<void>;
			}
		).patchArmViaApi = async (_armId, patch) => {
			patches.push(patch);
		};
		(brain as unknown as { armStateMachine: unknown }).armStateMachine = null;

		await (brain as unknown as { scanForRunningArms: () => Promise<void> }).scanForRunningArms();

		expect(patches).toHaveLength(1);
		expect(patches[0]?.status).toBe("busy");
		expect(
			(brain as unknown as { arms: Map<string, Arm> }).arms.get("arm-1")?.status,
		).toBe("busy");
	});

	it("prompts an idle API arm when processing state has no recent progress", async () => {
		const brain = new Brain({
			coleoDir: "/tmp",
			pollIntervalMs: 1000,
			verbose: false,
		});

		const arm: Arm = {
			id: "arm-1",
			name: "arm-1",
			agent: "opencode-api",
			status: "idle",
			startedAt: new Date(),
		};

		(brain as unknown as { arms: Map<string, Arm> }).arms = new Map([
			[arm.id, arm],
		]);

		let promptCount = 0;
		let syncCalls = 0;

		(brain as unknown as { loadTasks: () => Promise<void> }).loadTasks =
			async () => {};
		(
			brain as unknown as {
				listTasksFromApi: (_opts?: unknown) => Promise<Array<{ id: string; status: string }>>;
			}
		).listTasksFromApi = async () => [{ id: "task-1", status: "pending" }];
		(
			brain as unknown as { isApiServerAvailable: () => Promise<boolean> }
		).isApiServerAvailable = async () => true;
		(brain as unknown as { isApiHarness: (_armId: string) => Promise<boolean> }).isApiHarness =
			async () => true;
		(
			brain as unknown as {
				getArmHarnessState: (_armId: string) => Promise<{ state: string; hasSession: boolean } | null>;
			}
		).getArmHarnessState = async () => ({ state: "processing", hasSession: true });
		(
			brain as unknown as {
				sendPromptToArm: (_armId: string, _prompt: string) => Promise<boolean>;
			}
		).sendPromptToArm = async () => {
			promptCount++;
			return true;
		};
		(brain as unknown as { syncArmStatus: (_armId: string, _status: "idle" | "busy" | "stopped") => Promise<void> }).syncArmStatus =
			async () => {
				syncCalls++;
			};
		(brain as unknown as { armStateMachine: unknown }).armStateMachine = null;
		(
			brain as unknown as {
				getBrainConfigNumber: (_key: string, defaultValue: number) => Promise<number>;
			}
		).getBrainConfigNumber = async (_key, defaultValue) => defaultValue;
		(
			brain as unknown as {
				armDetectionTimes: Map<string, Date>;
			}
		).armDetectionTimes = new Map();
		(
			brain as unknown as {
				getRecentArmActivitySignal: (_armId: string, _thresholdMs: number) => Promise<{ recent: boolean; reason?: string }>;
			}
		).getRecentArmActivitySignal = async () => ({ recent: false });

		await (
			brain as unknown as { promptIdleArms: () => Promise<void> }
		).promptIdleArms();

		expect(promptCount).toBe(1);
		expect(syncCalls).toBe(0);
	});

	it("marks a busy API arm idle when processing state has gone stale", async () => {
		const brain = new Brain({
			coleoDir: "/tmp",
			pollIntervalMs: 1000,
			verbose: false,
		});
		const arm: Arm = {
			id: "arm-stale",
			name: "Stale arm",
			agent: "opencode-api",
			status: "busy",
			startedAt: new Date(Date.now() - 20 * 60 * 1000),
		};
		(brain as unknown as { arms: Map<string, Arm> }).arms = new Map([[arm.id, arm]]);
		(
			brain as unknown as {
				getArmHarnessState: (_armId: string) => Promise<{ state: string; hasSession: boolean }>;
			}
		).getArmHarnessState = async () => ({ state: "processing", hasSession: true });
		(brain as unknown as { isApiHarness: (_armId: string) => Promise<boolean> }).isApiHarness =
			async () => true;
		(
			brain as unknown as {
				getBrainConfigNumber: (_key: string, defaultValue: number) => Promise<number>;
			}
		).getBrainConfigNumber = async (_key, defaultValue) => defaultValue;
		(
			brain as unknown as {
				getRecentArmActivitySignal: (_armId: string, _thresholdMs: number) => Promise<{ recent: boolean }>;
			}
		).getRecentArmActivitySignal = async () => ({ recent: false });
		const statuses: string[] = [];
		(
			brain as unknown as {
				syncArmStatus: (_armId: string, status: "idle" | "busy" | "stopped") => Promise<void>;
			}
		).syncArmStatus = async (_armId, status) => {
			statuses.push(status);
		};

		await (brain as unknown as { checkStuckArms: () => Promise<void> }).checkStuckArms();

		expect(statuses).toEqual(["idle"]);
		expect(arm.status).toBe("idle");
	});

	it("keeps a processing API arm busy while message progress is recent", async () => {
		const brain = new Brain({
			coleoDir: "/tmp",
			pollIntervalMs: 1000,
			verbose: false,
		});
		const arm: Arm = {
			id: "arm-active",
			name: "Active arm",
			agent: "opencode-api",
			status: "busy",
			startedAt: new Date(Date.now() - 20 * 60 * 1000),
		};
		(brain as unknown as { arms: Map<string, Arm> }).arms = new Map([[arm.id, arm]]);
		(
			brain as unknown as {
				getArmHarnessState: (_armId: string) => Promise<{ state: string; hasSession: boolean }>;
			}
		).getArmHarnessState = async () => ({ state: "processing", hasSession: true });
		(brain as unknown as { isApiHarness: (_armId: string) => Promise<boolean> }).isApiHarness =
			async () => true;
		(
			brain as unknown as {
				getBrainConfigNumber: (_key: string, defaultValue: number) => Promise<number>;
			}
		).getBrainConfigNumber = async (_key, defaultValue) => defaultValue;
		(
			brain as unknown as {
				getRecentArmActivitySignal: (_armId: string, _thresholdMs: number) => Promise<{ recent: boolean; reason: string }>;
			}
		).getRecentArmActivitySignal = async () => ({
			recent: true,
			reason: "recent session message 12s ago",
		});
		const statuses: string[] = [];
		(
			brain as unknown as {
				syncArmStatus: (_armId: string, status: "idle" | "busy" | "stopped") => Promise<void>;
			}
		).syncArmStatus = async (_armId, status) => {
			statuses.push(status);
		};

		await (brain as unknown as { checkStuckArms: () => Promise<void> }).checkStuckArms();

		expect(statuses).toEqual([]);
		expect(arm.status).toBe("busy");
	});
});
