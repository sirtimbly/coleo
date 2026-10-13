import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { Hono } from "hono";
import { createBrainRoutes } from "../routes/brain";
import { setArmClient } from "../arm-client-registry";
import type { ArmClient } from "../../nats";

describe("brain workspace bridge", () => {
	let root: string;
	const originalProjectDir = process.env.COLEO_PROJECT_DIR;
	const originalRemoteOnly = process.env.COLEO_REMOTE_ARMS_ONLY;
	const originalAgentId = process.env.COLEO_WORKSPACE_AGENT_ID;

	beforeEach(async () => {
		root = join("/tmp", `coleo-api-workspace-${crypto.randomUUID()}`);
		await mkdir(root, { recursive: true });
		await writeFile(join(root, "README.md"), "local workspace\n", "utf-8");
		process.env.COLEO_PROJECT_DIR = root;
		delete process.env.COLEO_REMOTE_ARMS_ONLY;
		delete process.env.COLEO_WORKSPACE_AGENT_ID;
		setArmClient(null);
	});

	afterEach(async () => {
		if (originalProjectDir === undefined) delete process.env.COLEO_PROJECT_DIR;
		else process.env.COLEO_PROJECT_DIR = originalProjectDir;
		if (originalRemoteOnly === undefined) delete process.env.COLEO_REMOTE_ARMS_ONLY;
		else process.env.COLEO_REMOTE_ARMS_ONLY = originalRemoteOnly;
		if (originalAgentId === undefined) delete process.env.COLEO_WORKSPACE_AGENT_ID;
		else process.env.COLEO_WORKSPACE_AGENT_ID = originalAgentId;
		setArmClient(null);
		await rm(root, { recursive: true, force: true });
	});

	function app(): Hono {
		const app = new Hono();
		app.route("/api/brain", createBrainRoutes());
		return app;
	}

	it("executes local development operations directly", async () => {
		const response = await app().request("/api/brain/internal/workspace", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ operation: { type: "read_text", path: "README.md" } }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			result: { type: "read_text", file: { content: "local workspace\n" } },
		});
	});

	it("forwards hosted operations to the configured Arm Host", async () => {
		process.env.COLEO_REMOTE_ARMS_ONLY = "1";
		process.env.COLEO_WORKSPACE_AGENT_ID = "reef-workspace";
		const calls: unknown[] = [];
		setArmClient({
			getAgent: (id: string) => id === "reef-workspace" ? { agentId: id } : undefined,
			executeWorkspaceOperation: async (id: string, operation: unknown) => {
				calls.push({ id, operation });
				return {
					requestId: "workspace-request",
					success: true,
					data: { type: "git_status", porcelain: " M src/index.ts\n" },
				};
			},
		} as unknown as ArmClient);

		const response = await app().request("/api/brain/internal/workspace", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ operation: { type: "git_status" } }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			result: { type: "git_status", porcelain: " M src/index.ts\n" },
		});
		expect(calls).toEqual([{ id: "reef-workspace", operation: { type: "git_status" } }]);
	});
});
