/**
 * Prompt Generator for CLI Testing
 *
 * Generates plain-text outputs for brain task determination and context bundles.
 * These can be copied and pasted into interactive agent text areas.
 */

import type { BrainDb, BrainTaskRecord } from "./db-client";
import { join } from "path";
import type { Discovery, Task } from "../types";
import { LocalWorkspaceAccess, type WorkspaceAccess } from "../workspace";
import { loadConfig } from "../config";
import {
	DiscoverySummarizer,
	formatDiscoverySummary,
	type DiscoverySummary,
} from "./discovery-summarizer";
import { resolveBrainModelConfig } from "./model-config";

import { formatTaskAttachmentList } from "../lib/prompt-attachments";
import {
	isValidationTaskSubject,
	isVerificationTaskSubject,
} from "./task-subjects";

export interface PromptContext {
	projectRoot: string;
	coleoDir: string;
	db: BrainDb;
	workspace?: WorkspaceAccess;
}

export interface TaskDeterminationResult {
	task: {
		id?: string;
		subject: string;
		description: string;
		classification: string;
		priority: string;
		domain?: string;
	} | null;
	reasoning: string;
	planExcerpt: string;
	completedTasks: string[];
	openDiscoveries: string[];
}

export interface TaskDeterminationOptions {
	excludeTaskIds?: string[];
	excludeVerificationForTaskIds?: string[];
}

export interface ContextBundleResult {
	task: {
		subject: string;
		description: string;
		classification: string;
		priority: string;
	};
	context: {
		discoveries: string;
		planExcerpt: string;
		taskHistory: string;
		instructions: string;
		attachments: string;
	};
	fullOutput: string;
}

/**
 * Generate task determination output showing what the brain would decide
 * IMPORTANT: Task determination should only use the tasks API (database), not read plan files.
 * Plan file reading happens in the plan sync process to populate the database, not here.
 */
export async function generateTaskDetermination(
	ctx: PromptContext,
	options: TaskDeterminationOptions = {},
): Promise<TaskDeterminationResult> {
	const { db } = ctx;
	const snapshot = await buildStatusSnapshot(db);
	const determinationOptions = normalizeTaskDeterminationOptions(options);

	// Determine phase from tasks in database, not from reading plan files
	const phaseInfo = buildPhaseInfoFromDatabase(db);

	const finalize = (
		step: DeterminationStepResult,
	): TaskDeterminationResult => ({
		task: step.task,
		reasoning: step.reasoning,
		planExcerpt: "", // No plan excerpt - task determination relies on task context only
		completedTasks: snapshot.completed,
		openDiscoveries: snapshot.discoveries,
	});

	// Step 1: Look for existing active/claimed tasks
	const activeTask = pickExistingActiveTask(
		db,
		phaseInfo.label,
		determinationOptions,
	);
	if (activeTask) {
		return finalize(activeTask);
	}

	// Step 2: Check for tasks that can be unblocked
	const unblockedTask = tryUnblockDependencies(
		db,
		phaseInfo.label,
		determinationOptions,
	);
	if (unblockedTask) {
		return finalize(unblockedTask);
	}

	// Step 3: Return next pending task from database
	// Don't create tasks from plan here - that's the sync process's job
	const pendingTask = getNextPendingTask(
		db,
		phaseInfo.label,
		determinationOptions,
	);
	const pendingBug = getNextPendingBug(db);
	if (pendingTask || pendingBug) {
		const shouldPickBug =
			!!pendingBug &&
			(!pendingTask || Math.random() < 0.5);
		if (shouldPickBug && pendingBug) {
			return finalize({
				task: {
					id: pendingBug.id,
					subject: pendingBug.title,
					description: pendingBug.description,
					classification: "bug_fix",
					priority: mapBugPriority(pendingBug.priority),
					domain: "bug_fix",
				},
				reasoning: `Returning next pending bug from database: ${pendingBug.title}${pendingTask ? " (task queue also available)" : ""}`,
			});
		}
		if (pendingTask) {
			return finalize({
				...pendingTask,
				reasoning: `${pendingTask.reasoning}${pendingBug ? " (bug queue also available)" : ""}`,
			});
		}
	}

	// Fallback: if dominant phase has no assignable work, broaden search to all phases.
	// This avoids returning "Determine Next Work" while real pending tasks exist elsewhere.
	if (phaseInfo.label) {
		const crossPhaseActiveTask = pickExistingActiveTask(
			db,
			"",
			determinationOptions,
		);
		if (crossPhaseActiveTask) {
			return finalize({
				...crossPhaseActiveTask,
				reasoning: `${crossPhaseActiveTask.reasoning} (outside dominant phase ${phaseInfo.label})`,
			});
		}

		const crossPhaseUnblockedTask = tryUnblockDependencies(
			db,
			"",
			determinationOptions,
		);
		if (crossPhaseUnblockedTask) {
			return finalize({
				...crossPhaseUnblockedTask,
				reasoning: `${crossPhaseUnblockedTask.reasoning} (outside dominant phase ${phaseInfo.label})`,
			});
		}

		const crossPhasePendingTask = getNextPendingTask(
			db,
			"",
			determinationOptions,
		);
		if (crossPhasePendingTask) {
			return finalize({
				...crossPhasePendingTask,
				reasoning: `${crossPhasePendingTask.reasoning}${pendingBug ? " (bug queue also available)" : ""} (outside dominant phase ${phaseInfo.label})`,
			});
		}
	}

	// No tasks available
	return finalize(buildNoTaskResult(phaseInfo));
}

