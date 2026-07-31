import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { Brain } from "../brain";
import type { Task } from "../../types";
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
		setPlanSyncApi(brain, {
			databaseInstanceId: async () => "database-one",
			listTasks: async () => [task],
			createTask: async () => task,
			patchTask: async (_taskId, patch) => {
				events.push(`block:${patch.blockedCategory}`);
				return { ...task, status: patch.status || task.status };
			},
			sendToHuman: async () => {
				events.push("mail");
			},
		});

		expect(await syncPlanTasks()).toBe(false);
		expect(events).toEqual(["mail", "block:planning"]);
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
		sendToHuman?: () => Promise<void>;
  },
): void {
  const privateBrain = brain as unknown as {
    getBrainConfigBoolean: () => Promise<boolean>;
    getBrainConfigValue: () => Promise<string>;
    listTasksFromApi: () => Promise<Task[]>;
		createTaskViaApi: (input: { id?: string; subject: string }) => Promise<Task | null>;
		patchTaskViaApi: (taskId: string, patch: Partial<Task>) => Promise<Task | null>;
		sendToHuman: () => Promise<void>;
  };
  privateBrain.getBrainConfigBoolean = async () => true;
  privateBrain.getBrainConfigValue = implementations.databaseInstanceId;
  privateBrain.listTasksFromApi = implementations.listTasks;
  privateBrain.createTaskViaApi = implementations.createTask;
	privateBrain.patchTaskViaApi = implementations.patchTask || (async () => null);
	privateBrain.sendToHuman = implementations.sendToHuman || (async () => {});
}
