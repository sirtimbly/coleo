/**
 * MCP Server Utilities
 *
 * Shared utility functions for the MCP server.
 */

import { randomBytes } from "crypto";
import { writeFile, mkdir, readdir, readFile } from "fs/promises";
import { join } from "path";
import { getColeoDir } from "../config";
import { createApiDatabase } from "./api-db";
import type { Task, Note, QueueMessage } from "../types";
import { NatsClient } from "../nats";
import { eventStore } from "../nats/jetstream";
import { resolveApiKey, resolveApiUrl, resolveNatsUrl } from "../network-config";
import {
	getPendingMessages,
	markMessageCompleted,
	getNotes,
} from "../db/state";
import {
	createCommandEnvelope,
	getMcpCommandPublishMode,
} from "../nats/command-types";
import type { TaskDeterminationOptions, TaskDeterminationResult } from "../brain/prompt-generator";

// Get coleo directory from env or default (project-local)
export const COLEO_DIR = getColeoDir();
export const ARM_ID =
	process.env.COLEO_ARM_ID || process.env.COLEO_TENTACLE_ID || "unknown";
export const PROJECT_ROOT = process.env.COLEO_PROJECT_ROOT || process.cwd();
export const API_BASE_URL = resolveApiUrl();
export const API_KEY = resolveApiKey() || "dev-api-key-12345";

type StateDb = Parameters<typeof getPendingMessages>[0];

// API-backed database proxy connection (lazy initialization)
let dbClient: StateDb | null = null;

// NATS client (lazy initialization)
let natsClient: NatsClient | null = null;

// Cache for arm's session ID to avoid repeated DB queries
let cachedSessionId: string | null = null;
const POST_COMPLETION_EXCLUSION_TTL_MS = 30 * 60 * 1000;
let recentCompletedTaskExclusion: { taskId: string; recordedAtMs: number } | null =
	null;

// Reference resolution types
export interface TaskReferenceRow {
	id: string;
	subject: string;
	assigned_to: string | null;
	updated_at: string;
}

export interface BugReferenceRow {
	id: string;
	title: string;
	updated_at: string;
}

/**
 * Track a recently completed task to avoid immediate reassignment
 */
export function rememberRecentlyCompletedTask(taskId: string): void {
	const trimmed = taskId.trim();
	if (!trimmed) return;
	recentCompletedTaskExclusion = {
		taskId: trimmed,
		recordedAtMs: Date.now(),
	};
}

/**
 * Get the ID of a recently completed task for exclusion from new assignments
 */
export function getRecentCompletedTaskIdForExclusion(): string | null {
	const current = recentCompletedTaskExclusion;
	if (!current) return null;
	if (Date.now() - current.recordedAtMs > POST_COMPLETION_EXCLUSION_TTL_MS) {
		recentCompletedTaskExclusion = null;
		return null;
	}
	return current.taskId;
}

/**
 * Clear the recent completed task exclusion
 */
export function clearRecentCompletedTaskExclusion(): void {
	recentCompletedTaskExclusion = null;
}

/**
 * Build task determination options for the current arm
 */
export function buildTaskDeterminationOptionsForArm(): TaskDeterminationOptions {
	const recentlyCompletedTaskId = getRecentCompletedTaskIdForExclusion();
	if (!recentlyCompletedTaskId) {
		return {};
	}
	return {
		excludeTaskIds: [recentlyCompletedTaskId],
		excludeVerificationForTaskIds: [recentlyCompletedTaskId],
	};
}

/**
 * Update completion exclusion after task determination
 */
export function updateCompletionExclusionAfterDetermination(
	result: TaskDeterminationResult,
): void {
	const recentlyCompletedTaskId = getRecentCompletedTaskIdForExclusion();
	if (!recentlyCompletedTaskId) {
		return;
	}
	const determinedTaskId = result.task?.id;
	// Once the arm is routed to a different task (or bug), stop excluding.
	if (determinedTaskId && determinedTaskId !== recentlyCompletedTaskId) {
		clearRecentCompletedTaskExclusion();
	}
}

/**
 * Get the session ID for this arm from the database
 */
