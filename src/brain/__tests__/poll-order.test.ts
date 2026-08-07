import { describe, expect, it } from "bun:test";

import { Brain } from "../brain";

describe("Brain poll order", () => {
	it("runs idle prompting after status/task processing stages", async () => {
		const brain = new Brain({
			coleoDir: "/tmp",
			pollIntervalMs: 1000,
			verbose: false,
		});

		const calls: string[] = [];
		const record = (name: string): void => {
			calls.push(name);
		};

		(
			brain as unknown as {
				checkInfrastructureHealth: () => Promise<{
					healthy: boolean;
					issues: string[];
					canWorkWithArms: boolean;
					components: {
						apiServer: { healthy: boolean };
						database: { healthy: boolean };
						maildir: { healthy: boolean };
					};
				}>;
			}
		).checkInfrastructureHealth = async () => {
			record("checkInfrastructureHealth");
			return {
				healthy: true,
				issues: [],
				canWorkWithArms: true,
				components: {
					apiServer: { healthy: true },
					database: { healthy: true },
					maildir: { healthy: true },
				},
			};
		};

		(brain as unknown as { processHumanMail: () => Promise<void> }).processHumanMail =
			async () => {
				record("processHumanMail");
			};
		(brain as unknown as { processArmQueue: () => Promise<void> }).processArmQueue =
			async () => {
				record("processArmQueue");
			};
		(
			brain as unknown as {
				processOperationalSignals: (_since?: string) => Promise<void>;
			}
		).processOperationalSignals = async () => {
			record("processOperationalSignals");
		};
		(
			brain as unknown as { checkResolvedBugsAndResumeTasks: () => Promise<void> }
		).checkResolvedBugsAndResumeTasks = async () => {
			record("checkResolvedBugsAndResumeTasks");
		};
		(brain as unknown as { checkArms: () => Promise<void> }).checkArms = async () => {
			record("checkArms");
		};
		(brain as unknown as { loadTasks: () => Promise<void> }).loadTasks = async () => {
			record("loadTasks");
		};
		(
			brain as unknown as { processArmAssistantOutputs: () => Promise<void> }
		).processArmAssistantOutputs = async () => {
			record("processArmAssistantOutputs");
		};
		(brain as unknown as { assignTasks: () => Promise<void> }).assignTasks =
			async () => {
				record("assignTasks");
			};
		(brain as unknown as { reviewBlockedTasks: () => Promise<void> }).reviewBlockedTasks =
			async () => {
				record("reviewBlockedTasks");
			};
		(
			brain as unknown as { assignInitialTasks: () => Promise<void> }
		).assignInitialTasks = async () => {
			record("assignInitialTasks");
		};
		(brain as unknown as { syncPlanTasks: () => Promise<boolean> }).syncPlanTasks =
			async () => {
				record("syncPlanTasks");
				return true;
			};
		(brain as unknown as { processInbox: () => Promise<void> }).processInbox =
			async () => {
				record("processInbox");
			};
		(
			brain as unknown as { checkDocUpdateTrigger: () => Promise<void> }
		).checkDocUpdateTrigger = async () => {
			record("checkDocUpdateTrigger");
		};
		(
			brain as unknown as { reEvaluatePlanProgress: () => Promise<void> }
		).reEvaluatePlanProgress = async () => {
			record("reEvaluatePlanProgress");
		};
		(brain as unknown as { promptIdleArms: () => Promise<void> }).promptIdleArms =
			async () => {
				record("promptIdleArms");
			};
		(brain as unknown as { saveState: () => Promise<void> }).saveState = async () => {
			record("saveState");
		};
		(
			brain as unknown as {
				notifyObservatory: (_event: "poll") => Promise<void>;
			}
		).notifyObservatory = async () => {
			record("notifyObservatory");
		};

		(
			brain as unknown as {
				healthMonitor: { isMonitoring: () => boolean; start: () => void };
			}
		).healthMonitor = {
			isMonitoring: () => true,
			start: () => {
				record("healthMonitor.start");
			},
		};

		await brain.poll();

		expect(calls).toEqual([
			"checkInfrastructureHealth",
			"processHumanMail",
			"processArmQueue",
			"processOperationalSignals",
			"syncPlanTasks",
			"checkResolvedBugsAndResumeTasks",
			"checkArms",
			"loadTasks",
			"processArmAssistantOutputs",
			"loadTasks",
			"assignTasks",
			"reviewBlockedTasks",
			"assignInitialTasks",
			"processInbox",
			"checkDocUpdateTrigger",
			"reEvaluatePlanProgress",
			"promptIdleArms",
			"saveState",
			"notifyObservatory",
		]);
	});
});
