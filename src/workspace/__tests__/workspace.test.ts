import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "fs/promises";
import { join } from "path";
import {
	executeWorkspaceOperation,
	LocalWorkspaceAccess,
	RemoteWorkspaceAccess,
	type WorkspaceOperation,
} from "..";

describe("workspace access", () => {
	let root: string;
	let outside: string;
	const originalFetch = globalThis.fetch;

	beforeEach(async () => {
		root = join("/tmp", `coleo-workspace-${crypto.randomUUID()}`);
		outside = join("/tmp", `coleo-outside-${crypto.randomUUID()}`);
		await mkdir(join(root, "docs"), { recursive: true });
		await mkdir(outside, { recursive: true });
		await writeFile(join(root, "docs", "guide.md"), "one\ntwo\n", "utf-8");
		await writeFile(join(outside, "secret.txt"), "secret", "utf-8");
	});

	afterEach(async () => {
		globalThis.fetch = originalFetch;
		await Promise.all([
			rm(root, { recursive: true, force: true }),
			rm(outside, { recursive: true, force: true }),
		]);
	});

	it("reads, scans, and conflict-checks writes", async () => {
		const workspace = new LocalWorkspaceAccess(root);
		const original = await workspace.readText("docs/guide.md");
		expect(original?.content).toBe("one\ntwo\n");

		const files = await workspace.scan(["docs/**/*.md"], { includeLineCount: true });
		expect(files).toHaveLength(1);
		expect(files[0]).toMatchObject({ path: "docs/guide.md", lineCount: 3 });

		await workspace.writeText("docs/guide.md", "updated\n", {
			expectedHash: original?.contentHash,
		});
		await expect(workspace.writeText("docs/guide.md", "stale\n", {
			expectedHash: original?.contentHash,
		})).rejects.toThrow("changed before write");
	});

	it("rejects lexical and symlink escapes", async () => {
		const workspace = new LocalWorkspaceAccess(root);
		await expect(workspace.readText("../secret.txt")).rejects.toThrow("escapes");
		await expect(workspace.scan(["docs/../../*.txt"])).rejects.toThrow("escapes");
		await symlink(join(outside, "secret.txt"), join(root, "linked-secret.txt"));
		await expect(workspace.readText("linked-secret.txt")).rejects.toThrow("symlink escapes");
		await expect(workspace.writeText("linked-secret.txt", "overwrite")).rejects.toThrow("symlink escapes");
	});

	it("uses the authenticated API transport for remote workspaces", async () => {
		const local = new LocalWorkspaceAccess(root);
		let requestCount = 0;
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requestCount++;
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			expect(url).toBe("https://workspace.example/api/brain/internal/workspace");
			expect(new Headers(init?.headers).get("X-API-Key")).toBe("workspace-key");
			const body = JSON.parse(String(init?.body)) as { operation: WorkspaceOperation };
			const result = await executeWorkspaceOperation(local, body.operation);
			return Response.json({ result });
		}) as typeof fetch;

		const remote = new RemoteWorkspaceAccess({
			root: "/home/coleo/runtime/workspace",
			apiBaseUrl: "https://workspace.example/",
			apiKey: "workspace-key",
		});
		expect((await remote.readText("docs/guide.md"))?.content).toContain("one");
		expect(await remote.scan(["docs/**/*.md"])).toHaveLength(1);
		expect(requestCount).toBe(2);
	});
});