export async function getArmSessionId(): Promise<string | null> {
	if (cachedSessionId !== null) {
		return cachedSessionId;
	}

	try {
		const database = getDatabase();
		const row = database
			.query("SELECT session_id FROM arms WHERE id = ?")
			.get(ARM_ID) as { session_id: string } | null;
		cachedSessionId = row?.session_id || null;
		return cachedSessionId;
	} catch (err) {
		console.error(`[MCP] Failed to get session ID for arm ${ARM_ID}: ${err}`);
		return null;
	}
}

/**
 * Get or create database connection
 */
export function getDatabase(_readonly = true): StateDb {
	if (!dbClient) {
		dbClient = createApiDatabase(API_BASE_URL, API_KEY) as unknown as StateDb;
	}
	return dbClient;
}

/**
 * Get or create NATS client
 */
export async function getNatsClient(): Promise<NatsClient | null> {
	if (natsClient) return natsClient;

	const natsUrl = resolveNatsUrl();

	try {
		natsClient = new NatsClient({
			serverUrl: natsUrl,
			clientId: `arm-${ARM_ID}`,
			token: process.env.COLEO_NATS_TOKEN,
			debug: false,
		});

		await natsClient.connect();
		console.error(`[MCP] Connected to NATS at ${natsUrl}`);
		return natsClient;
	} catch (err) {
		console.error(`[MCP] NATS not available: ${err}`);
		natsClient = null;
		return null;
	}
}

/**
 * Log an activity to JetStream
 */
const TASK_ACTION_EVENT_TYPES: Record<string, string> = {
	claim_task: "task.claimed",
	complete_task: "task.completed",
	acknowledge_task: "task.claimed",
	submit_status_report: "task.status_reported",
	validate_task: "task.validated",
	report_dependency: "task.dependency_reported",
	report_discovery: "task.discovery_reported",
	context_compression: "task.context_compressed",
	get_task_determination: "task.determination_requested",
	get_context_bundle: "task.context_bundle_requested",
	get_full_briefing: "task.briefing_requested",
};

export function logActivity(
	actor: string,
	action: string,
	target?: string,
	details?: Record<string, unknown>,
): void {
	if (!eventStore.isInitialized()) return;

	const now = new Date().toISOString();
	const eventType = TASK_ACTION_EVENT_TYPES[action] ?? action;
	const data = { actor, action, target, ...details };

	// Always publish to the arm stream for the actor (correct arm attribution)
	eventStore
		.publishEvent(`coleo.events.arm.${actor}.${eventType}`, {
			type: eventType,
			armId: actor,
			data,
			timestamp: now,
		})
		.catch(() => {
			// Activity logging is best-effort
		});

	// If this is a task-related action with a target, also publish to task stream
	if (target && TASK_ACTION_EVENT_TYPES[action]) {
		eventStore
			.publishEvent(`coleo.events.task.${target}.${eventType}`, {
				type: eventType,
				armId: actor,
				data,
				timestamp: now,
			})
			.catch(() => {
				// Activity logging is best-effort
			});
		return;
	}

	// Otherwise, also publish to the MCP stream for general visibility
	if (!target) {
		eventStore
			.publishEvent(`coleo.events.mcp.${action}`, {
				type: action,
				armId: actor,
				data,
				timestamp: now,
			})
			.catch(() => {
				// Activity logging is best-effort
			});
	}
}

/**
 * Ensure the arm is registered in the database.
 * This allows "manual arms" (agents started by the user directly) to auto-register
 * when they first call an MCP tool, without requiring `coleo arm spawn`.
 */
