/**
 * Utility functions for Brain module
 *
 * Pure functions with no dependencies on Brain class instance state.
 * Extracted from brain.ts for better maintainability.
 */

import type { Task } from "../types";

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
export function extractMessageTimestampMs(
	message: Record<string, unknown>,
): number | null {
	const info = message.info;
	if (!info || typeof info !== "object") {
		return null;
	}
	const time = (info as Record<string, unknown>).time;
	if (!time || typeof time !== "object") {
		return null;
	}
	const timeObj = time as Record<string, unknown>;
	return (
		toEpochMs(timeObj.completed) ?? toEpochMs(timeObj.created) ?? null
	);
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
	domain?: string | null;
	classification?: string | null;
	assignedTo?: string | null;
	dependencyBlocked?: boolean;
	sortOrder?: number | null;
	createdAt: string;
	updatedAt: string;
	completedAt?: string | null;
	artifacts?: string[];
	mailThreadId?: string | null;
	context?: Task["context"];
}): Task {
	return {
		id: task.id,
		subject: task.subject,
		description: task.description,
		status: task.status as Task["status"],
		priority: task.priority as Task["priority"],
		domain: task.domain || undefined,
		classification: task.classification || undefined,
		assignedTo: task.assignedTo || undefined,
		dependencyBlocked: task.dependencyBlocked === true,
		sortOrder: task.sortOrder ?? undefined,
		createdAt: new Date(task.createdAt),
		updatedAt: new Date(task.updatedAt),
		completedAt: task.completedAt ? new Date(task.completedAt) : undefined,
		artifacts: task.artifacts || [],
		mailThreadId: task.mailThreadId || undefined,
		context: task.context || undefined,
	};
}
