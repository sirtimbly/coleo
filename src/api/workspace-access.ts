import { getArmClient } from "./arm-client-registry";
import { HttpError } from "./middleware";
import {
	LocalWorkspaceAccess,
	type WorkspaceAccess,
	type WorkspaceOperation,
	type WorkspaceOperationResult,
	type WorkspaceScanOptions,
	type WorkspaceTextFile,
	type WorkspaceWriteOptions,
} from "../workspace";

class ArmHostWorkspaceAccess implements WorkspaceAccess {
	readonly root: string;
	private readonly agentId: string;

	constructor(root: string, agentId: string) {
		this.root = root;
		this.agentId = agentId;
	}

	private async execute(operation: WorkspaceOperation): Promise<WorkspaceOperationResult> {
		const armClient = getArmClient();
		if (!armClient) throw new HttpError(503, "Arm Host connection is not available");
		const response = await armClient.executeWorkspaceOperation(this.agentId, operation);
		if (!response.success || !response.data) {
			throw new HttpError(503, response.error || "Arm Host workspace operation failed");
		}
		return response.data;
	}

	async readText(path: string): Promise<WorkspaceTextFile | null> {
		const result = await this.execute({ type: "read_text", path });
		if (result.type !== "read_text") throw new Error("Unexpected Arm Host workspace response");
		return result.file;
	}

	async writeText(path: string, content: string, options: WorkspaceWriteOptions = {}): Promise<WorkspaceTextFile> {
		const result = await this.execute({
			type: "write_text",
			path,
			content,
			expectedHash: options.expectedHash,
		});
		if (result.type !== "write_text") throw new Error("Unexpected Arm Host workspace response");
		return result.file;
	}

	async scan(patterns: string[], options: WorkspaceScanOptions = {}) {
		const result = await this.execute({ type: "scan", patterns, options });
		if (result.type !== "scan") throw new Error("Unexpected Arm Host workspace response");
		return result.files;
	}

	async gitStatus(): Promise<string> {
		const result = await this.execute({ type: "git_status" });
		if (result.type !== "git_status") throw new Error("Unexpected Arm Host workspace response");
		return result.porcelain;
	}

	async gitFiles(): Promise<string[]> {
		const result = await this.execute({ type: "git_files" });
		if (result.type !== "git_files") throw new Error("Unexpected Arm Host workspace response");
		return result.files;
	}
}

export function getServerWorkspaceAccess(): WorkspaceAccess {
	const projectRoot = process.env.COLEO_PROJECT_DIR
		|| process.env.COLEO_REMOTE_WORKDIR
		|| process.cwd();
	if (process.env.COLEO_REMOTE_ARMS_ONLY !== "1") {
		return new LocalWorkspaceAccess(projectRoot);
	}
	const agentId = process.env.COLEO_WORKSPACE_AGENT_ID
		|| (process.env.COLEO_PROJECT_ID ? `reef-${process.env.COLEO_PROJECT_ID}` : "");
	if (!agentId) throw new HttpError(503, "Arm Host workspace ID is not configured");
	return new ArmHostWorkspaceAccess(projectRoot, agentId);
}