export function ensureArmRegistered(): void {
	try {
		const database = getDatabase(false);
		const now = new Date().toISOString();

		// Check if arm already exists
		const existing = database
			.query("SELECT id, status FROM arms WHERE id = ?")
			.get(ARM_ID) as { id: string; status: string } | null;

		if (existing) {
			// Update last_activity_at and ensure status is running
			database.run(
				`UPDATE arms SET last_activity_at = ?, status = CASE WHEN status = 'stopped' THEN 'running' ELSE status END, updated_at = ? WHERE id = ?`,
				[now, now, ARM_ID],
			);
			return;
		}

		// Auto-register as a manual arm
		const armName = ARM_ID.startsWith("arm-") ? ARM_ID : `manual-${ARM_ID}`;

		database.run(
			`
      INSERT INTO arms (id, name, domain, harness, status, context_budget, current_context_used, created_at, updated_at, last_activity_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
			[
				ARM_ID,
				armName,
				"general", // domain - can be updated later
				"manual", // harness - indicates manually started
				"running", // status
				300000, // context_budget
				0, // current_context_used
				now,
				now,
				now,
			],
		);

		console.error(`[MCP] Auto-registered manual arm: ${ARM_ID}`);
		logActivity(ARM_ID, "arm_auto_registered", ARM_ID, {
			harness: "manual",
			source: "mcp_tool_call",
		});
	} catch (err) {
		// Best-effort registration - don't fail the tool call
		console.error(`[MCP] Failed to auto-register arm: ${err}`);
	}
}

/**
 * Publish a command via the API
 */
export async function publishCommandViaApi(
	envelope: ReturnType<typeof createCommandEnvelope>,
	endpoint = "/api/brain/internal/commands/publish",
): Promise<void> {
	const response = await fetch(`${API_BASE_URL}${endpoint}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-API-Key": API_KEY,
		},
		body: JSON.stringify(envelope),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(
			`API publish failed (${response.status} ${response.statusText})${errorText ? `: ${errorText}` : ""}`,
		);
	}
}

/**
 * Publish a command via NATS
 */
export async function publishCommandViaNats(
	envelope: ReturnType<typeof createCommandEnvelope>,
): Promise<void> {
	const nats = await getNatsClient();
	if (!nats || !nats.connected()) {
		throw new Error("NATS unavailable");
	}
	await nats.publishCommandEnvelope(envelope);
}

/**
 * Send a command message to the brain through API/JetStream
 */
export async function sendToBrain(
	message: Omit<QueueMessage, "id" | "timestamp">,
): Promise<string> {
	const envelope = createCommandEnvelope({
		id: `${Date.now()}-${randomBytes(4).toString("hex")}`,
		from: message.from,
		to: message.to,
		type: message.type,
		payload: message.payload,
	});
	const mode = getMcpCommandPublishMode();
	const errors: string[] = [];

	if (mode === "api" || mode === "auto") {
		try {
			await publishCommandViaApi(envelope, "/api/brain/internal/commands/publish");
			return envelope.id;
		} catch (err) {
			errors.push(`authoritative API publish failed: ${err}`);
		}
	}

	if (mode === "nats" || mode === "auto") {
		try {
			await publishCommandViaNats(envelope);
			return envelope.id;
		} catch (err) {
			errors.push(`direct NATS publish failed: ${err}`);
		}
	}

	try {
		await publishCommandViaApi(envelope, "/api/brain/internal/messages/queue");
		return envelope.id;
	} catch (err) {
		errors.push(`compat queue publish failed: ${err}`);
	}

	await sendToBrainFile({
		id: envelope.id,
		from: envelope.from,
		to: envelope.to,
		type: envelope.type as QueueMessage["type"],
		payload: envelope.payload,
		timestamp: new Date(envelope.createdAt),
	});
	console.error(`[MCP] All command publish paths failed, used file fallback: ${errors.join(" | ")}`);
	return envelope.id;
}

/**
 * Send a message to the brain via file fallback
 */
export async function sendToBrainFile(message: QueueMessage): Promise<void> {
	const queueDir = join(COLEO_DIR, "queue", "brain", "pending");
	await mkdir(queueDir, { recursive: true });

	const filename = `${message.id}-${message.from}-${message.type}.json`;
	await writeFile(
		join(queueDir, filename),
		JSON.stringify(message, null, 2),
		"utf-8",
	);
}

/**
 * Read pending tasks for this arm (from SQLite database)
 */
