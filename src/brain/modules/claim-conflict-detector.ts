/**
 * ClaimConflictDetector - Detects and handles file claim conflicts between tasks
 * 
 * Extracted from brain.ts to reduce file size and improve maintainability.
 * Handles: file claim conflict detection, notification, and resolution attempts.
 */

import type { Task } from "../../types";

export interface ClaimConflict {
	armId: string;
	filePath: string;
	claimType: string;
	claimedAt: string;
}

export interface ConflictCheckResult {
	hasConflict: boolean;
	conflicts: ClaimConflict[];
}

export interface ClaimConflictDetectorOptions {
	resolveClaimsActive: boolean;
}

export interface ClaimConflictDetectorCallbacks {
	log: (message: string) => void;
	getActiveFileClaims: () => Promise<ClaimConflict[]>;
	patchTaskStatus: (taskId: string, status: string) => Promise<void>;
	notifyHumanOfConflict: (task: Task, conflicts: ClaimConflict[]) => Promise<void>;
	attemptConflictResolution: (task: Task, conflicts: ClaimConflict[]) => Promise<void>;
}

export class ClaimConflictDetector {
	private options: ClaimConflictDetectorOptions;
	private callbacks: ClaimConflictDetectorCallbacks;

	constructor(
		options: ClaimConflictDetectorOptions,
		callbacks: ClaimConflictDetectorCallbacks,
	) {
		this.options = options;
		this.callbacks = callbacks;
	}

	/**
	 * Check tasks for file claim conflicts and block them if found.
	 * This prevents multiple arms from working on files claimed by others.
	 */
	async checkAndBlockTasks(tasks: Task[]): Promise<void> {
		try {
			// Get all active file claims from the database
			const activeClaims = await this.callbacks.getActiveFileClaims();
			if (activeClaims.length === 0) {
				return; // No active claims, nothing to check
			}

			for (const task of tasks) {
				// Extract file paths from task (from artifacts, description, or context)
				const taskFiles = this.extractFilePathsFromTask(task);
				if (taskFiles.length === 0) {
					continue; // No files associated with this task
				}

				// Check for conflicts with active claims
				const conflicts = this.findConflicts(taskFiles, activeClaims);
				if (conflicts.length > 0) {
					this.callbacks.log(
						`Task ${task.id} blocked due to ${conflicts.length} file claim conflict(s)`,
					);

					// Mark task as blocked
					await this.callbacks.patchTaskStatus(task.id, "blocked");

					// Notify human about the conflict
					await this.callbacks.notifyHumanOfConflict(task, conflicts);

					// If active resolution is enabled, attempt to resolve
					if (this.options.resolveClaimsActive) {
						await this.callbacks.attemptConflictResolution(task, conflicts);
					}
				}
			}
		} catch (err) {
			this.callbacks.log(`Error checking file claim conflicts: ${err}`);
		}
	}

	/**
	 * Check a single task for claim conflicts without blocking it
	 */
	async checkTaskForConflicts(task: Task): Promise<ConflictCheckResult> {
		try {
			const activeClaims = await this.callbacks.getActiveFileClaims();
			if (activeClaims.length === 0) {
				return { hasConflict: false, conflicts: [] };
			}

			const taskFiles = this.extractFilePathsFromTask(task);
			if (taskFiles.length === 0) {
				return { hasConflict: false, conflicts: [] };
			}

			const conflicts = this.findConflicts(taskFiles, activeClaims);
			return {
				hasConflict: conflicts.length > 0,
				conflicts,
			};
		} catch (err) {
			this.callbacks.log(`Error checking task for conflicts: ${err}`);
			return { hasConflict: false, conflicts: [] };
		}
	}

	/**
	 * Extract file paths associated with a task
	 */
	extractFilePathsFromTask(task: Task): string[] {
		const files: string[] = [];

		// Add files from artifacts
		if (task.artifacts) {
			for (const artifact of task.artifacts) {
				// Check if artifact looks like a file path
				if (artifact.includes("/") || artifact.includes(".")) {
					files.push(artifact);
				}
			}
		}

		// Add files from discoveries in context
		if (task.context?.discoveries) {
			for (const discovery of task.context.discoveries) {
				if (discovery.filePath) {
					files.push(discovery.filePath);
				}
			}
		}

		// Parse description for file paths (simple heuristic)
		const filePathRegex =
			/(?:src\/|\.\/|\/)?[\w\/\-]+\.(?:ts|tsx|js|jsx|json|md)/g;
		const descriptionFiles = task.description.match(filePathRegex) || [];
		files.push(...descriptionFiles);

		// Remove duplicates
		return [...new Set(files)];
	}

	/**
	 * Find conflicts between task files and active claims
	 */
	findConflicts(
		taskFiles: string[],
		activeClaims: ClaimConflict[],
	): ClaimConflict[] {
		const conflicts: ClaimConflict[] = [];

		for (const taskFile of taskFiles) {
			// Normalize the task file path
			const normalizedTaskFile = taskFile.replace(/^\.\//, "").replace(/^\//, "");

			for (const claim of activeClaims) {
				// Check for exact match or if task file is within claimed directory
				const normalizedClaimFile = claim.filePath
					.replace(/^\.\//, "")
					.replace(/^\//, "");

				if (
					normalizedTaskFile === normalizedClaimFile ||
					normalizedTaskFile.startsWith(normalizedClaimFile + "/") ||
					normalizedClaimFile.startsWith(normalizedTaskFile + "/")
				) {
					conflicts.push(claim);
				}
			}
		}

		return conflicts;
	}

	/**
	 * Generate a human-readable conflict report
	 */
	generateConflictReport(
		task: Task,
		conflicts: ClaimConflict[],
	): { subject: string; body: string } {
		const conflictList = conflicts
			.map(
				(c) =>
					`- \`${c.filePath}\` claimed by ${c.armId} (${c.claimType}) since ${c.claimedAt}`,
			)
			.join("\n");

		const body = `## Task Blocked: File Claim Conflict

**Task:** ${task.subject} (${task.id})

This task cannot proceed because the following files are already claimed by other arms:

${conflictList}

### Next Steps

1. **Wait for claims to be released** - The blocking arms will release their claims when done
2. **Coordinate with blocking arms** - Contact them to negotiate file access
3. **Enable auto-resolution** - Set \`brain.resolve_claims_active=true\` to allow automatic conflict resolution

---
*This is a conservative conflict prevention mechanism. Tasks remain blocked until conflicts are resolved.*`;

		return {
			subject: `[coleo] Task Blocked: File Claim Conflict - ${task.subject}`,
			body,
		};
	}

	/**
	 * Update options at runtime
	 */
	updateOptions(options: Partial<ClaimConflictDetectorOptions>): void {
		this.options = { ...this.options, ...options };
	}

	/**
	 * Get current options
	 */
	getOptions(): ClaimConflictDetectorOptions {
		return { ...this.options };
	}
}