interface DeterminationStepResult {
	task: TaskDeterminationResult["task"];
	reasoning: string;
}

interface NormalizedTaskDeterminationOptions {
	excludedTaskIds: Set<string>;
	excludeVerificationForTaskIds: Set<string>;
}

interface PhaseInfo {
	label: string;
	header: string;
}

/**
 * Build phase info from tasks in the database (not from reading plan files).
 * Returns the most common phase value from pending/in-progress tasks.
 */
function buildPhaseInfoFromDatabase(db: BrainDb): PhaseInfo {
	const phaseCounts = new Map<string, number>();
	const rows = db.listTasks({ limit: 500 });

	for (const row of rows) {
		const phase = (row.phase || "").trim();
		if (!phase) {
			continue;
		}
		phaseCounts.set(phase, (phaseCounts.get(phase) || 0) + 1);
	}

	const dominant = Array.from(phaseCounts.entries()).sort((a, b) => b[1] - a[1])[0];
	if (dominant?.[0]) {
		const phase = dominant[0];
		return { label: phase, header: phase };
	}

	// Default fallback when no phase info in database
	return { label: "", header: "" };
}

interface StatusSnapshot {
	completed: string[];
	discoveries: string[];
}

function pickExistingActiveTask(
	db: BrainDb,
	phaseLabel: string,
	options: NormalizedTaskDeterminationOptions,
): DeterminationStepResult | null {
	const phaseValue = phaseLabel || "";
	const activeTasks = db
		.listTasks({
			statuses: ["claimed", "in_progress"],
			phase: phaseValue || undefined,
			sort: "updated_desc",
			limit: 200,
		})
		.filter((task) => !task.consensusStatus || task.consensusStatus !== "reached")
		.filter((task) => !shouldExcludeTask(task, options))
		.sort((a, b) => {
			const rank = (status: string): number => {
				switch (status) {
					case "in_progress":
						return 1;
					case "completing":
						return 2;
					case "claimed":
						return 3;
					case "verification_pending":
						return 4;
					default:
						return 5;
				}
			};
			const diff = rank(a.status) - rank(b.status);
			if (diff !== 0) {
				return diff;
			}
			return a.createdAt.localeCompare(b.createdAt);
		});

	if (activeTasks.length === 0) {
		return null;
	}

	const task = activeTasks[0]!;
	const assignedArms = [] as string[];

	return {
		task: {
			id: task.id,
			subject: task.subject,
			description: task.description,
			classification: task.domain || "development",
			priority: task.priority,
			domain: task.domain || undefined,
		},
		reasoning: `Active ${task.status} task with ${assignedArms.length} arm(s) assigned${task.consensusStatus ? `, consensus: ${task.consensusStatus}` : ""}`,
	};
}

function tryUnblockDependencies(
	db: BrainDb,
	phaseLabel: string,
	options: NormalizedTaskDeterminationOptions,
): DeterminationStepResult | null {
	const phaseValue = phaseLabel || "";
	const blockedTasks = db.listTasks({
		statuses: ["pending"],
		dependencyBlocked: true,
		phase: phaseValue || undefined,
		sort: "created_asc",
		limit: 200,
	});

	for (const blockedTask of blockedTasks) {
		if (shouldExcludeTask(blockedTask, options)) {
			continue;
		}
		const dependencies = db.listTaskDependencies(blockedTask.id);

		const unmetDeps: string[] = [];
		for (const dep of dependencies) {
			const depTask = db.getTask(dep.dependsOnTaskId);

			if (
				!depTask ||
				(depTask.status !== "completed" && depTask.consensusStatus !== "reached")
			) {
				unmetDeps.push(dep.dependsOnTaskId);
			}
		}

		if (unmetDeps.length === 0) {
			db.updateTask(blockedTask.id, { dependencyBlocked: false });

			return {
				task: {
					id: blockedTask.id,
					subject: blockedTask.subject,
					description: blockedTask.description,
					classification: blockedTask.domain || "development",
					priority: blockedTask.priority,
					domain: blockedTask.domain || undefined,
				},
				reasoning: `Dependencies resolved. Unblocked: ${blockedTask.priority} - ${blockedTask.subject}`,
			};
		}
	}

	return null;
}

/**
 * Get the next pending task from the database
 * This replaces createPlanTaskDeliverable - task creation is done by the sync process
 */