export async function getPendingTasks(): Promise<Task[]> {
	const tasks: Task[] = [];

	// Try to read from SQLite database
	try {
		const database = getDatabase();

		// Get all pending/claimed tasks that this arm could work on
		// Be permissive - any idle arm should be able to pick up unassigned work
		const dbTasks = database
			.query(`
      SELECT id, subject, description, status, priority, phase, domain, assigned_to, metadata, created_at, updated_at
      FROM tasks
      WHERE status IN ('pending', 'claimed')
      AND (
        assigned_to = ?           -- Tasks assigned to this arm
        OR assigned_to IS NULL    -- Unassigned tasks (any arm can claim)
        OR assigned_to = ''       -- Legacy: legacy empty string means unassigned
      )
      ORDER BY
        CASE WHEN assigned_to = ? THEN 0 ELSE 1 END,  -- Prioritize tasks assigned to this arm
        CASE priority
          WHEN 'critical' THEN 1
          WHEN 'high' THEN 2
          WHEN 'normal' THEN 3
          WHEN 'low' THEN 4
        END,
        created_at ASC
    `)
			.all(ARM_ID, ARM_ID) as Array<{
			id: string;
			subject: string;
			description: string;
			status: string;
			priority: string;
			phase: string | null;
			domain: string | null;
			assigned_to: string | null;
			metadata: string;
			created_at: string;
			updated_at: string;
		}>;

		for (const row of dbTasks) {
			tasks.push({
				id: row.id,
				subject: row.subject,
				description: row.description,
				status: row.status as Task["status"],
				priority: row.priority as Task["priority"],
				assignedTo: row.assigned_to || undefined,
				domain: row.domain || undefined,
				createdAt: new Date(row.created_at),
				updatedAt: new Date(row.updated_at),
				artifacts: [],
			});
		}
	} catch {
		// Database not available
	}

	return tasks;
}

/**
 * Get instructions/tasks assigned to this arm by the brain
 */
export async function getMyInstructions(): Promise<{
	tasks: Task[];
	messages: QueueMessage[];
}> {
	const tasks: Task[] = [];
	const messages: QueueMessage[] = [];

	// Try to read from SQLite database first
	try {
		const database = getDatabase();

		// Get pending messages from SQLite messages table
		const dbMessages = getPendingMessages(database, ARM_ID);
		for (const msg of dbMessages) {
			const queueMsg: QueueMessage = {
				id: msg.id,
				from: msg.from,
				to: msg.to,
				type: msg.type as QueueMessage["type"],
				payload: msg.payload,
				timestamp: msg.createdAt,
			};
			messages.push(queueMsg);

			// Extract task from task_assignment messages
			if (msg.type === "task_assignment" && msg.payload) {
				const task = msg.payload as Task;
				if (!tasks.find((t) => t.id === task.id)) {
					tasks.push(task);
				}
			}

			// Mark message as completed after reading
			markMessageCompleted(database, msg.id);
		}

		// Get tasks: assigned to this arm, OR pending/unassigned (any arm can claim)
		const dbTasks = database
			.query(`
      SELECT id, subject, description, status, priority, phase, domain, assigned_to, metadata, created_at, updated_at
      FROM tasks
      WHERE status IN ('pending', 'claimed', 'in_progress')
      AND (
        assigned_to = ?           -- Tasks assigned to this arm
        OR assigned_to IS NULL    -- Unassigned tasks (any arm can claim)
        OR assigned_to = ''       -- Legacy: legacy empty string means unassigned
      )
      ORDER BY
        CASE WHEN assigned_to = ? THEN 0 ELSE 1 END,  -- Prioritize tasks assigned to this arm
        CASE priority
          WHEN 'critical' THEN 1
          WHEN 'high' THEN 2
          WHEN 'normal' THEN 3
          WHEN 'low' THEN 4
        END,
        created_at ASC
    `)
			.all(ARM_ID, ARM_ID) as Array<{
			id: string;
			subject: string;
			description: string;
			status: string;
			priority: string;
			phase: string | null;
			domain: string | null;
			assigned_to: string | null;
			metadata: string;
			created_at: string;
			updated_at: string;
		}>;

		for (const row of dbTasks) {
			tasks.push({
				id: row.id,
				subject: row.subject,
				description: row.description,
				status: row.status as Task["status"],
				priority: row.priority as Task["priority"],
				assignedTo: row.assigned_to || undefined,
				domain: row.domain || undefined,
				createdAt: new Date(row.created_at),
				updatedAt: new Date(row.updated_at),
				artifacts: [],
			});
		}
	} catch {
		// Database not available, fall back to queue directory
	}

	// Also check the queue directory for task assignment messages
	const queueDir = join(COLEO_DIR, "queue", "arms", ARM_ID);
	try {
		const files = await readdir(queueDir);
		for (const file of files.sort()) {
			if (!file.endsWith(".json")) continue;
			try {
				const content = await readFile(join(queueDir, file), "utf-8");
				const message: QueueMessage = JSON.parse(content);
				messages.push(message);

				if (message.type === "task_assignment" && message.payload) {
					const task = message.payload as Task;
					// Avoid duplicates
					if (!tasks.find((t) => t.id === task.id)) {
						tasks.push(task);
					}
				}
			} catch {
				continue;
			}
		}
	} catch {
		// Queue doesn't exist yet
	}

	return { tasks, messages };
}

