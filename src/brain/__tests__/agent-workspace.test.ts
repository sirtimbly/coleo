import { describe, expect, it } from "bun:test";
import { BrainAgent } from "../agent";
import type {
	WorkspaceAccess,
	WorkspaceFileMetadata,
	WorkspaceScanOptions,
	WorkspaceTextFile,
	WorkspaceWriteOptions,
} from "../../workspace";
import type { BrainDb } from "../db-client";

class MemoryWorkspace implements WorkspaceAccess {
	readonly root = "/remote/workspace";
	readonly reads: string[] = [];

	async readText(path: string): Promise<WorkspaceTextFile | null> {
		this.reads.push(path);
		if (path !== ".project/plan.md") return null;
		const content = "## Goal\n- Keep remote tools working\n";
		return {
			path,
			content,
			contentHash: "hash",
			size: content.length,
			modifiedAt: new Date(0).toISOString(),
		};
	}

	async writeText(_path: string, _content: string, _options?: WorkspaceWriteOptions): Promise<WorkspaceTextFile> {
		throw new Error("not implemented");
	}

	async scan(_patterns: string[], _options?: WorkspaceScanOptions): Promise<WorkspaceFileMetadata[]> {
		return [];
	}

	async gitStatus(): Promise<string> {
		return "";
	}
}

describe("BrainAgent workspace tools", () => {
	it("reads plans through the injected workspace boundary", async () => {
		const workspace = new MemoryWorkspace();
		const agent = new BrainAgent({
			db: {} as BrainDb,
			projectRoot: workspace.root,
			coleoDir: "/remote/control-state",
			workspace,
		});

		const result = await agent.executeAction("readPlan", {});

		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({
			id: "plan",
			goals: ["Keep remote tools working"],
		});
		expect(workspace.reads).toEqual([".project/plan.md"]);
	});
});