function getNextPendingTask(
	db: BrainDb,
	phaseLabel: string,
	options: NormalizedTaskDeterminationOptions,
): DeterminationStepResult | null {
	const phaseValue = phaseLabel || "";
	const task = db
		.listTasks({
			statuses: ["pending"],
			dependencyBlocked: false,
			phase: phaseValue || undefined,
			sort: "order_key_asc",
			limit: 200,
		})
		.find((candidate) => !shouldExcludeTask(candidate, options));

	if (!task) {
		return null;
	}

	return {
		task: {
			id: task.id,
			subject: task.subject,
			description: task.description,
			classification: task.domain || "development",
			priority: task.priority,
			domain: task.domain || undefined,
		},
		reasoning: `Returning next pending task from database: ${task.subject}`,
	};
}

function getNextPendingBug(db: BrainDb): {
	id: string;
	title: string;
	description: string;
	priority: string;
	errorDetails?: string;
} | null {
	const bug = db
		.listBugs({
			statuses: ["open", "investigating"],
			unassignedOnly: true,
			limit: 50,
		})
		.sort((a, b) => {
			const rank = (priority: string): number => {
				switch (priority) {
					case "critical":
						return 1;
					case "high":
						return 2;
					case "medium":
						return 3;
					default:
						return 4;
				}
			};
			const diff = rank(a.priority) - rank(b.priority);
			if (diff !== 0) {
				return diff;
			}
			return a.createdAt.localeCompare(b.createdAt);
		})[0];

	if (!bug) {
		return null;
	}

	return {
		id: bug.id,
		title: bug.title,
		description: bug.description,
		priority: bug.priority,
		errorDetails: bug.errorDetails || undefined,
	};
}

function mapBugPriority(priority: string): Task["priority"] {
	switch (priority) {
		case "critical":
		case "high":
		case "low":
			return priority;
		case "medium":
		default:
			return "normal";
	}
}


function buildNoTaskResult(phaseInfo: PhaseInfo): DeterminationStepResult {
	const label = phaseInfo.label || "current phase";
	return {
		task: {
			subject: "Determine Next Work",
			description: `The current phase (${label}) has no remaining deliverables marked as incomplete.

Review the plan and decide what to work on next:
1. Add new items to the current phase in plan.md
2. Move to a new phase
3. Request specific work via email`,
			classification: "architect",
			priority: "normal",
		},
		reasoning: `No deliverables found in ${label}. Plan may be complete or needs updating.`,
	};
}

function normalizeTaskDeterminationOptions(
	options: TaskDeterminationOptions,
): NormalizedTaskDeterminationOptions {
	const excludedTaskIds = new Set(
		(options.excludeTaskIds || [])
			.map((id) => id.trim())
			.filter((id) => id.length > 0),
	);
	const excludeVerificationForTaskIds = new Set(
		(options.excludeVerificationForTaskIds || [])
			.map((id) => id.trim())
			.filter((id) => id.length > 0),
	);
	return { excludedTaskIds, excludeVerificationForTaskIds };
}

function shouldExcludeTask(
	task: BrainTaskRecord,
	options: NormalizedTaskDeterminationOptions,
): boolean {
	if (options.excludedTaskIds.has(task.id)) {
		return true;
	}

	if (
		task.sourceRef &&
		options.excludeVerificationForTaskIds.has(task.sourceRef) &&
		isVerificationFollowupTask(task)
	) {
		return true;
	}

	return false;
}

function isVerificationFollowupTask(task: BrainTaskRecord): boolean {
	if (task.id.startsWith("verify-")) return true;
	if (isValidationTaskSubject(task.subject)) return true;
	if (isVerificationTaskSubject(task.subject)) return true;
	if (task.classification === "qa") return true;
	return false;
}

async function buildStatusSnapshot(db: BrainDb): Promise<StatusSnapshot> {
	const [completedTasks, discoveries] = await Promise.all([
		getCompletedTasks(db),
		getOpenDiscoveries(db),
	]);

	return {
		completed: completedTasks.map(
			(t) =>
				`- ${t.subject}${t.completedAt ? ` (${t.completedAt.split("T")[0]})` : ""}`,
		),
		discoveries: discoveries.map(
			(d) => `- [${(d.severity || "info").toUpperCase()}] ${d.title}`,
		),
	};
}

interface DetectedDependency {
	taskId: string;
	reason: string;
	blocking: boolean;
}

interface DependencyCollectionResult {
	dependencies: DetectedDependency[];
	planUpdateReasons: string[];
}

interface KeywordDependencyResult {
	matches: DetectedDependency[];
	missingReasons: string[];
}

type TaskRow = {
	id: string;
	subject: string;
	status: string;
	consensusStatus: string | null;
	phase?: string | null;
};