/**
 * Normalize a reference string
 */
export function normalizeReference(reference: string): string {
	return reference.trim();
}

/**
 * Find a task by reference (ID, subject, or partial match)
 */
export function findTaskByReference(taskReference: string): TaskReferenceRow | null {
	const normalized = normalizeReference(taskReference);
	if (!normalized) {
		return null;
	}

	try {
		const database = getDatabase();
		const byId = database
			.query(
				`SELECT id, subject, assigned_to, updated_at FROM tasks WHERE id = ? LIMIT 1`,
			)
			.get(normalized) as TaskReferenceRow | null;
		if (byId) {
			return byId;
		}

		const byExactSubject = database
			.query(
				`SELECT id, subject, assigned_to, updated_at
				 FROM tasks
				 WHERE lower(trim(subject)) = lower(?)
				 ORDER BY updated_at DESC
				 LIMIT 1`,
			)
			.get(normalized) as TaskReferenceRow | null;
		if (byExactSubject) {
			return byExactSubject;
		}

		if (/\s/.test(normalized) || normalized.length >= 16) {
			const byContains = database
				.query(
					`SELECT id, subject, assigned_to, updated_at
					 FROM tasks
					 WHERE lower(subject) LIKE ?
					 ORDER BY
					   CASE WHEN assigned_to = ? THEN 0 ELSE 1 END,
					   updated_at DESC
					 LIMIT 1`,
				)
				.get(`%${normalized.toLowerCase()}%`, ARM_ID) as TaskReferenceRow | null;
			if (byContains) {
				return byContains;
			}
		}
	} catch {
		// Best-effort lookup. Callers handle null and return user guidance.
	}

	return null;
}

/**
 * Find a bug by reference (ID, title, or partial match)
 */
export function findBugByReference(bugReference: string): BugReferenceRow | null {
	const normalized = normalizeReference(bugReference);
	if (!normalized) {
		return null;
	}

	try {
		const database = getDatabase();
		const byId = database
			.query(`SELECT id, title, updated_at FROM bugs WHERE id = ? LIMIT 1`)
			.get(normalized) as BugReferenceRow | null;
		if (byId) {
			return byId;
		}

		const byExactTitle = database
			.query(
				`SELECT id, title, updated_at
				 FROM bugs
				 WHERE lower(trim(title)) = lower(?)
				 ORDER BY updated_at DESC
				 LIMIT 1`,
			)
			.get(normalized) as BugReferenceRow | null;
		if (byExactTitle) {
			return byExactTitle;
		}

		if (/\s/.test(normalized) || normalized.length >= 16) {
			const byContains = database
				.query(
					`SELECT id, title, updated_at
					 FROM bugs
					 WHERE lower(title) LIKE ?
					 ORDER BY updated_at DESC
					 LIMIT 1`,
				)
				.get(`%${normalized.toLowerCase()}%`) as BugReferenceRow | null;
			if (byContains) {
				return byContains;
			}
		}
	} catch {
		// Best-effort lookup. Callers handle null and return user guidance.
	}

	return null;
}

/**
 * Get hint for task reference resolution
 */
export function getTaskReferenceHint(): string {
	try {
		const database = getDatabase();
		const rows = database
			.query(
					`SELECT id
					 FROM tasks
					 WHERE status IN ('pending', 'claimed', 'in_progress')
					 AND (assigned_to = ? OR assigned_to IS NULL OR assigned_to = '')
					 ORDER BY
					   CASE WHEN assigned_to = ? THEN 0 ELSE 1 END,
					   updated_at DESC
				 LIMIT 3`,
			)
			.all(ARM_ID, ARM_ID) as Array<{ id: string }>;

		if (rows.length === 0) {
			return "Use get_full_briefing to fetch your current task ID first.";
		}

		return `Use a valid task ID (examples: ${rows.map((row) => row.id).join(", ")}).`;
	} catch {
		return "Use get_full_briefing to fetch your current task ID first.";
	}
}

