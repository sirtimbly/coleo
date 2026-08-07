import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { Brain } from "../brain";
import type { Arm, Task } from "../../types";
import type { PlanFormatter } from "../../project-setup/service";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("Brain plan synchronization", () => {
  it("recreates unchanged plan tasks after the task database is replaced", async () => {
    const { brain, syncPlanTasks, task } = await createPlanSyncFixture();
    let createCalls = 0;
    const databaseIds = ["database-one", "database-two"];

    setPlanSyncApi(brain, {
      databaseInstanceId: async () => databaseIds.shift() || "database-two",
      listTasks: async () => [],
      createTask: async () => {
        createCalls += 1;
        return task;
      },
    });

    await syncPlanTasks();
    await syncPlanTasks();

    expect(createCalls).toBe(2);
  });

  it("preserves intentional task deletion within the same database", async () => {
    const { brain, syncPlanTasks, task } = await createPlanSyncFixture();
    let createCalls = 0;

    setPlanSyncApi(brain, {
      databaseInstanceId: async () => "database-one",
      listTasks: async () => [],
      createTask: async () => {
        createCalls += 1;
        return task;
      },
    });

    await syncPlanTasks();
    await syncPlanTasks();

    expect(createCalls).toBe(1);
  });

  it("retries an unchanged plan when task creation fails", async () => {
    const { brain, syncPlanTasks, task } = await createPlanSyncFixture();
    let createCalls = 0;

    setPlanSyncApi(brain, {
      databaseInstanceId: async () => "database-one",
      listTasks: async () => [],
      createTask: async () => {
        createCalls += 1;
        return createCalls === 1 ? null : task;
      },
    });

    await syncPlanTasks();
    await syncPlanTasks();

    expect(createCalls).toBe(2);
  });

	it("uses the evaluated plan order when creating a new project queue", async () => {
		const { brain, syncPlanTasks, task } = await createPlanSyncFixture(async () => ({
			mode: "ai",
			content: `# Plan

## Phase 1: Foundation

Choose the stack before feature implementation.

### Tasks
- [ ] Choose the server and frontend stack
- [ ] Implement the first technical requirement
`,
		}));
		const createdSubjects: string[] = [];
		setPlanSyncApi(brain, {
			databaseInstanceId: async () => "database-one",
			listTasks: async () => [],
			createTask: async (input) => {
				createdSubjects.push(input.subject);
				return { ...task, id: input.id || task.id, subject: input.subject };
			},
		});

		expect(await syncPlanTasks()).toBe(true);
		expect(createdSubjects).toEqual([
			"Choose the server and frontend stack",
			"Implement the first technical requirement",
		]);
	});

	it("notifies the user before blocking every active task when planning fails", async () => {
		const { brain, syncPlanTasks, task } = await createPlanSyncFixture(async () => {
			throw new Error("The plan is missing a deployable architecture");
		});
		const events: string[] = [];
		const notifications: Array<{ subject: string; body: string }> = [];
		setPlanSyncApi(brain, {
			databaseInstanceId: async () => "database-one",
			listTasks: async () => [task],
			createTask: async () => task,
			patchTask: async (_taskId, patch) => {
				events.push(`block:${patch.blockedCategory}`);
				return { ...task, status: patch.status || task.status };
			},
			sendToHuman: async (message) => {
				notifications.push(message);
				events.push("mail");
			},
			listArms: async () => [{
				id: "arm-1",
				status: "busy",
				currentTaskId: task.id,
			}],
			sendPromptToArm: async (_armId, _prompt, options) => {
				events.push(`interrupt:${options?.interrupt === true}`);
				return true;
			},
			patchArm: async (_armId, patch) => {
				events.push(`arm:${patch.status}`);
				return true;
			},
		});

		expect(await syncPlanTasks()).toBe(false);
		expect(events).toEqual([
			"mail",
			"interrupt:true",
			"arm:planning_blocked",
			"block:planning",
		]);
		expect(notifications[0]?.body).toContain("Problem: The plan is missing a deployable architecture");
		expect(notifications[0]?.body).toContain("What to change: Review .project/plan.md");
	});

	it("retains the persisted planning cause after Brain state is reinitialized", async () => {
		const { brain, syncPlanTasks, task } = await createPlanSyncFixture(async () => {
			throw new Error("The plan is missing a deployable architecture");
		});
		let storedTask = task;
		const notifications: Array<{ subject: string; body: string }> = [];
		setPlanSyncApi(brain, {
			databaseInstanceId: async () => "database-one",
			listTasks: async () => [storedTask],
			createTask: async () => storedTask,
			patchTask: async (_taskId, patch) => {
				storedTask = { ...storedTask, ...patch };
				return storedTask;
			},
			sendToHuman: async (message) => {
				notifications.push(message);
			},
		});

		expect(await syncPlanTasks()).toBe(false);
		const privateBrain = brain as unknown as {
			planningErrorsByPlanHash: Map<string, string>;
			lastPlanningFailureFingerprint: string | null;
		};
		privateBrain.planningErrorsByPlanHash.clear();
		privateBrain.lastPlanningFailureFingerprint = null;
		expect(await syncPlanTasks()).toBe(false);

		expect(notifications).toHaveLength(2);
		expect(notifications[1]?.body).toContain("Problem: The plan is missing a deployable architecture");
		expect(notifications[1]?.body).not.toContain("project plan is still in the planning-failure state");
	});

	it("retries an unchanged plan after a provider failure and sends actionable guidance", async () => {
		let formatterCalls = 0;
		const { brain, syncPlanTasks, task } = await createPlanSyncFixture(async (content) => {
			formatterCalls += 1;
			if (formatterCalls === 1) {
				throw new Error("Plan formatter returned 500 Internal Server Error: provider overloaded");
			}
			return { content, mode: "ai" };
		});
		let storedTask = task;
		const notifications: Array<{ subject: string; body: string }> = [];
		setPlanSyncApi(brain, {
			databaseInstanceId: async () => "database-one",
			listTasks: async () => [storedTask],
			createTask: async () => storedTask,
			patchTask: async (_taskId, patch) => {
				storedTask = { ...storedTask, ...patch };
				return storedTask;
			},
			sendToHuman: async (message) => {
				notifications.push(message);
			},
		});

		expect(await syncPlanTasks()).toBe(false);
		expect(await syncPlanTasks()).toBe(true);
		expect(formatterCalls).toBe(2);
		expect(notifications).toHaveLength(1);
		expect(notifications[0]?.body).toContain(
			"The model provider failed before it could assess the plan",
		);
		expect(notifications[0]?.body).toContain("The plan documents do not need to change");
		expect(notifications[0]?.body).toContain("retry the unchanged plan automatically");
	});

	it("retries an unchanged plan when formatter output omits source context", async () => {
		let formatterCalls = 0;
		const { brain, syncPlanTasks, task } = await createPlanSyncFixture(async (content) => {
			formatterCalls += 1;
			if (formatterCalls === 1) throw new Error("Plan formatter omitted source context");
			return { content, mode: "ai" };
		});
		let storedTask = task;
		setPlanSyncApi(brain, {
			databaseInstanceId: async () => "database-one",
			listTasks: async () => [storedTask],
			createTask: async () => storedTask,
			patchTask: async (_taskId, patch) => {
				storedTask = { ...storedTask, ...patch };
				return storedTask;
			},
		});

		expect(await syncPlanTasks()).toBe(false);
		expect(await syncPlanTasks()).toBe(true);
		expect(formatterCalls).toBe(2);
	});

	it("resumes only system-owned planning blockers with a planning-state marker", async () => {
		const { brain, task } = await createPlanSyncFixture();
		const patched: string[] = [];
		const privateBrain = brain as unknown as {
			listAllTasksFromApi: () => Promise<Task[]>;
			patchTaskViaApi: (taskId: string, patch: Partial<Task>) => Promise<Task | null>;
			resumePlanningBlockedTasks: () => Promise<void>;
		};
		privateBrain.listAllTasksFromApi = async () => [
			{
				...task,
				id: "system-planning",
				status: "blocked",
				blockedCategory: "planning",
				blockedReason: "Planning failed [planning-state:abc123]",
			},
			{
				...task,
				id: "untrusted-planning",
				status: "blocked",
				blockedCategory: "planning",
				blockedReason: "Arm supplied this category",
			},
		];
		privateBrain.patchTaskViaApi = async (taskId) => {
			patched.push(taskId);
			return task;
		};

		await privateBrain.resumePlanningBlockedTasks();

		expect(patched).toEqual(["system-planning"]);
	});

	it("delivers and clears a deferred startup prompt for an initialized arm", async () => {
		const { brain } = await createPlanSyncFixture();
		const prompts: string[] = [];
		const configs: Record<string, unknown>[] = [];
		const privateBrain = brain as unknown as {
			arms: Map<string, Arm>;
			templates: { loadInitialArmPrompt: () => Promise<string> };
			getArmFromApi: () => Promise<{
				id: string;
				name: string;
				domain: string;
				harness: string;
				status: string;
				config: Record<string, unknown>;
			}>;
			hasReceivedInitialTasks: () => Promise<boolean>;
			sendPromptToArm: (_armId: string, prompt: string) => Promise<boolean>;
			patchArmViaApi: (
				_armId: string,
				patch: { config?: Record<string, unknown> },
			) => Promise<boolean>;
			logActivity: () => void;
			assignInitialTasks: () => Promise<void>;
		};
		privateBrain.arms.set("arm-1", {
			id: "arm-1",
			name: "Arm 1",
			agent: "opencode",
			status: "idle",
			startedAt: new Date(),
		});
		privateBrain.templates.loadInitialArmPrompt = async () => "Common instructions";
		privateBrain.getArmFromApi = async () => ({
			id: "arm-1",
			name: "Arm 1",
			domain: "general",
			harness: "opencode-api",
			status: "idle",
			config: { deferredInitialPrompt: "System identity", preserved: true },
		});
		privateBrain.hasReceivedInitialTasks = async () => true;
		privateBrain.sendPromptToArm = async (_armId, prompt) => {
			prompts.push(prompt);
			return true;
		};
		privateBrain.patchArmViaApi = async (_armId, patch) => {
			if (patch.config) configs.push(patch.config);
			return true;
		};
		privateBrain.logActivity = () => {};

		await privateBrain.assignInitialTasks();

		expect(prompts).toEqual(["System identity\n\n---\n\nCommon instructions"]);
		expect(configs).toEqual([{ preserved: true }]);
	});
});