function collectDependenciesForTask(
	db: BrainDb,
	options: {
		taskId: string;
		subject: string;
		phaseLabel: string;
		planDependencies: string[];
	},
): DependencyCollectionResult {
	const planResolution = resolvePlanDependencies(
		db,
		options.planDependencies || [],
	);
	const keywordResult = detectKeywordDependencies(
		db,
		options.taskId,
		options.subject,
	);

	const dependencyMap = new Map<string, DetectedDependency>();
	const addDependency = (dep: DetectedDependency) => {
		const existing = dependencyMap.get(dep.taskId);
		if (!existing) {
			dependencyMap.set(dep.taskId, dep);
			return;
		}

		const mergedReason = existing.reason.includes(dep.reason)
			? existing.reason
			: `${existing.reason}; ${dep.reason}`;

		dependencyMap.set(dep.taskId, {
			taskId: dep.taskId,
			reason: mergedReason,
			blocking: existing.blocking || dep.blocking,
		});
	};

	planResolution.matched.forEach(addDependency);
	keywordResult.matches.forEach(addDependency);

	const planUpdateReasons = new Set<string>();
	planResolution.unresolved.forEach((dep) => {
		planUpdateReasons.add(
			`Plan references "${dep}" but no matching tasks were found in SQLite.`,
		);
	});
	keywordResult.missingReasons.forEach((reason) => {
		planUpdateReasons.add(reason);
	});

	return {
		dependencies: Array.from(dependencyMap.values()),
		planUpdateReasons: Array.from(planUpdateReasons),
	};
}

function resolvePlanDependencies(
	db: BrainDb,
	rawDependencies: string[],
): {
	matched: DetectedDependency[];
	unresolved: string[];
} {
	const matched: DetectedDependency[] = [];
	const unresolved: string[] = [];

	for (const depText of rawDependencies) {
		const trimmed = depText.trim();
		if (!trimmed) {
			continue;
		}

		const matches = findTasksMatchingDependency(db, trimmed);
		if (matches.length === 0) {
			unresolved.push(trimmed);
			continue;
		}

		matches.forEach((task) => {
			matched.push({
				taskId: task.id,
				reason: `Plan dependency "${trimmed}"`,
				blocking:
					task.status !== "completed" && task.consensusStatus !== "reached",
			});
		});
	}

	return { matched, unresolved };
}

function findTasksMatchingDependency(
	db: BrainDb,
	dependencyLabel: string,
): TaskRow[] {
	const normalized = dependencyLabel.trim();
	if (!normalized) {
		return [];
	}

	const phaseMatch = normalized.match(/Phase\s+([\d.]+)/i);
	const patterns: string[] = [`%${normalized}%`];
	if (phaseMatch) {
		patterns.push(`Phase ${phaseMatch[1]}%`);
	}

	const matches = new Map<string, TaskRow>();
	const tasks = db.listTasks({
		excludeStatuses: ["cancelled"],
		limit: 500,
	});
	for (const pattern of patterns) {
		const normalizedPattern = pattern.replace(/%/g, "").toLowerCase();
		const rows = tasks.filter((task) => {
			const subjectMatch = task.subject.toLowerCase().includes(normalizedPattern);
			const phaseMatch = (task.phase || "").toLowerCase().includes(normalizedPattern);
			return subjectMatch || phaseMatch;
		}).map((task) => ({
			id: task.id,
			subject: task.subject,
			status: task.status,
			consensusStatus: task.consensusStatus,
			phase: task.phase,
		}));

		for (const row of rows) {
			if (!matches.has(row.id)) {
				matches.set(row.id, row);
			}
		}
	}

	return Array.from(matches.values());
}

function detectKeywordDependencies(
	db: BrainDb,
	taskId: string,
	taskSubject: string,
): KeywordDependencyResult {
	const matches: DetectedDependency[] = [];
	const missingReasons: string[] = [];
	const subjectLower = taskSubject.toLowerCase();

	if (!subjectLower) {
		return { matches, missingReasons };
	}

	const dependencyRules: Array<{
		keywords: string[];
		dependsOnKeywords: string[];
		reason: string;
	}> = [
		{
			keywords: ["api", "server", "endpoint"],
			dependsOnKeywords: ["database", "schema"],
			reason: "API typically requires database schema",
		},
		{
			keywords: ["websocket", "realtime", "real-time"],
			dependsOnKeywords: ["api", "server"],
			reason: "WebSocket builds on API server",
		},
		{
			keywords: ["ui", "dashboard", "frontend", "react"],
			dependsOnKeywords: ["api", "server", "endpoint"],
			reason: "UI typically requires API endpoints",
		},
		{
			keywords: ["test", "qa", "verify"],
			dependsOnKeywords: ["implementation", "code", "feature"],
			reason: "Tests require existing implementation",
		},
		{
			keywords: ["documentation", "docs", "readme"],
			dependsOnKeywords: ["implementation", "feature", "api"],
			reason: "Documentation requires implementation",
		},
		{
			keywords: ["migration", "schema"],
			dependsOnKeywords: ["database"],
			reason: "Migration requires database",
		},
	];

	const existingTasks = db
		.listTasks({
			excludeStatuses: ["cancelled"],
			limit: 500,
		})
		.filter((task) => task.id !== taskId)
		.map((task) => ({
			id: task.id,
			subject: task.subject,
			status: task.status,
			consensus_status: task.consensusStatus,
		}));

	for (const rule of dependencyRules) {
		if (!rule.keywords.some((keyword) => subjectLower.includes(keyword))) {
			continue;
		}

		const ruleMatches = existingTasks.filter((task) =>
			rule.dependsOnKeywords.some((keyword) =>
				task.subject.toLowerCase().includes(keyword),
			),
		);

		if (ruleMatches.length === 0) {
			missingReasons.push(
				`Missing tracked dependency for ${taskSubject}: ${rule.reason}`,
			);
			continue;
		}

		ruleMatches.forEach((task) => {
			matches.push({
				taskId: task.id,
				reason: `${rule.reason} (matched ${task.subject})`,
				blocking:
					task.status !== "completed" && task.consensus_status !== "reached",
			});
		});
	}

	return { matches, missingReasons };
}

