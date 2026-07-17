/**
 * Utility functions for Brain module
 *
 * Pure functions with no dependencies on Brain class instance state.
 * Extracted from brain.ts for better maintainability.
 */

import type { Task } from "../types";
import { isRecord } from "../utils/json";

function isTaskStatus(value: string): value is Task["status"] {
	return (
		value === "pending" ||
		value === "claimed" ||
		value === "in_progress" ||
		value === "completing" ||
		value === "completed" ||
		value === "failed" ||
		value === "blocked"
	);
}

function isTaskPriority(value: string): value is Task["priority"] {
	return (
		value === "critical" ||
		value === "high" ||
		value === "normal" ||
		value === "low"
	);
}

function isTaskSourceType(value: string): value is NonNullable<Task["sourceType"]> {
	return (
		value === "manual" ||
		value === "plan" ||
		value === "email" ||
		value === "discovery" ||
		value === "proposal" ||
		value === "system"
	);
}

export interface SessionMessageInfo {
	id?: string;
	role?: string;
	modelID?: string;
	providerID?: string;
	agent?: string;
	sessionID?: string;
	sessionId?: string;
	time?: {
		created?: number;
		completed?: number;
	};
}

export interface SessionMessagePart {
	type?: string;
	text?: string;
}

export interface SessionMessage {
	info?: SessionMessageInfo;
	parts?: SessionMessagePart[];
}

export function isSessionMessage(value: unknown): value is SessionMessage {
	if (!isRecord(value)) {
		return false;
	}

	if (value.info !== undefined) {
		if (!isRecord(value.info)) {
			return false;
		}
		if (value.info.time !== undefined && !isRecord(value.info.time)) {
			return false;
		}
	}

	if (value.parts !== undefined) {
		if (!Array.isArray(value.parts)) {
			return false;
		}
		if (value.parts.some((part) => !isRecord(part))) {
			return false;
		}
	}

	return true;
}

/**
 * Strip terminal artifacts from text
 * Cleans up terminal output for analysis and display
 */
