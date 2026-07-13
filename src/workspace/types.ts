export interface WorkspaceTextFile {
	path: string;
	content: string;
	contentHash: string;
	size: number;
	modifiedAt: string;
}

export interface WorkspaceFileMetadata {
	path: string;
	contentHash: string;
	size: number;
	modifiedAt: string;
	lineCount?: number;
}

export interface WorkspaceScanOptions {
	ignore?: string[];
	includeLineCount?: boolean;
	maxFiles?: number;
}

export interface WorkspaceWriteOptions {
	expectedHash?: string | null;
}

export interface WorkspaceAccess {
	readonly root: string;
	readText(path: string): Promise<WorkspaceTextFile | null>;
	writeText(path: string, content: string, options?: WorkspaceWriteOptions): Promise<WorkspaceTextFile>;
	scan(patterns: string[], options?: WorkspaceScanOptions): Promise<WorkspaceFileMetadata[]>;
	gitStatus(): Promise<string>;
}

export type WorkspaceOperation =
	| { type: "read_text"; path: string }
	| { type: "write_text"; path: string; content: string; expectedHash?: string | null }
	| { type: "scan"; patterns: string[]; options?: WorkspaceScanOptions }
	| { type: "git_status" };

export type WorkspaceOperationResult =
	| { type: "read_text"; file: WorkspaceTextFile | null }
	| { type: "write_text"; file: WorkspaceTextFile }
	| { type: "scan"; files: WorkspaceFileMetadata[] }
	| { type: "git_status"; porcelain: string };

export function parseWorkspaceOperation(value: unknown): WorkspaceOperation {
	if (!value || typeof value !== "object") {
		throw new Error("Workspace operation must be an object");
	}
	const input = value as Record<string, unknown>;
	if (input.type === "read_text") {
		if (typeof input.path !== "string") throw new Error("Workspace read path must be a string");
		return { type: "read_text", path: input.path };
	}
	if (input.type === "write_text") {
		if (typeof input.path !== "string") throw new Error("Workspace write path must be a string");
		if (typeof input.content !== "string") throw new Error("Workspace write content must be a string");
		if (input.expectedHash !== undefined && input.expectedHash !== null && typeof input.expectedHash !== "string") {
			throw new Error("Workspace expected hash must be a string or null");
		}
		return {
			type: "write_text",
			path: input.path,
			content: input.content,
			expectedHash: input.expectedHash as string | null | undefined,
		};
	}
	if (input.type === "scan") {
		if (!Array.isArray(input.patterns) || !input.patterns.every((pattern) => typeof pattern === "string")) {
			throw new Error("Workspace scan patterns must be an array of strings");
		}
		const rawOptions = input.options;
		if (rawOptions !== undefined && (!rawOptions || typeof rawOptions !== "object")) {
			throw new Error("Workspace scan options must be an object");
		}
		const options = (rawOptions || {}) as Record<string, unknown>;
		if (options.ignore !== undefined && (!Array.isArray(options.ignore) || !options.ignore.every((item) => typeof item === "string"))) {
			throw new Error("Workspace scan ignore patterns must be an array of strings");
		}
		if (options.includeLineCount !== undefined && typeof options.includeLineCount !== "boolean") {
			throw new Error("Workspace scan includeLineCount must be a boolean");
		}
		if (options.maxFiles !== undefined && (typeof options.maxFiles !== "number" || !Number.isInteger(options.maxFiles))) {
			throw new Error("Workspace scan maxFiles must be an integer");
		}
		return {
			type: "scan",
			patterns: input.patterns as string[],
			options: {
				ignore: options.ignore as string[] | undefined,
				includeLineCount: options.includeLineCount as boolean | undefined,
				maxFiles: options.maxFiles as number | undefined,
			},
		};
	}
	if (input.type === "git_status") return { type: "git_status" };
	throw new Error(`Unsupported workspace operation: ${String(input.type)}`);
}
