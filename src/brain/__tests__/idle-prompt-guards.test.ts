import { describe, expect, it } from "bun:test";
import { Brain } from "../brain";
import type { Arm } from "../../types";

describe("Brain idle prompt guards", () => {
	it("does not prompt an idle arm when harness reports processing", async () => {
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

		expect(promptCount).toBe(0);
		expect(syncCalls).toBe(1);
	});
});