export function stripTerminalArtifacts(text: string): string {
	return (
		text
			// ANSI escape sequences (colors, cursor movement, etc.)
			.replace(
				new RegExp("\\u001B(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])", "g"),
				"",
			)
			// OSC sequences (terminal titles, hyperlinks, etc.)
			.replace(
				new RegExp(
					"\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)",
					"g",
				),
				"",
			)
			// CSI sequences that might be malformed
			.replace(new RegExp("\\u001B\\[[\\d;]*[A-Za-z]", "g"), "")
			// Other escape sequences
			.replace(new RegExp("\\u001B[PX^_].*?\\u001B\\\\", "g"), "")
			// Control characters (keep \t \n \r)
			.replace(
				new RegExp(
					"[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]",
					"g",
				),
				"",
			)
			// Box-drawing and block characters (TUI borders)
			.replace(
				/[─━│┃┄┅┆┇┈┉┊┋┌┍┎┏┐┑┒┓└┕┖┗┘┙┚┛├┝┞┟┠┡┢┣┤┥┦┧┨┩┪┫┬┭┮┯┰┱┲┳┴┵┶┷┸┹┺┻┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋╌╍╎▏═║╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬]/g,
				"",
			)
			// Block elements (used for progress bars, etc.)
			.replace(/[▀▁▂▃▄▅▆▇█▉▊▋▌▍▎▏▐░▒▓▔▕▖▗▘▙▚▛▜▝▞▟■□▢▣▤▥▦▧▨▩▪▫▬▭▮▯]/g, "")
			// Geometric shapes (squares, diamonds, etc.)
			.replace(
				/[◆◇◈◉◊○◌◍◎●◐◑◒◓◔◕◖◗◘◙◚◛◜◝◞◟◠◡◢◣◤◥◦◧◨◩◪◫◬◭◮◯⬝⬞⬟⬠⬡⬢⬣⬤⬥⬦⬧⬨⬩⬪⬫⬬⬭⬮⬯]/g,
				"",
			)
			// More geometric and misc symbols
			.replace(/[⊙⊚⊛⊜⊝⊞⊟⊠⊡▰▱▲△▴▵▶▷▸▹►▻▼▽▾▿◀◁◂◃◄◅◆◇]/g, "")
			// Braille patterns (sometimes used for graphics)
			.replace(/[\u2800-\u28FF]/g, "")
			// Arrows and pointers
			.replace(
				/[←↑→↓↔↕↖↗↘↙↚↛↜↝↞↟↠↡↢↣↤↥↦↧↨↩↪↫↬↭↮↯↰↱↲↳↴↵↶↷↸↹↺↻↼↽↾↿⇀⇁⇂⇃⇄⇅⇆⇇⇈⇉⇊⇋⇌⇍⇎⇏⇐⇑⇒⇓⇔⇕⇖⇗⇘⇙⇚⇛⇜⇝⇞⇟⇠⇡⇢⇣⇤⇥⇦⇧⇨⇩⇪]/g,
				"",
			)
			// Dashes and special punctuation used in TUIs
			.replace(/[—–·•‣⁃◦]/g, "")
			// Spinner and progress characters
			.replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]/g, "")
			// Clean up leftover punctuation artifacts (repeated quotes, etc.)
			.replace(/[']{2,}/g, "")
			.replace(/["]{2,}/g, "")
			// Collapse multiple spaces/newlines
			.replace(/[ \t]+/g, " ")
			.replace(/\n{3,}/g, "\n\n")
			.trim()
	);
}

/**
 * Get file patterns an arm with a given domain would be interested in
 */
export function getDomainPatterns(domain: string): string[] {
	const patterns: Record<string, string[]> = {
		frontend: [
			"src/components/**",
			"src/web/**",
			"*.css",
			"*.scss",
			"*.tsx",
			"*.ts",
		],
		backend: ["src/api/**", "src/services/**", "src/db/**", "*.ts"],
		testing: ["**/*.test.*", "**/*.spec.*", "e2e/**", "__tests__/**"],
		docs: ["*.md", "docs/**", "README*"],
		architect: [
			"src/**",
			"*.toml",
			"*.json",
			"AGENTS.md",
			"docs/architecture/**",
		],
		devops: ["Dockerfile", ".github/**", "*.yml", "*.yaml", "infra/**"],
		general: ["src/**", "*.ts", "*.md"],
	};

	return patterns[domain] ?? patterns["general"] ?? [];
}

/**
 * Check if a harness state indicates active work
 */
export function isActiveHarnessState(state: string): boolean {
	return (
		state === "initializing" ||
		state === "processing" ||
		state === "executing" ||
		state === "waiting_approval" ||
		state === "busy"
	);
}

/**
 * Convert timestamp value to epoch milliseconds
 * Handles both seconds and milliseconds formats
 */
export function toEpochMs(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return null;
	}
	// OpenCode message times may be seconds while JS dates are milliseconds.
	return value < 1_000_000_000_000 ? value * 1000 : value;
}

/**
 * Extract timestamp from message info object
 */
export function extractMessageTimestampMs(message: SessionMessage): number | null {
	const info = message.info;
	if (!info) {
		return null;
	}
	const time = info.time;
	if (!time) {
		return null;
	}
	return toEpochMs(time.completed) ?? toEpochMs(time.created) ?? null;
}

/**
 * Get display name for an arm (prefers name over ID)
 */
export function getArmDisplayName(
	armId: string,
	armName?: string | null,
): string {
	if (armName) return armName;
	return armId;
}

/**
 * Convert status string to human-readable format
 */
export function humanizeStatus(value: string): string {
	return value
		.split("_")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

/**
 * Normalize task priority from various formats
 */
export function normalizeTaskPriority(
	value?: string | null,
): Task["priority"] | undefined {
	switch (value?.toLowerCase()) {
		case "low":
		case "trivial":
			return "low";
		case "medium":
		case "normal":
			return "normal";
		case "high":
		case "important":
			return "high";
		case "critical":
		case "urgent":
			return "critical";
		default:
			return undefined;
	}
}

/**
 * Normalize bug priority from various formats
 */
export function normalizeBugPriority(
	value?: string | null,
): "low" | "medium" | "high" | "critical" | undefined {
	switch (value?.toLowerCase()) {
		case "low":
		case "trivial":
			return "low";
		case "medium":
		case "normal":
			return "medium";
		case "high":
		case "important":
			return "high";
		case "critical":
		case "urgent":
			return "critical";
		default:
			return undefined;
	}
}

/**
 * Map API task format to internal Task type
 */
export function mapApiTask(task: {
	id: string;
	subject: string;
	description: string;
	status: string;
	priority: string;
	sourceType?: string | null;
	sourceRef?: string | null;
	domain?: string | null;
	classification?: string | null;
	assignedTo?: string | null;
	dependencyBlocked?: boolean;
	sortOrder?: number | null;
	orderKey?: string | null;
	createdAt: string;
	updatedAt: string;
	completedAt?: string | null;
	blockedAt?: string | null;
	artifacts?: string[];
	mailThreadId?: string | null;
	context?: Task["context"];
}): Task {
	const status = isTaskStatus(task.status) ? task.status : "pending";
	const priority = isTaskPriority(task.priority) ? task.priority : "normal";
	const sourceType = task.sourceType && isTaskSourceType(task.sourceType) ? task.sourceType : undefined;

	return {
		id: task.id,
		subject: task.subject,
		description: task.description,
		status,
		priority,
		sourceType,
		sourceRef: task.sourceRef || undefined,
		domain: task.domain || undefined,
		classification: task.classification || undefined,
		assignedTo: task.assignedTo || undefined,
		dependencyBlocked: task.dependencyBlocked === true,
		sortOrder: task.sortOrder ?? undefined,
		orderKey: task.orderKey ?? undefined,
		createdAt: new Date(task.createdAt),
		updatedAt: new Date(task.updatedAt),
		completedAt: task.completedAt ? new Date(task.completedAt) : undefined,
		blockedAt: task.blockedAt ? new Date(task.blockedAt) : undefined,
		artifacts: task.artifacts || [],
		mailThreadId: task.mailThreadId || undefined,
		context: task.context || undefined,
	};
}