function ensurePlanDependencyTask(
	db: BrainDb,
	options: { phaseLabel: string; reasons: string[]; now: string },
): void {
	const uniqueReasons = Array.from(new Set(options.reasons.filter(Boolean)));
	if (uniqueReasons.length === 0) {
		return;
	}

	const label = options.phaseLabel || "Current Phase";
	const subject = `Update plan dependencies for ${label}`;
	const existing = db.listTasks({
		includeSubject: subject,
		excludeStatuses: ["completed", "failed", "cancelled"],
		limit: 50,
	}).find((task) => task.subject === subject);

	if (existing) {
		return;
	}

	const taskId = `deps-${slugify(label)}-${Date.now().toString(36)}`;
	const description = [
		`Dependencies for ${label} need clarification.`,
		"",
		"Document the following in .project/plan.md:",
		...uniqueReasons.map((reason) => `- ${reason}`),
		"",
		"Update the ### Dependencies section so the brain can schedule work confidently.",
	].join("\n");

	db.createTask({
		id: taskId,
		subject,
		description,
		status: "pending",
		priority: "normal",
		domain: "architect",
		phase: label,
		sourceType: "manual",
		sourceRef: `dependency:${label}`,
	});
}

function slugify(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "phase"
	);
}

function parseArmsFromJson(json: string): string[] {
	try {
		return JSON.parse(json || "[]");
	} catch {
		return [];
	}
}

/**
 * Generate the task briefing returned by `get_full_briefing`.
 *
 * This is the main prompt payload an arm sees when it starts work or when the
 * brain automatically hands it off to the next task after completion.
 */
export async function generateContextBundle(
	ctx: PromptContext,
	taskSubject: string,
): Promise<ContextBundleResult | null> {
	const { db, projectRoot } = ctx;

	const task = await getTaskBySubject(db, taskSubject);

	if (!task) {
		return null;
	}

	// 3. Get discoveries relevant to the task
	const discoveries = await getOpenDiscoveries(db);

	// 3b. Get task-specific discoveries (especially exploration phase discoveries from other arms)
	const taskDiscoveries = await getTaskRelatedDiscoveries(db, task.id);

	// 3c. Use LLM to summarize discoveries for this task's context
	const config = await loadConfig(ctx.coleoDir);
	const summarizer = new DiscoverySummarizer(undefined, resolveBrainModelConfig(config.brain));
	const discoverySummary = await summarizer.summarize({
		task,
		globalDiscoveries: discoveries,
		taskDiscoveries,
	});

	// 4. Get completed tasks
	const completedTasks = await getCompletedTasks(db);

	// 5. Read plan
	const plan = await readCurrentPlan(projectRoot, ctx.workspace);

	// 6. Generate instructions based on task classification
	const instructions = generateInstructions(task);

	const fullOutput = buildContextBundle(task, {
		discoverySummary,
		completedTasks,
		planExcerpt: plan.currentPhase || plan.content,
		instructions,
	});

	return {
		task: {
			subject: task.subject,
			description: task.description,
			classification: task.domain || "development",
			priority: task.priority,
		},
		context: {
			discoveries: formatDiscoverySummary(discoverySummary),
			planExcerpt: plan.currentPhase || plan.content,
			taskHistory: completedTasks
				.slice(0, 5)
				.map((t) => `- ${t.subject} (completed: ${t.completedAt || "unknown"})`)
				.join("\n"),
			instructions,
			attachments: formatTaskAttachmentList(task.context?.attachments),
		},
		fullOutput,
	};
}

// ============================================
// Helper Functions
// ============================================

// NOTE: readCurrentPlan is used ONLY for the context bundle plan excerpt,
// NOT for task selection. Task determination reads exclusively from the
// tasks API (database). Plan → task syncing is handled by syncPlanTasks.