/**
 * Get hint for bug reference resolution
 */
export function getBugReferenceHint(): string {
	try {
		const database = getDatabase();
		const rows = database
			.query(
				`SELECT id
				 FROM bugs
				 WHERE status NOT IN ('resolved', 'closed')
				 ORDER BY updated_at DESC
				 LIMIT 3`,
			)
			.all() as Array<{ id: string }>;

		if (rows.length === 0) {
			return "Use report_bug to create a bug first if one does not exist.";
		}

		return `Use a valid bug ID (examples: ${rows.map((row) => row.id).join(", ")}).`;
	} catch {
		return "Use report_bug to create a bug first if one does not exist.";
	}
}

/**
 * Resolve a task reference for tool input
 */
export function resolveTaskReferenceForTool(
	taskReference: string,
): { taskId: string; note?: string } | { error: string } {
	const normalized = normalizeReference(taskReference);
	if (!normalized) {
		return { error: "task_id is required." };
	}

	const task = findTaskByReference(normalized);
	if (task) {
		const note =
			task.id !== normalized
				? `Resolved "${taskReference}" to task ID ${task.id}.`
				: undefined;
		return { taskId: task.id, note };
	}

	const bug = findBugByReference(normalized);
	if (bug) {
		return {
			error: `"${taskReference}" matches bug ${bug.id}. Use claim_bug or update_bug_status instead of task tools.`,
		};
	}

	return {
		error: `Task not found: ${taskReference}. ${getTaskReferenceHint()}`,
	};
}

/**
 * Resolve a bug reference for tool input
 */
export function resolveBugReferenceForTool(
	bugReference: string,
): { bugId: string; note?: string } | { error: string } {
	const normalized = normalizeReference(bugReference);
	if (!normalized) {
		return { error: "bug_id is required." };
	}

	const bug = findBugByReference(normalized);
	if (bug) {
		const note =
			bug.id !== normalized
				? `Resolved "${bugReference}" to bug ID ${bug.id}.`
				: undefined;
		return { bugId: bug.id, note };
	}

	const task = findTaskByReference(normalized);
	if (task) {
		return {
			error: `"${bugReference}" matches task ${task.id}. Use task tools (claim_task / complete_task / submit_status_report) instead.`,
		};
	}

	return {
		error: `Bug not found: ${bugReference}. ${getBugReferenceHint()}`,
	};
}

/**
 * Read shared notes (from SQLite with file fallback)
 */
export async function getSharedNotes(tags?: string[]): Promise<Note[]> {
	// Try SQLite first
	try {
		const database = getDatabase();
		const dbNotes = getNotes(database, { category: "shared" });

		// Filter by tags if provided
		if (tags && tags.length > 0) {
			return dbNotes
				.filter((n) => tags.some((t) => n.tags.includes(t)))
				.map((n) => ({
					id: n.id,
					author: n.author,
					title: n.title,
					content: n.content,
					tags: n.tags,
					createdAt: n.createdAt,
					updatedAt: n.updatedAt,
				}));
		}

		return dbNotes.map((n) => ({
			id: n.id,
			author: n.author,
			title: n.title,
			content: n.content,
			tags: n.tags,
			createdAt: n.createdAt,
			updatedAt: n.updatedAt,
		}));
	} catch {
		// Fall back to file-based notes
	}

	const notesDir = join(COLEO_DIR, "state", "notes", "shared");
	try {
		const files = await readdir(notesDir);
		const notes: Note[] = [];

		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			const content = await readFile(join(notesDir, file), "utf-8");
			const note: Note = JSON.parse(content);

			// Filter by tags if provided
			if (tags && tags.length > 0) {
				if (!tags.some((t) => note.tags.includes(t))) continue;
			}

			notes.push(note);
		}

		return notes;
	} catch {
		return [];
	}
}
