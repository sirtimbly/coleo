import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { clearInbox, parseInbox } from "../inbox-parser";
import { findPlanFiles, parsePlanFile, removeTaskLineFromPlan } from "../plan-parser";
import {
	executeWorkspaceOperation,
	LocalWorkspaceAccess,
	RemoteWorkspaceAccess,
	type WorkspaceOperation,
} from "../../workspace";

describe("Brain workspace files", () => {
	let localRoot: string;
	const logicalRoot = "/home/coleo/runtime/workspace";
	const originalFetch = globalThis.fetch;

	beforeEach(async () => {
		localRoot = join("/tmp", `coleo-brain-workspace-${crypto.randomUUID()}`);
		await mkdir(join(localRoot, ".project"), { recursive: true });
		await writeFile(
			join(localRoot, ".project", "plan.md"),
			[
				"# Plan",
				"",
				"## Phase 1: Interactive Garden",
				"Let users explore the 3D garden by selecting plants and moving between visualization items.",
				"",
				"### Deliverables",
				"- [ ] Add interactive navigation <!--octopai:task1234-->",
				"",
			].join("\n"),
			"utf-8",
		);
		await writeFile(
			join(localRoot, ".project", "inbox.md"),
			["# Inbox", "-->", "## Remote inbox task", "Details from the Arm Host.", ""].join("\n"),
			"utf-8",
		);
		const local = new LocalWorkspaceAccess(localRoot);
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { operation: WorkspaceOperation };
			return Response.json({ result: await executeWorkspaceOperation(local, body.operation) });
		}) as typeof fetch;
	});

	afterEach(async () => {
		globalThis.fetch = originalFetch;
		await rm(localRoot, { recursive: true, force: true });
	});

	function remoteWorkspace(): RemoteWorkspaceAccess {
		return new RemoteWorkspaceAccess({
			root: logicalRoot,
			apiBaseUrl: "https://workspace.example",
			apiKey: "workspace-key",
		});
	}

	it("parses and mutates plan files through the workspace transport", async () => {
		const workspace = remoteWorkspace();
		const planFiles = await findPlanFiles(logicalRoot, workspace);
		expect(planFiles).toEqual([join(logicalRoot, ".project", "plan.md")]);
		const parsed = await parsePlanFile(planFiles[0]!, workspace);
		expect(parsed.tasks[0]).toMatchObject({
			subject: "Add interactive navigation",
			planLineUid: "task1234",
			phase: "Phase 1: Interactive Garden",
		});
		expect(parsed.tasks[0]?.description).toContain("Plan phase: Phase 1: Interactive Garden.");
		expect(parsed.tasks[0]?.description).toContain("explore the 3D garden");
		expect(parsed.tasks[0]?.description).toContain("Task objective: Add interactive navigation.");
		expect(await removeTaskLineFromPlan(planFiles[0]!, "task1234", workspace)).toBe(true);
		expect((await workspace.readText(".project/plan.md"))?.content).not.toContain("task1234");
	});

	it("processes and clears the inbox through the workspace transport", async () => {
		const workspace = remoteWorkspace();
		const parsed = await parseInbox(logicalRoot, workspace);
		expect(parsed.items[0]).toMatchObject({
			subject: "Remote inbox task",
			description: "Details from the Arm Host.",
		});
		await clearInbox(logicalRoot, workspace);
		expect((await parseInbox(logicalRoot, workspace)).wasEmpty).toBe(true);
	});
});