async function readCurrentPlan(projectRoot: string, workspace?: WorkspaceAccess): Promise<{
	content: string;
	goals: string[];
	bullets: string[];
	currentPhase: string;
	dependencies: string[];
}> {
	const mainPlanPath = join(projectRoot, ".project", "plan.md");
	
	let allContent = "";
	const goals: string[] = [];
	const bullets: string[] = [];
	let currentPhase = "";
	
	try {
		const access = workspace || new LocalWorkspaceAccess(projectRoot);
		const file = await access.readText(mainPlanPath);
		if (!file) throw new Error("plan file does not exist");
		allContent = file.content;
	} catch (err) {
		allContent = "# Plan not found or unreadable. Task determination requires the database tasks API for accurate information.";
		console.warn(`Could not read plan file ${mainPlanPath}: ${err}`);
	}

	// Extract current phase (the first incomplete phase)
	const lines = allContent.split("\n");
	let inCurrentPhase = false;
	let phaseContent: string[] = [];
	let foundIncomplete = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const phaseMatch = line.match(/^## (Phase \d+(?:\.\d+)?):/);
		if (phaseMatch) {
			const isComplete = line.includes("✅ Complete");

			if (!isComplete && !foundIncomplete) {
				inCurrentPhase = true;
				phaseContent = [line];
				foundIncomplete = true;
			} else {
				inCurrentPhase = false;
			}
			continue;
		}

		if (inCurrentPhase) {
			if (line.startsWith("## ") && line.match(/^## (Phase \d+(?:\.\d+)?):/)) {
				break;
			}
			phaseContent.push(line);
		}
	}

	currentPhase = phaseContent.join("\n").trim();
	const dependencies = extractDependenciesFromPhase(currentPhase);

	let inGoals = false;
	let inBullets = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.startsWith("## Goal")) {
			inGoals = true;
			inBullets = false;
			continue;
		}
		if (
			line.startsWith("## Approach") ||
			line.startsWith("## Implementation")
		) {
			inGoals = false;
			inBullets = true;
			continue;
		}
		if (line.startsWith("## ") && !inGoals && !inBullets) {
			inGoals = false;
			inBullets = false;
		}

		if (inGoals && line.startsWith("- ")) {
			goals.push(line.slice(2).trim());
		}
		if (inBullets && (line.startsWith("- ") || line.match(/^\d+\./))) {
			bullets.push(line.replace(/^-\s*|^\d+\.\s*/, "").trim());
		}
	}

	return { content: allContent, goals, bullets, currentPhase, dependencies };
}

function extractDependenciesFromPhase(phaseContent: string): string[] {
	if (!phaseContent) {
		return [];
	}

	const lines = phaseContent.split("\n");
	const dependencies: string[] = [];
	let inDependencies = false;

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}

		if (line.toLowerCase().startsWith("### dependencies")) {
			inDependencies = true;
			continue;
		}

		if (inDependencies && (line.startsWith("### ") || line.startsWith("## "))) {
			break;
		}

		if (!inDependencies) {
			continue;
		}

		if (line.startsWith("-") || line.startsWith("*")) {
			const cleaned = line.replace(/^[-*]\s*/, "").trim();
			if (cleaned) {
				dependencies.push(cleaned);
			}
		} else if (dependencies.length > 0) {
			dependencies[dependencies.length - 1] =
				`${dependencies[dependencies.length - 1]} ${line}`.trim();
		}
	}

	return dependencies;
}

async function getCompletedTasks(
	db: BrainDb,
): Promise<Array<{ subject: string; status: string; completedAt?: string }>> {
	try {
		const results = db.listTasks({
			statuses: ["completed"],
			sort: "completed_desc",
			limit: 10,
		});

		return results.map((r) => ({
			subject: r.subject,
			status: r.status,
			completedAt: r.completedAt || undefined,
		}));
	} catch {
		return [];
	}
}

async function getOpenDiscoveries(db: BrainDb): Promise<Discovery[]> {
	try {
		const results = db
			.listDiscoveries({
				status: "open",
				limit: 100,
			})
			.sort((a, b) => {
				const rank = (severity: string): number => {
					switch (severity) {
						case "error":
							return 1;
						case "warning":
							return 2;
						case "info":
						default:
							return 3;
					}
				};
				const diff = rank(a.severity) - rank(b.severity);
				if (diff !== 0) {
					return diff;
				}
				return b.createdAt.localeCompare(a.createdAt);
			})
			.slice(0, 20);

		return results.map((r) => ({
			kind: r.kind as Discovery["kind"],
			title: r.title,
			details: r.details,
			file: r.filePath || undefined,
			line: r.lineNumber || undefined,
			severity: (r.severity || "info") as Discovery["severity"],
			taskId: r.taskId || undefined,
			phase: (r.phase || "implementation") as Discovery["phase"],
		}));
	} catch {
		return [];
	}
}

/**
 * Get discoveries related to a specific task
 * Returns exploration discoveries from other arms that worked on this task,
 * plus any discoveries explicitly linked to the task
 */
async function getTaskRelatedDiscoveries(
	db: BrainDb,
	taskId: string,
): Promise<Discovery[]> {
	try {
		const results = db
			.listDiscoveries({
				status: "open",
				taskId,
				limit: 200,
			})
			.sort((a, b) => {
				const phaseRank = (phase: string | null | undefined): number => {
					switch (phase) {
						case "exploration":
							return 1;
						case "implementation":
							return 2;
						case "verification":
							return 3;
						default:
							return 4;
					}
				};
				const severityRank = (severity: string): number => {
					switch (severity) {
						case "error":
							return 1;
						case "warning":
							return 2;
						case "info":
						default:
							return 3;
					}
				};
				const phaseDiff = phaseRank(a.phase) - phaseRank(b.phase);
				if (phaseDiff !== 0) {
					return phaseDiff;
				}
				const severityDiff = severityRank(a.severity) - severityRank(b.severity);
				if (severityDiff !== 0) {
					return severityDiff;
				}
				return b.createdAt.localeCompare(a.createdAt);
			})
			.slice(0, 30);

		return results.map((r) => ({
			kind: r.kind as Discovery["kind"],
			title: r.title,
			details: r.details,
			file: r.filePath || undefined,
			line: r.lineNumber || undefined,
			severity: (r.severity || "info") as Discovery["severity"],
			taskId: r.taskId || undefined,
			phase: (r.phase || "implementation") as Discovery["phase"],
		}));
	} catch {
		return [];
	}
}

