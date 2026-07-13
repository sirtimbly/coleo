import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { ArmAgent } from "../arm-agent";
import type { AgentCommand, CommandResponse } from "../../nats";
import type { WorkspaceOperationResult } from "../../workspace";

describe("Arm Host workspace commands", () => {
	const roots: string[] = [];

	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	it("executes workspace reads inside the configured checkout", async () => {
		const root = join("/tmp", `coleo-arm-host-${crypto.randomUUID()}`);
		roots.push(root);
		await mkdir(join(root, "src"), { recursive: true });
		await writeFile(join(root, "src", "index.ts"), "export {};\n", "utf-8");

		const agent = new ArmAgent({
			agentId: "arm-host-test",
			natsUrl: "nats://127.0.0.1:4222",
			coleoDir: join(root, ".coleo"),
			workspaceRoot: root,
		});
		const handleCommand = (agent as unknown as {
			handleCommand(command: AgentCommand): Promise<CommandResponse<WorkspaceOperationResult>>;
		}).handleCommand.bind(agent);

		const response = await handleCommand({
			type: "workspace",
			requestId: "workspace-read",
			operation: { type: "read_text", path: "src/index.ts" },
		});
		expect(response.success).toBe(true);
		expect(response.data).toMatchObject({
			type: "read_text",
			file: { path: "src/index.ts", content: "export {};\n" },
		});

		const escaped = await handleCommand({
			type: "workspace",
			requestId: "workspace-escape",
			operation: { type: "read_text", path: "../outside" },
		});
		expect(escaped.success).toBe(false);
		expect(escaped.error).toContain("escapes");
	});
});