async function createPlanSyncFixture(planFormatter?: PlanFormatter): Promise<{
  brain: Brain;
	syncPlanTasks: () => Promise<boolean>;
  task: Task;
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), "coleo-plan-sync-"));
  temporaryDirectories.push(projectRoot);
  await mkdir(join(projectRoot, ".project"), { recursive: true });
  await writeFile(
    join(projectRoot, ".project", "plan.md"),
    "# Plan\n\n## Phase 1: Foundation\n\n### Tasks\n- [ ] Restore project tasks\n",
    "utf-8",
  );

  const brain = new Brain({
    coleoDir: join(projectRoot, ".coleo"),
    pollIntervalMs: 1000,
    projectRoot,
    verbose: false,
		planFormatter: planFormatter || (async (content) => ({ content, mode: "structured" })),
  });
  const task: Task = {
    id: "phase-1-restore-project-tasks",
    subject: "Restore project tasks",
    description: "Restore project tasks",
    status: "pending",
    priority: "normal",
    sourceType: "plan",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  return {
    brain,
    syncPlanTasks: () => (
      brain as unknown as { syncPlanTasks: () => Promise<boolean> }
    ).syncPlanTasks(),
    task,
  };
}

function setPlanSyncApi(
  brain: Brain,
  implementations: {
    databaseInstanceId: () => Promise<string>;
		listTasks: (options?: unknown) => Promise<Task[]>;
		createTask: (input: { id?: string; subject: string }) => Promise<Task | null>;
		patchTask?: (taskId: string, patch: Partial<Task>) => Promise<Task | null>;
		sendToHuman?: (message: { subject: string; body: string }) => Promise<void>;
		listArms?: () => Promise<Array<{ id: string; status: string; currentTaskId?: string }>>;
		sendPromptToArm?: (
			armId: string,
			prompt: string,
			options?: { interrupt?: boolean },
		) => Promise<boolean>;
		patchArm?: (
			armId: string,
			patch: { status?: string; planningBlocked?: boolean },
		) => Promise<boolean>;
  },
): void {
  const privateBrain = brain as unknown as {
    getBrainConfigBoolean: () => Promise<boolean>;
    getBrainConfigValue: () => Promise<string>;
    listTasksFromApi: () => Promise<Task[]>;
		createTaskViaApi: (input: { id?: string; subject: string }) => Promise<Task | null>;
		patchTaskViaApi: (taskId: string, patch: Partial<Task>) => Promise<Task | null>;
		sendToHuman: (message: { subject: string; body: string }) => Promise<void>;
		listArmsFromApi: () => Promise<Array<{ id: string; status: string; currentTaskId?: string }>>;
		sendPromptToArm: (
			armId: string,
			prompt: string,
			options?: { interrupt?: boolean },
		) => Promise<boolean>;
		patchArmViaApi: (
			armId: string,
			patch: { status?: string; planningBlocked?: boolean },
		) => Promise<boolean>;
  };
  privateBrain.getBrainConfigBoolean = async () => true;
  privateBrain.getBrainConfigValue = implementations.databaseInstanceId;
  privateBrain.listTasksFromApi = implementations.listTasks;
  privateBrain.createTaskViaApi = implementations.createTask;
	privateBrain.patchTaskViaApi = implementations.patchTask || (async () => null);
	privateBrain.sendToHuman = implementations.sendToHuman || (async () => {});
	privateBrain.listArmsFromApi = implementations.listArms || (async () => []);
	privateBrain.sendPromptToArm = implementations.sendPromptToArm || (async () => true);
	privateBrain.patchArmViaApi = implementations.patchArm || (async () => true);
}