async function getTaskBySubject(
	db: BrainDb,
	subject: string,
): Promise<Task | null> {
	try {
		const normalized = subject.trim();
		if (!normalized) {
			return null;
		}
		const normalizedLower = normalized.toLowerCase();
		const tasks = db.listTasks({
			excludeStatuses: ["cancelled"],
			limit: 500,
		});
		const result =
			tasks.find((task) => task.id === normalized) ||
			tasks.find((task) => task.subject.trim().toLowerCase() === normalizedLower) ||
			tasks.find((task) =>
				task.subject.toLowerCase().includes(normalizedLower),
			);

		if (result) {
			return {
				id: result.id,
				subject: result.subject,
				description: result.description,
				status: result.status as Task["status"],
				priority: result.priority as Task["priority"],
				domain: result.domain || undefined,
				createdAt: new Date(),
				updatedAt: new Date(),
				context: result.context,
			};
		}
	} catch {
		// fall through to bug lookup
	}

	const bug = await getBugBySubject(db, subject);
	if (!bug) {
		return null;
	}

	return {
		id: bug.id,
		subject: bug.title,
		description: bug.description,
		status: mapBugStatusToTaskStatus(bug.status),
		priority: mapBugPriority(bug.priority),
		domain: "bug_fix",
		createdAt: new Date(),
		updatedAt: new Date(),
		context: bug.errorDetails
			? { notes: `Bug error details: ${bug.errorDetails}` }
			: undefined,
	};
}

async function getBugBySubject(
	db: BrainDb,
	subject: string,
): Promise<{
	id: string;
	title: string;
	description: string;
	priority: string;
	status: string;
	errorDetails?: string;
} | null> {
	try {
		const normalized = subject.trim();
		if (!normalized) {
			return null;
		}
		const normalizedLower = normalized.toLowerCase();
		const bugs = db.listBugs({ limit: 200 });
		const result =
			bugs.find((bug) => bug.id === normalized) ||
			bugs.find((bug) => bug.title.trim().toLowerCase() === normalizedLower) ||
			bugs.find((bug) => bug.title.toLowerCase().includes(normalizedLower));

		if (!result) {
			return null;
		}

		return {
			id: result.id,
			title: result.title,
			description: result.description,
			priority: result.priority,
			status: result.status,
			errorDetails: result.errorDetails || undefined,
		};
	} catch {
		return null;
	}
}

function mapBugStatusToTaskStatus(status: string): Task["status"] {
	switch (status) {
		case "fixing":
		case "verifying":
			return "in_progress";
		case "resolved":
		case "closed":
			return "completed";
		case "open":
		case "investigating":
		default:
			return "pending";
	}
}

function generateInstructions(task: Task): string {
	const domain = task.domain?.toLowerCase() || "";
	const subject = task.subject.toLowerCase();
	const isBugTask =
		domain === "bug_fix" ||
		task.id.startsWith("bug-") ||
		subject.includes("bug");

	// These domain-specific instructions are embedded directly into the
	// `get_full_briefing` response, so keep them short, operational, and safe to
	// reuse when an arm is auto-handed-off to follow-up work.

	let baseInstructions = `## Your Task: ${task.subject}

${task.description}

## Important Context

- You are an AI agent executing a specific task, but this task may already be started by previous iterations or other agents so verify existing code against your acceptance criteria before making changes.
- Use the MCP tools you have available to explore, modify, and analyze the codebase.
- If you are uncertain about if a task is really done, search the codebase for references to the feature that was changed and analyze each location to see if it matches the purpose outlined in the task.
- Report discoveries as you find them using report_discovery
- ${
		isBugTask
			? "For bug work, track progress with update_bug_status (not complete_task)."
			: "Complete the task when done using complete_task"
	}
- If you need clarification, ask for it

## Process

1. Read and understand the task above
2. Explore the codebase as needed
3. Make changes to implement or fix the issue
4. Report any discoveries (bugs, patterns, issues)
5. ${
		isBugTask
			? "Use update_bug_status to report investigation/fix/verification progress."
			: "Complete the task with a summary"
	}`;

	if (isBugTask) {
		return (
			baseInstructions +
			`

## Bug-Fix Specific

- Use \`claim_bug\` if this bug is not already assigned.
- Use \`update_bug_status\` as you move through investigating -> fixing -> verifying -> resolved.
- Include a concrete \`resolution\` when marking a bug resolved.
- Do not use \`complete_task\` with bug IDs.`
		);
	}

	if (domain === "docs" || subject.includes("doc")) {
		return (
			baseInstructions +
			`

## Documentation-Specific

- Focus on feature docs, API docs, and capabilities docs
- Do NOT update conceptual or architectural docs
- Match docs to actual code implementation
- Add "Future Work" notes for planned but unimplemented features`
		);
	}

	if (domain === "testing" || subject.includes("test")) {
		return (
			baseInstructions +
			`

## Testing-Specific

- search for existing tests, read comments, and find code that should have been tested that other agents left behind.
- Write tests that verify the implementation
- Consider edge cases
- Ensure tests are maintainable
- Run existing tests to verify nothing is broken`
		);
	}

	if (domain === "refactoring" || subject.includes("refactor")) {
		return (
			baseInstructions +
			`

## Refactoring-Specific

- This guidance is intentionally conservative because refactor tasks are often
  resumed via follow-up briefings after another arm iteration.
- **Prerequisites**: Verify git working tree is clean, services are running, and no other arms have claims on target files
- **File Size Thresholds**: Files >800 lines are critical, >600 lines are high priority, >400 lines are normal priority
- **Incremental Approach**: Work on ONE file at a time, or split large files into batches of 5-10 files maximum
- **Test Safety**: Run ALL tests after each refactoring batch to ensure no regressions
- **Extraction Strategy**: Break down monolithic functions into smaller, focused units; separate concerns into distinct modules
- **Document Changes**: Add comments explaining refactoring rationale
- **Report Blockers**: If a file is too large or complex for incremental refactoring, report a discovery and request breakdown into subtasks`
		);
	}

	return baseInstructions;
}

