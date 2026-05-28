import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { MaintenanceTaskConfig } from "../types";

export interface MaintenanceTriggerContext {
	now: Date;
	completedTaskCount: number;
	currentBranch?: string | null;
	currentCommit?: string | null;
}

export interface MaintenanceTriggerDecision {
	shouldRun: boolean;
	reasons: string[];
	mainCommit?: string;
}

export function getGitCommitState(projectRoot: string): {
	branch: string | null;
	commit: string | null;
} {
	try {
		const branch = execFileSync("git", ["branch", "--show-current"], {
			cwd: projectRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		const commit = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: projectRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return {
			branch: branch || null,
			commit: commit || null,
		};
	} catch {
		return { branch: null, commit: null };
	}
}

export function shouldRunMaintenanceTask(
	task: MaintenanceTaskConfig,
	context: MaintenanceTriggerContext,
): MaintenanceTriggerDecision {
	if (!task.enabled) {
		return { shouldRun: false, reasons: [] };
	}

	const reasons: string[] = [];
	const triggers = task.triggers;

	if (triggers.everyHours && triggers.everyHours > 0) {
		if (!task.lastRunAt) {
			reasons.push(`no previous run recorded for ${triggers.everyHours}h interval`);
		} else {
			const lastRunMs = new Date(task.lastRunAt).getTime();
			const hoursSinceRun =
				(context.now.getTime() - lastRunMs) / (1000 * 60 * 60);
			if (
				Number.isFinite(hoursSinceRun) &&
				hoursSinceRun >= triggers.everyHours
			) {
				reasons.push(`${hoursSinceRun.toFixed(1)}h since last run`);
			}
		}
	}

	if (triggers.everyCompletedTasks && triggers.everyCompletedTasks > 0) {
		const lastCount = task.lastCompletedTaskCount ?? 0;
		const completedSinceRun = context.completedTaskCount - lastCount;
		if (completedSinceRun >= triggers.everyCompletedTasks) {
			reasons.push(`${completedSinceRun} completed tasks since last run`);
		}
	}

	if (triggers.onMainCommit) {
		const allowedBranches =
			triggers.branches && triggers.branches.length > 0
				? triggers.branches
				: ["main", "master"];
		const branch = context.currentBranch || "";
		const commit = context.currentCommit || "";
		if (
			branch &&
			commit &&
			allowedBranches.includes(branch) &&
			commit !== task.lastMainCommit
		) {
			reasons.push(`new ${branch} commit ${commit.slice(0, 12)}`);
		}
	}

	return {
		shouldRun: reasons.length > 0,
		reasons,
		mainCommit: context.currentCommit || undefined,
	};
}

export async function buildMaintenanceTaskDescription(
	task: MaintenanceTaskConfig,
	options: {
		coleoDir: string;
		triggerReasons: string[];
		completedTaskCount: number;
		currentBranch?: string | null;
		currentCommit?: string | null;
	},
): Promise<string> {
	const instructions = await loadMaintenanceInstructions(task, options.coleoDir);
	const slices =
		task.slices.length > 0
			? task.slices.map((slice) => `- ${slice}`).join("\n")
			: "- project metadata";
	const reasons = options.triggerReasons
		.map((reason) => `- ${reason}`)
		.join("\n");

	return `## Maintenance Task

${task.description || "Review project metadata and create the necessary cleanup or alignment follow-up work."}

### Trigger
${reasons || "- manual or startup maintenance check"}

### Metadata Slices
${slices}

### Required Handling Rules
- Review only the configured slices unless the instructions below explicitly say otherwise.
- For every actionable discovery, create or link the task/bug that addresses it and add a discovery handling comment with the linked task or bug ID.
- If a discovery needs no action, mark it dismissed/resolved with a handling comment explaining why it is handled.
- For plan and documentation items, remove stale references or create follow-up tasks when work is still needed.
- Keep the task output concise: list items handled, follow-up IDs created or linked, and anything left open.

### Instructions
${instructions}

### Run Context
- Completed task count: ${options.completedTaskCount}
- Branch: ${options.currentBranch || "unknown"}
- Commit: ${options.currentCommit || "unknown"}
`;
}

async function loadMaintenanceInstructions(
	task: MaintenanceTaskConfig,
	coleoDir: string,
): Promise<string> {
	const inlineInstructions = task.instructions?.trim();
	const filePath = task.instructionsFile?.trim();

	if (!filePath) {
		return (
			inlineInstructions ||
			"Use judgment to clean up stale metadata and create follow-up tasks for anything actionable."
		);
	}

	const resolvedPath = isAbsolute(filePath) ? filePath : join(coleoDir, filePath);
	try {
		const fileInstructions = (await readFile(resolvedPath, "utf8")).trim();
		if (inlineInstructions) {
			return `${inlineInstructions}\n\n${fileInstructions}`;
		}
		return fileInstructions;
	} catch (err) {
		const fallback = `Instruction file ${filePath} could not be read: ${err}`;
		return inlineInstructions
			? `${inlineInstructions}\n\n${fallback}`
			: fallback;
	}
}
