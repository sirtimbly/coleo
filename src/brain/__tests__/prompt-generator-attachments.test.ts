import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { generateContextBundle } from "../prompt-generator";
import type {
  BrainArmListFilters,
  BrainBugListFilters,
  BrainDb,
  BrainDiscoveryListFilters,
  BrainStatusReportListFilters,
  BrainTaskCreateInput,
  BrainTaskDependencyRecord,
  BrainTaskDependencyUpsertInput,
  BrainTaskListFilters,
  BrainTaskPatchInput,
  BrainTaskRecord,
} from "../db-client";

class MockBrainDb implements BrainDb {
  constructor(private readonly tasks: BrainTaskRecord[]) {}

  listTasks(filters?: BrainTaskListFilters): BrainTaskRecord[] {
    let rows = [...this.tasks];

    if (filters?.statuses?.length) {
      const statuses = new Set(filters.statuses);
      rows = rows.filter((task) => statuses.has(task.status));
    }

    if (filters?.excludeStatuses?.length) {
      const excluded = new Set(filters.excludeStatuses);
      rows = rows.filter((task) => !excluded.has(task.status));
    }

    if (filters?.limit !== undefined) {
      rows = rows.slice(0, filters.limit);
    }

    return rows;
  }

  getTask(taskId: string): BrainTaskRecord | null {
    return this.tasks.find((task) => task.id === taskId) ?? null;
  }

  createTask(input: BrainTaskCreateInput): BrainTaskRecord {
    throw new Error(`Not implemented for test: ${input.subject}`);
  }

  updateTask(_taskId: string, _patch: BrainTaskPatchInput): BrainTaskRecord {
    throw new Error("Not implemented for test");
  }

  listBugs(_filters?: BrainBugListFilters) {
    return [];
  }

  getBug(_bugId: string) {
    return null;
  }

  listDiscoveries(_filters?: BrainDiscoveryListFilters) {
    return [];
  }

  listStatusReports(_filters?: BrainStatusReportListFilters) {
    return [];
  }

  listTaskDependencies(_taskId: string): BrainTaskDependencyRecord[] {
    return [];
  }

  upsertTaskDependency(_input: BrainTaskDependencyUpsertInput): void {}

  listArms(_filters?: BrainArmListFilters) {
    return [];
  }
}

describe("prompt generator attachments", () => {
  const createdDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("includes task image attachments in the generated context bundle", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "coleo-prompt-bundle-"));
    createdDirs.push(projectRoot);

    const db = new MockBrainDb([
      {
        id: "task-attach-1",
        subject: "Investigate screenshot issue",
        description: "Review the attached UI screenshot and diagnose the problem.",
        status: "pending",
        priority: "high",
        sourceType: "email",
        sourceRef: null,
        phase: null,
        domain: "frontend",
        classification: "development",
        assignedTo: null,
        dependencyBlocked: false,
        consensusStatus: null,
        sortOrder: null,
        createdAt: "2026-02-01T00:00:00.000Z",
        updatedAt: "2026-02-01T00:00:00.000Z",
        completedAt: null,
        context: {
          attachments: [
            {
              uploadId: "upload-42",
              kind: "image",
              filename: "broken-modal.png",
              mimeType: "image/png",
              sizeBytes: 4096,
              contentUrl: "https://assets.example.test/uploads/upload-42/content?token=abc",
            },
          ],
        },
      },
    ]);

    const result = await generateContextBundle(
      {
        projectRoot,
        coleoDir: projectRoot,
        db,
      },
      "Investigate screenshot issue",
    );

    expect(result).not.toBeNull();
    expect(result?.context.attachments).toContain("## ATTACHED IMAGES");
    expect(result?.fullOutput).toContain("broken-modal.png");
    expect(result?.fullOutput).toContain(
      "![broken-modal.png](https://assets.example.test/uploads/upload-42/content?token=abc)",
    );
  });
});