function buildContextBundle(
	task: Task,
	context: {
		discoverySummary: DiscoverySummary;
		completedTasks: Array<{ subject: string; completedAt?: string }>;
		planExcerpt: string;
		instructions: string;
	},
): string {
	// Format the LLM-summarized discoveries
	const discoverySection = formatDiscoverySummary(context.discoverySummary);
	const attachmentSection = formatTaskAttachmentList(task.context?.attachments);
	const isBugTask =
		(task.domain?.toLowerCase() || "") === "bug_fix" ||
		task.id.startsWith("bug-");
	const completionGuidance = isBugTask
		? `For bug workflows, use update_bug_status:
- bug_id: "${task.id}"
- status: one of investigating | fixing | verifying | resolved | closed
- resolution: required when marking as resolved`
		: `When you complete the task, use the complete_task MCP tool with:
- task_id: "${task.id}"
- summary: What you accomplished
- artifacts: Any files changed or created`;

	return `=== OCTOPAI TASK ASSIGNMENT ===

## TASK INFORMATION
Subject: ${task.subject}
Priority: ${task.priority}
Classification: ${task.domain || "development"}
ID: ${task.id}

## TASK DESCRIPTION
${task.description}

${attachmentSection}

=== CONTEXT BUNDLE ===

## INSTRUCTIONS
${context.instructions}

${discoverySection}

## COMPLETED TASKS (Recent)
${
	context.completedTasks.length > 0
		? context.completedTasks
				.slice(0, 5)
				.map(
					(t) =>
						`- ${t.subject}${t.completedAt ? ` (${t.completedAt.split("T")[0]})` : ""}`,
				)
				.join("\n")
		: "No completed tasks recorded."
}

## PLAN EXCERPT
${context.planExcerpt.slice(0, 600)}
${context.planExcerpt.length > 600 ? "\n[... more in .project/plan.md ...]" : ""}

=== END CONTEXT BUNDLE ===

${completionGuidance}

Good luck!`;
}

/**
 * Format task determination as plain text for CLI output
 * Note: No PLAN STATUS section is included - task determination relies on tasks API only
 */
export function formatTaskDetermination(
	result: TaskDeterminationResult,
): string {
	let output = `=== OCTOPAI TASK DETERMINATION ===
 Generated: ${new Date().toISOString()}
 
 ## REASONING
 ${result.reasoning}
 
 `;

	if (result.task) {
		output += `## RECOMMENDED TASK
 ID: ${result.task.id || "(synthetic - not in database)"}
 Subject: ${result.task.subject}
 Classification: ${result.task.classification}
 Priority: ${result.task.priority}
 ${result.task.domain ? `Domain: ${result.task.domain}` : ""}
 
 Description:
 ${result.task.description}
 `;
	} else {
		output += `## NO TASK DETERMINED
 Unable to determine next task. See reasoning above.
 `;
	}

	output += `
 
 ## COMPLETED TASKS (${result.completedTasks.length})
 ${result.completedTasks.length > 0 ? result.completedTasks.join("\n") : "None recorded"}
 
 ## OPEN DISCOVERIES (${result.openDiscoveries.length})
 ${result.openDiscoveries.length > 0 ? result.openDiscoveries.join("\n") : "None recorded"}
 
 === END TASK DETERMINATION ===
 `;
	return output;
}

/**
 * Format context bundle as plain text for CLI output
 */
export function formatContextBundle(result: ContextBundleResult): string {
	return result.fullOutput;
}

export const __promptTestables = {
	readCurrentPlan,
	extractDependenciesFromPhase,
	collectDependenciesForTask,
	detectKeywordDependencies,
	ensurePlanDependencyTask,
};
