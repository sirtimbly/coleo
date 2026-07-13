import { LocalWorkspaceAccess } from "./local";
import { isAbsolute, relative } from "path";
import type {
	WorkspaceAccess,
	WorkspaceOperation,
	WorkspaceOperationResult,
	WorkspaceScanOptions,
	WorkspaceTextFile,
	WorkspaceWriteOptions,
} from "./types";

export * from "./types";
export { LocalWorkspaceAccess } from "./local";

interface RemoteWorkspaceAccessOptions {
	root: string;
	apiBaseUrl: string;
	apiKey: string;
}

export class RemoteWorkspaceAccess implements WorkspaceAccess {
	readonly root: string;
	private readonly apiBaseUrl: string;
	private readonly apiKey: string;

	constructor(options: RemoteWorkspaceAccessOptions) {
		this.root = options.root;
		this.apiBaseUrl = options.apiBaseUrl.replace(/\/$/, "");
		this.apiKey = options.apiKey;
	}

	private normalizePath(path: string): string {
		if (!isAbsolute(path)) return path;
		const normalized = relative(this.root, path).replaceAll("\\", "/");
		if (normalized === ".." || normalized.startsWith("../")) {
			throw new Error(`Workspace path escapes the configured root: ${path}`);
		}
		return normalized;
	}

	private async execute(operation: WorkspaceOperation): Promise<WorkspaceOperationResult> {
		const response = await fetch(`${this.apiBaseUrl}/api/brain/internal/workspace`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-API-Key": this.apiKey,
			},
			body: JSON.stringify({ operation }),
		});
		if (!response.ok) {
			const body = await response.json().catch(() => null) as { error?: string } | null;
			throw new Error(body?.error || `Remote workspace request failed (${response.status})`);
		}
		const body = await response.json() as { result: WorkspaceOperationResult };
		return body.result;
	}

	async readText(path: string): Promise<WorkspaceTextFile | null> {
		const result = await this.execute({ type: "read_text", path: this.normalizePath(path) });
		if (result.type !== "read_text") throw new Error("Unexpected remote workspace response");
		return result.file;
	}

	async writeText(
		path: string,
		content: string,
		options: WorkspaceWriteOptions = {},
	): Promise<WorkspaceTextFile> {
		const result = await this.execute({
			type: "write_text",
			path: this.normalizePath(path),
			content,
			expectedHash: options.expectedHash,
		});
		if (result.type !== "write_text") throw new Error("Unexpected remote workspace response");
		return result.file;
	}

	async scan(patterns: string[], options: WorkspaceScanOptions = {}) {
		const result = await this.execute({ type: "scan", patterns, options });
		if (result.type !== "scan") throw new Error("Unexpected remote workspace response");
		return result.files;
	}

	async gitStatus(): Promise<string> {
		const result = await this.execute({ type: "git_status" });
		if (result.type !== "git_status") throw new Error("Unexpected remote workspace response");
		return result.porcelain;
	}
}

export async function executeWorkspaceOperation(
	workspace: WorkspaceAccess,
	operation: WorkspaceOperation,
): Promise<WorkspaceOperationResult> {
	switch (operation.type) {
		case "read_text":
			return { type: "read_text", file: await workspace.readText(operation.path) };
		case "write_text":
			return {
				type: "write_text",
				file: await workspace.writeText(operation.path, operation.content, {
					expectedHash: operation.expectedHash,
				}),
			};
		case "scan":
			return { type: "scan", files: await workspace.scan(operation.patterns, operation.options) };
		case "git_status":
			return { type: "git_status", porcelain: await workspace.gitStatus() };
	}
}

export function createWorkspaceAccess(options: {
	projectRoot: string;
	apiBaseUrl?: string;
	apiKey?: string;
	remote?: boolean;
}): WorkspaceAccess {
	if (options.remote) {
		if (!options.apiBaseUrl || !options.apiKey) {
			throw new Error("Remote workspace access requires the Coleo API URL and API key");
		}
		return new RemoteWorkspaceAccess({
			root: options.projectRoot,
			apiBaseUrl: options.apiBaseUrl,
			apiKey: options.apiKey,
		});
	}
	return new LocalWorkspaceAccess(options.projectRoot);
}
