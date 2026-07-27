/**
 * Tasks routes
 *
 * CRUD operations for brain-managed tasks
 */
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { HttpError } from "../middleware";
import { broadcast } from "../websocket";
import { withTransaction } from "../../db/transactions";
import { eventStore } from "../../nats/jetstream";
import { generateKeyBetween } from "../../lib/fractional-indexing";
import { getServerWorkspaceAccess } from "../workspace-access";

interface ChecklistItem {
	id: number;
	taskId: string;
	text: string;
	completed: boolean;
	sortOrder: number;
	createdAt: string;
	updatedAt: string;
}

interface TasksContext {
	Variables: {
		db: Database;
	};
}

const TASK_STATUSES = [
	"pending",
	"claimed",
	"in_progress",
	"completing",
	"completed",
	"failed",
	"blocked",
	"cancelled",
] as const;

const BLOCKED_CATEGORIES = [
	"dependency",
	"bug",
	"file_claim",
	"environment",
	"human",
	"arm",
	"unknown",
] as const;

const BLOCKED_RECHECK_DELAY_MS = 15 * 60 * 1000;

type TaskStatus = (typeof TASK_STATUSES)[number];
export type BlockedTaskCategory = (typeof BLOCKED_CATEGORIES)[number];

function isTaskStatus(value: unknown): value is TaskStatus {
	return typeof value === "string" && TASK_STATUSES.includes(value as TaskStatus);
}

function isBlockedTaskCategory(value: unknown): value is BlockedTaskCategory {
	return (
		typeof value === "string" &&
		BLOCKED_CATEGORIES.includes(value as BlockedTaskCategory)
	);
}

function requireIsoDate(value: string, field: string): string {
	if (Number.isNaN(new Date(value).getTime())) {
		throw HttpError.badRequest(`${field} must be a valid date`);
	}
	return value;
}

export interface Task {
	id: string;
	subject: string;
	description: string;
	status: TaskStatus;
	priority: "critical" | "high" | "normal" | "low";
	sourceType: "manual" | "plan" | "email" | "discovery" | "proposal" | "system";
	sourceRef: string | null;
	phase: string | null;
	domain: string | null;
	classification: string | null;
	assignedTo: string | null;
	dependencyBlocked: boolean;
	assignedArmName?: string;
	consensusStatus?: "pending" | "in_progress" | "reached" | "failed";
	planLineUid?: string | null;
	sortOrder?: number | null;
	orderKey?: string | null;
	commentCount?: number;
	lastCommentAt?: string | null;
	mailThreadId?: string | null;
	progress?: number;
	createdAt: string;
	updatedAt: string;
	completedAt: string | null;
	blockedAt?: string | null;
	blockedReason?: string | null;
	blockedCategory?: BlockedTaskCategory | null;
	blockedRecheckAt?: string | null;
	blockedLastCheckedAt?: string | null;
	blockedReviewCount?: number;
	blockedNeedsHuman?: boolean;
	blockedHumanNotifiedAt?: string | null;
	blockedReviewArmId?: string | null;
	blockedReviewStartedAt?: string | null;
	claimedAt: string | null;
	startedAt: string | null;
	dueDate: string | null;
	artifacts: string[];
	context: Record<string, unknown>;
	metadata: Record<string, unknown>;
	checklist?: ChecklistItem[];
}

interface TaskRow {
	id: string;
	subject: string;
	description: string;
	status: string;
	priority: string;
	source_type: string;
	source_ref: string | null;
	phase: string | null;
	domain: string | null;
	classification: string | null;
	assigned_to: string | null;
	dependency_blocked: number | null;
	assigned_arm_name: string | null;
	consensus_status: string | null;
	plan_line_uid: string | undefined;
	sort_order: number | null;
	order_key: string | null;
	comment_count: number | null;
	last_comment_at: string | null;
	mail_thread_id: string | null;
	progress: number | null;
	created_at: string;
	updated_at: string;
	completed_at: string | null;
	claimed_at: string | null;
	started_at: string | null;
	blocked_at: string | null;
	blocked_reason: string | null;
	blocked_category: string | null;
	blocked_recheck_at: string | null;
	blocked_last_checked_at: string | null;
	blocked_review_count: number | null;
	blocked_needs_human: number | null;
	blocked_human_notified_at: string | null;
	blocked_review_arm_id: string | null;
	blocked_review_started_at: string | null;
	due_date: string | null;
	artifacts: string;
	context: string | null;
	metadata: string;
}

function parseTaskRow(row: TaskRow): Task {
	return {
		id: row.id,
		subject: row.subject,
		description: row.description,
		status: row.status as Task["status"],
		priority: row.priority as Task["priority"],
		sourceType: row.source_type as Task["sourceType"],
		sourceRef: row.source_ref,
		phase: row.phase,
		domain: row.domain,
		classification: row.classification,
		assignedTo: row.assigned_to,
		dependencyBlocked: row.dependency_blocked === 1,
		assignedArmName: row.assigned_arm_name || undefined,
		consensusStatus:
			(row.consensus_status as Task["consensusStatus"]) || undefined,
		planLineUid: row.plan_line_uid,
		sortOrder: row.sort_order,
		orderKey: row.order_key,
		commentCount: row.comment_count ?? 0,
		lastCommentAt: row.last_comment_at,
		mailThreadId: row.mail_thread_id,
		progress: row.progress ?? undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		completedAt: row.completed_at,
		blockedAt: row.blocked_at,
		blockedReason: row.blocked_reason,
		blockedCategory: row.blocked_category as BlockedTaskCategory | null,
		blockedRecheckAt: row.blocked_recheck_at,
		blockedLastCheckedAt: row.blocked_last_checked_at,
		blockedReviewCount: row.blocked_review_count ?? 0,
		blockedNeedsHuman: row.blocked_needs_human === 1,
		blockedHumanNotifiedAt: row.blocked_human_notified_at,
		blockedReviewArmId: row.blocked_review_arm_id,
		blockedReviewStartedAt: row.blocked_review_started_at,
		claimedAt: row.claimed_at,
		startedAt: row.started_at,
		dueDate: row.due_date,
		artifacts: JSON.parse(row.artifacts || "[]"),
		context: JSON.parse(row.context || "{}"),
		metadata: JSON.parse(row.metadata || "{}"),
	};
}

function getTaskRowById(db: Database, id: string): TaskRow | null {
	return db
		.query(`
      SELECT
        t.id, t.subject, t.description, t.status, t.priority,
        t.source_type, t.source_ref, t.phase, t.domain, t.classification,
        t.assigned_to, NULL as assigned_arm_name,
        t.dependency_blocked, t.consensus_status, t.plan_line_uid, t.sort_order, t.order_key,
        t.comment_count, t.last_comment_at,
        t.mail_thread_id, t.progress, t.created_at, t.updated_at, t.completed_at,
        t.claimed_at, t.started_at, t.blocked_at, t.blocked_reason, t.blocked_category,
        t.blocked_recheck_at, t.blocked_last_checked_at, t.blocked_review_count,
        t.blocked_needs_human, t.blocked_human_notified_at, t.blocked_review_arm_id,
        t.blocked_review_started_at, t.due_date,
        t.artifacts, t.context, t.metadata
      FROM tasks t
      WHERE t.id = ?
    `)
		.get(id) as TaskRow | null;
}

function taskTimestampMs(timestamp: string): number {
	const normalized = timestamp.includes("T") ? timestamp : `${timestamp.replace(" ", "T")}Z`;
	return new Date(normalized).getTime();
}

function getBurndownBucket(timestamp: string, bin: "hour" | "day" | "week" | "month", timeZone: string): string {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: bin === "hour" ? "2-digit" : undefined,
		hourCycle: "h23",
	}).formatToParts(new Date(taskTimestampMs(timestamp)));
	const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
	const date = `${values.year}-${values.month}-${values.day}`;
	if (bin === "hour") return `${date} ${values.hour}:00`;
	if (bin === "day") return date;
	if (bin === "month") return date.slice(0, 7);

	const start = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)));
	start.setUTCDate(start.getUTCDate() - start.getUTCDay());
	const end = new Date(start);
	end.setUTCDate(end.getUTCDate() + 6);
	return `${start.toISOString().slice(0, 10)}..${end.toISOString().slice(0, 10)}`;
}

function isTaskIdUniqueConstraintError(err: unknown): boolean {
	if (!(err instanceof Error)) {
		return false;
	}
	return /UNIQUE constraint failed:\s*tasks\.id/i.test(err.message);
}

/**
 * Log an activity entry to JetStream
 */
function logActivity(
	_db: Database,
	actor: string,
	action: string,
	target?: string,
	details?: Record<string, unknown>,
): void {
	if (eventStore.isInitialized()) {
		const subject = target
			? `coleo.events.task.${target}.${action}`
			: `coleo.events.api.${action}`;

		eventStore
			.publishEvent(subject, {
				type: action,
				armId: target,
				data: { actor, ...details },
				timestamp: new Date().toISOString(),
			})
			.catch((err) => {
				console.error(`[tasks-api] Failed to publish activity event: ${err}`);
			});
	}
}

const CONSENSUS_ROLES = new Set(["primary", "watcher"]);
const CONSENSUS_ENTRY_STATUSES = new Set([
	"pending",
	"working",
	"approved",
	"rejected",
	"watching",
]);
const CONSENSUS_APPROVALS = new Set(["approved", "rejected"]);

type ConsensusState = "pending" | "in_progress" | "reached" | "failed";

type ConsensusEntry = {
	armId: string;
	armName?: string;
	role: string;
	status: string;
	approval: string | null;
	approvalReason: string | null;
	lastReport: string | null;
	lastReportAt: string | null;
	updatedAt: string;
};

function fetchConsensusEntries(db: Database, taskId: string): ConsensusEntry[] {
	const rows = db
		.query(`
    SELECT c.arm_id, a.name as arm_name, c.role, c.status, c.approval, c.approval_reason,
           c.last_report, c.last_report_at, c.updated_at
    FROM task_arm_consensus c
    LEFT JOIN arms a ON c.arm_id = a.id
    WHERE c.task_id = ?
    ORDER BY c.updated_at DESC
  `)
		.all(taskId) as Array<{
		arm_id: string;
		arm_name: string | null;
		role: string;
		status: string;
		approval: string | null;
		approval_reason: string | null;
		last_report: string | null;
		last_report_at: string | null;
		updated_at: string;
	}>;

	return rows.map((row) => ({
		armId: row.arm_id,
		armName: row.arm_name || undefined,
		role: row.role,
		status: row.status,
		approval: row.approval,
		approvalReason: row.approval_reason,
		lastReport: row.last_report,
		lastReportAt: row.last_report_at,
		updatedAt: row.updated_at,
	}));
}

function determineConsensusStatus(entries: ConsensusEntry[]): ConsensusState {
	if (entries.length === 0) {
		return "pending";
	}

	if (
		entries.some(
			(entry) => entry.approval === "rejected" || entry.status === "rejected",
		)
	) {
		return "failed";
	}

	const allApproved = entries.every(
		(entry) => entry.approval === "approved" || entry.status === "approved",
	);
	if (allApproved) {
		return "reached";
	}

	return "in_progress";
}

export function createTasksRoutes() {
	const app = new Hono<TasksContext>();

	/**
	 * List all tasks
	 * GET /api/tasks
	 * Query params:
	 *   - status: filter by status (comma-separated for multiple)
	 *   - priority: filter by priority
	 *   - domain: filter by domain
	 *   - assignedTo: filter by assigned arm
	 *   - phase: filter by phase
	 *   - limit: max results (default 100)
	 *   - offset: pagination offset
	 */
	app.get("/", (c) => {
		const db = c.get("db");

		const statusFilter = c.req.query("status");
		const priorityFilter = c.req.query("priority");
		const domainFilter = c.req.query("domain");
		const assignedToFilter = c.req.query("assignedTo");
		const phaseFilter = c.req.query("phase");
		const limit = Math.min(parseInt(c.req.query("limit") || "100", 10), 500);
		const offset = parseInt(c.req.query("offset") || "0", 10);

		const conditions: string[] = [];
		const params: (string | number)[] = [];

		if (statusFilter) {
			const statuses = statusFilter.split(",").map((s) => s.trim());
			conditions.push(`t.status IN (${statuses.map(() => "?").join(",")})`);
			params.push(...statuses);
		}

		if (priorityFilter) {
			conditions.push("t.priority = ?");
			params.push(priorityFilter);
		}

		if (domainFilter) {
			conditions.push("t.domain = ?");
			params.push(domainFilter);
		}

		if (assignedToFilter) {
			conditions.push("t.assigned_to = ?");
			params.push(assignedToFilter);
		}

		if (phaseFilter) {
			conditions.push("t.phase = ?");
			params.push(phaseFilter);
		}

		const whereClause =
			conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

		// Get tasks with arm name via join
		const rows = db
			.query(`
      SELECT
        t.id, t.subject, t.description, t.status, t.priority,
        t.source_type, t.source_ref, t.phase, t.domain, t.classification,
        t.assigned_to, a.name as assigned_arm_name,
        t.dependency_blocked, t.consensus_status, t.plan_line_uid, t.sort_order, t.order_key,
        t.comment_count, t.last_comment_at,
        t.mail_thread_id, t.progress,
        t.created_at, t.updated_at, t.completed_at,
        t.claimed_at, t.started_at, t.blocked_at, t.blocked_reason, t.blocked_category,
        t.blocked_recheck_at, t.blocked_last_checked_at, t.blocked_review_count,
        t.blocked_needs_human, t.blocked_human_notified_at, t.blocked_review_arm_id,
        t.blocked_review_started_at, t.due_date,
        t.artifacts, t.context, t.metadata
      FROM tasks t
      LEFT JOIN arms a ON t.assigned_to = a.id
      ${whereClause}
      ORDER BY
        t.order_key ASC,
        CASE t.status
          WHEN 'in_progress' THEN 1
          WHEN 'completing' THEN 2
          WHEN 'claimed' THEN 3
          WHEN 'pending' THEN 4
          WHEN 'blocked' THEN 5
          WHEN 'completed' THEN 6
          WHEN 'failed' THEN 7
          WHEN 'cancelled' THEN 8
        END,
        CASE t.priority
          WHEN 'critical' THEN 1
          WHEN 'high' THEN 2
          WHEN 'normal' THEN 3
          WHEN 'low' THEN 4
        END,
        t.created_at DESC
      LIMIT ? OFFSET ?
    `)
			.all(...params, limit, offset) as TaskRow[];

		const tasks = rows.map(parseTaskRow);

		// Get total count
		const countRow = db
			.query(`
      SELECT COUNT(*) as count FROM tasks t ${whereClause}
    `)
			.get(...params) as { count: number };

		// Get counts by status
		const statusCounts = db
			.query(`
      SELECT status, COUNT(*) as count FROM tasks GROUP BY status
    `)
			.all() as Array<{ status: string; count: number }>;

		const counts = {
			total: countRow.count,
			byStatus: Object.fromEntries(
				statusCounts.map((r) => [r.status, r.count]),
			),
		};

		return c.json({
			tasks,
			pagination: {
				limit,
				offset,
				total: countRow.count,
			},
			counts,
		});
	});

	/**
	 * Get created and completed task counts grouped by a user-local time bucket.
	 * This must precede /:id so the generic task lookup cannot capture it.
	 */
	app.get("/burndown", (c) => {
		const db = c.get("db");
		const bin = c.req.query("bin") || "day";
		const timeZone = c.req.query("timeZone") || "UTC";
		const startValue = c.req.query("start");
		const endValue = c.req.query("end");
		if (!startValue || !endValue) {
			throw HttpError.badRequest("start and end are required and must be valid ISO timestamps");
		}
		if (!["hour", "day", "week", "month"].includes(bin)) {
			throw HttpError.badRequest(`Invalid bin: ${bin}`);
		}
		const typedBin = bin as "hour" | "day" | "week" | "month";
		const start = new Date(startValue);
		const end = new Date(endValue);

		try {
			new Intl.DateTimeFormat("en-CA", { timeZone }).format();
		} catch {
			throw HttpError.badRequest("timeZone must be a valid IANA timezone");
		}
		if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
			throw HttpError.badRequest("start and end must be valid dates with start before end");
		}
		const maxRangeMs = typedBin === "hour" ? 31 * 24 * 60 * 60 * 1000 : 366 * 24 * 60 * 60 * 1000;
		if (end.getTime() - start.getTime() > maxRangeMs) {
			throw HttpError.badRequest(`The selected ${typedBin} range is too large`);
		}

		const conditions: string[] = [
			"(julianday(t.created_at) >= julianday(?) AND julianday(t.created_at) < julianday(?) OR julianday(t.completed_at) >= julianday(?) AND julianday(t.completed_at) < julianday(?))",
		];
		const startIso = start.toISOString();
		const endIso = end.toISOString();
		const params: string[] = [startIso, endIso, startIso, endIso];
		const filters = [["status", "t.status"], ["priority", "t.priority"], ["domain", "t.domain"], ["assignedTo", "t.assigned_to"], ["phase", "t.phase"]] as const;
		for (const [queryName, column] of filters) {
			const value = c.req.query(queryName)?.trim();
			if (value) {
				const values = value.split(",").map((entry) => entry.trim()).filter(Boolean);
				conditions.push(`${column} IN (${values.map(() => "?").join(",")})`);
				params.push(...values);
			}
		}

		const rows = db.query(`SELECT created_at, completed_at FROM tasks t WHERE ${conditions.join(" AND ")}`).all(...params) as Array<{ created_at: string; completed_at: string | null }>;
		const counts = new Map<string, { created: number; completed: number }>();
		const increment = (timestamp: string, key: "created" | "completed") => {
			const bucket = getBurndownBucket(timestamp, typedBin, timeZone);
			const value = counts.get(bucket) ?? { created: 0, completed: 0 };
			value[key] += 1;
			counts.set(bucket, value);
		};
		for (const row of rows) {
			const createdAt = taskTimestampMs(row.created_at);
			if (createdAt >= start.getTime() && createdAt < end.getTime()) increment(row.created_at, "created");
			if (row.completed_at) {
				const completedAt = taskTimestampMs(row.completed_at);
				if (completedAt >= start.getTime() && completedAt < end.getTime()) increment(row.completed_at, "completed");
			}
		}
		let cumulativeCreated = 0;
		let cumulativeCompleted = 0;
		const buckets = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([bucket, value]) => {
			cumulativeCreated += value.created;
			cumulativeCompleted += value.completed;
			return { bucket, ...value, cumulativeCreated, cumulativeCompleted };
		});
		return c.json({ bin: typedBin, timeZone, start: startIso, end: endIso, buckets });
	});

	/**
	 * Get a single task
	 * GET /api/tasks/:id
	 * Query params:
	 *   - include: comma-separated list of additional data (discussions)
	 */
	app.get("/:id", (c) => {
		const db = c.get("db");
		const id = c.req.param("id");
		const include = c.req.query("include") || "";
		const includeDiscussions = include.split(",").includes("discussions");
		const includeChecklist = include.split(",").includes("checklist");

		const row = db
			.query(`
      SELECT
        t.id, t.subject, t.description, t.status, t.priority,
        t.source_type, t.source_ref, t.phase, t.domain, t.classification,
        t.assigned_to, a.name as assigned_arm_name,
        t.dependency_blocked, t.consensus_status, t.plan_line_uid, t.sort_order, t.order_key,
        t.comment_count, t.last_comment_at,
        t.mail_thread_id, t.progress,
        t.created_at, t.updated_at, t.completed_at,
        t.claimed_at, t.started_at, t.blocked_at, t.blocked_reason, t.blocked_category,
        t.blocked_recheck_at, t.blocked_last_checked_at, t.blocked_review_count,
        t.blocked_needs_human, t.blocked_human_notified_at, t.blocked_review_arm_id,
        t.blocked_review_started_at, t.due_date,
        t.artifacts, t.context, t.metadata
      FROM tasks t
      LEFT JOIN arms a ON t.assigned_to = a.id
      WHERE t.id = ?
    `)
			.get(id) as TaskRow | null;

		if (!row) {
			throw HttpError.notFound(`Task not found: ${id}`);
		}

		// Get dependencies
		const deps = db
			.query(`
      SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?
    `)
			.all(id) as Array<{ depends_on_task_id: string }>;

		const task = parseTaskRow(row);

		const response: Record<string, unknown> = {
			task,
			dependencies: deps.map((d) => d.depends_on_task_id),
		};

		// Include checklist if requested
		if (includeChecklist) {
			const checklistRows = db
				.query(
					"SELECT id, task_id, text, completed, sort_order, created_at, updated_at FROM task_checklist_items WHERE task_id = ? ORDER BY sort_order, created_at",
				)
				.all(id) as Array<{
					id: number;
					task_id: string;
					text: string;
					completed: number;
					sort_order: number;
					created_at: string;
					updated_at: string;
				}>;

			task.checklist = checklistRows.map((row) => ({
				id: row.id,
				taskId: row.task_id,
				text: row.text,
				completed: row.completed === 1,
				sortOrder: row.sort_order,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
			}));
		}

		// Include discussions if requested
		if (includeDiscussions) {
			const commentRows = db
				.query(`
        SELECT * FROM task_comments
        WHERE task_id = ? AND deleted = 0
        ORDER BY created_at DESC
      `)
				.all(id) as Array<{
				id: string;
				task_id: string;
				parent_id: string | null;
				content: string;
				author_type: "human" | "arm" | "brain";
				author_id: string;
				author_name: string | null;
				client: "web" | "mail" | "mcp" | "cli";
				edited: number;
				deleted: number;
				created_at: string;
				updated_at: string;
			}>;

			response.discussions = commentRows.map((row) => ({
				id: row.id,
				taskId: row.task_id,
				parentId: row.parent_id || undefined,
				content: row.content,
				authorType: row.author_type,
				authorId: row.author_id,
				authorName: row.author_name || undefined,
				client: row.client,
				edited: row.edited === 1,
				deleted: row.deleted === 1,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
			}));
		}

		return c.json(response);
	});

	/**
	 * List task dependencies with metadata
	 * GET /api/tasks/:id/dependencies
	 */
	app.get("/:id/dependencies", (c) => {
		const db = c.get("db");
		const id = c.req.param("id");

		const task = db.query("SELECT id FROM tasks WHERE id = ?").get(id) as {
			id: string;
		} | null;
		if (!task) {
			throw HttpError.notFound(`Task not found: ${id}`);
		}

		const rows = db
			.query(
				`SELECT task_id, depends_on_task_id, dependency_type, auto_detected, reason
         FROM task_dependencies
         WHERE task_id = ?
         ORDER BY created_at ASC`,
			)
			.all(id) as Array<{
			task_id: string;
			depends_on_task_id: string;
			dependency_type:
				| "finish_to_start"
				| "start_to_start"
				| "finish_to_finish"
				| "start_to_finish";
			auto_detected: number;
			reason: string | null;
		}>;

		return c.json({
			dependencies: rows.map((row) => ({
				taskId: row.task_id,
				dependsOnTaskId: row.depends_on_task_id,
				dependencyType: row.dependency_type,
				autoDetected: row.auto_detected === 1,
				reason: row.reason,
			})),
		});
	});

	/**
	 * Upsert a dependency between two tasks
	 * PUT /api/tasks/:id/dependencies/:dependsOnTaskId
	 */
	app.put("/:id/dependencies/:dependsOnTaskId", async (c) => {
		const db = c.get("db");
		const id = c.req.param("id");
		const dependsOnTaskId = c.req.param("dependsOnTaskId");
		const body = await c.req.json<{
			dependencyType?:
				| "finish_to_start"
				| "start_to_start"
				| "finish_to_finish"
				| "start_to_finish";
			autoDetected?: boolean;
			reason?: string | null;
		}>();

		if (!id || !dependsOnTaskId) {
			throw HttpError.badRequest("id and dependsOnTaskId are required");
		}

		const dependencyType = body.dependencyType || "finish_to_start";
		const validDependencyTypes = new Set([
			"finish_to_start",
			"start_to_start",
			"finish_to_finish",
			"start_to_finish",
		]);
		if (!validDependencyTypes.has(dependencyType)) {
			throw HttpError.badRequest("Invalid dependencyType");
		}

		const task = db.query("SELECT id FROM tasks WHERE id = ?").get(id) as {
			id: string;
		} | null;
		if (!task) {
			throw HttpError.notFound(`Task not found: ${id}`);
		}

		const dependsOnTask = db
			.query("SELECT id FROM tasks WHERE id = ?")
			.get(dependsOnTaskId) as { id: string } | null;
		if (!dependsOnTask) {
			throw HttpError.notFound(`Task not found: ${dependsOnTaskId}`);
		}

		const now = new Date().toISOString();
		db.run(
			`INSERT INTO task_dependencies (task_id, depends_on_task_id, dependency_type, auto_detected, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, depends_on_task_id) DO UPDATE SET
         dependency_type = excluded.dependency_type,
         auto_detected = excluded.auto_detected,
         reason = excluded.reason`,
			[
				id,
				dependsOnTaskId,
				dependencyType,
				body.autoDetected === false ? 0 : 1,
				body.reason || null,
				now,
			],
		);

		const row = db
			.query(
				`SELECT task_id, depends_on_task_id, dependency_type, auto_detected, reason
         FROM task_dependencies
         WHERE task_id = ? AND depends_on_task_id = ?`,
			)
			.get(id, dependsOnTaskId) as {
			task_id: string;
			depends_on_task_id: string;
			dependency_type:
				| "finish_to_start"
				| "start_to_start"
				| "finish_to_finish"
				| "start_to_finish";
			auto_detected: number;
			reason: string | null;
		};

		return c.json({
			dependency: {
				taskId: row.task_id,
				dependsOnTaskId: row.depends_on_task_id,
				dependencyType: row.dependency_type,
				autoDetected: row.auto_detected === 1,
				reason: row.reason,
			},
		});
	});

	/**
	 * Create a new task
	 * POST /api/tasks
	 */
	app.post("/", async (c) => {
		const db = c.get("db");
		const body = await c.req.json<{
			id?: string;
			subject: string;
			description: string;
			status?: Task["status"];
			priority?: Task["priority"];
			domain?: string;
			classification?: string;
			phase?: string;
			sourceType?: Task["sourceType"];
			sourceRef?: string;
			mailThreadId?: string;
			context?: Record<string, unknown>;
			sortOrder?: number;
			dueDate?: string;
			progress?: number;
			metadata?: Record<string, unknown>;
			blockedReason?: string;
			blockedCategory?: BlockedTaskCategory;
			blockedNeedsHuman?: boolean;
			blockedRecheckAt?: string;
		}>();

		if (!body.subject?.trim()) {
			throw HttpError.badRequest("subject is required");
		}

		if (!body.description?.trim()) {
			throw HttpError.badRequest("description is required");
		}
		if (body.status !== undefined && !isTaskStatus(body.status)) {
			throw HttpError.badRequest(`status must be one of: ${TASK_STATUSES.join(", ")}`);
		}
		if (
			body.blockedCategory !== undefined &&
			!isBlockedTaskCategory(body.blockedCategory)
		) {
			throw HttpError.badRequest(
				`blockedCategory must be one of: ${BLOCKED_CATEGORIES.join(", ")}`,
			);
		}

		const initialStatus = body.status || "pending";
		const blockedReason = body.blockedReason?.trim() || null;
		if (initialStatus === "blocked" && !blockedReason) {
			throw HttpError.badRequest("blockedReason is required when status is blocked");
		}
		if (initialStatus !== "blocked" && body.blockedReason !== undefined) {
			throw HttpError.badRequest("blockedReason can only be set on a blocked task");
		}

		const providedId = body.id?.trim();
		const normalizedSubject = body.subject.trim();
		const normalizedDescription = body.description.trim();
		const normalizedProgress = Math.min(Math.max(body.progress ?? 0, 0), 100);
		const insertTask = (taskId: string): void => {
			const now = new Date().toISOString();
			const blockedAt = initialStatus === "blocked" ? now : null;
			const completedAt = ["completed", "failed", "cancelled"].includes(initialStatus)
				? now
				: null;
			const blockedRecheckAt =
				initialStatus === "blocked"
					? body.blockedRecheckAt
						? requireIsoDate(body.blockedRecheckAt, "blockedRecheckAt")
						: new Date(Date.now() + BLOCKED_RECHECK_DELAY_MS).toISOString()
					: null;
			const transaction = db.transaction(() => {
				// Get the max order_key to place new task at the end
				// Using fractional indexing, we generate a key after the current max
				const maxOrderKeyRow = db
					.query("SELECT MAX(order_key) as max_key FROM tasks WHERE order_key IS NOT NULL")
					.get() as { max_key: string | null };
				const maxOrderKey = maxOrderKeyRow?.max_key ?? null;

				// Generate new order_key after the current max
				// If no tasks exist, start with "a"
				const newOrderKey = generateKeyBetween(maxOrderKey, null);

				db.run(
					`
	          INSERT INTO tasks (
	            id, subject, description, status, priority, source_type, source_ref,
	            phase, domain, classification, mail_thread_id, context, due_date,
	            order_key, progress, metadata, created_at, updated_at, completed_at,
	            blocked_at, blocked_reason, blocked_category, blocked_recheck_at,
	            blocked_needs_human
	          )
	          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	        `,
					[
						taskId,
						normalizedSubject,
						normalizedDescription,
						initialStatus,
						body.priority || "normal",
						body.sourceType || "manual",
						body.sourceRef || null,
						body.phase || null,
						body.domain || null,
						body.classification || null,
						body.mailThreadId || null,
						JSON.stringify(body.context || {}),
						body.dueDate || null,
						newOrderKey,
						normalizedProgress,
						JSON.stringify(body.metadata || {}),
						now,
						now,
						completedAt,
						blockedAt,
						blockedReason,
						initialStatus === "blocked" ? body.blockedCategory || "unknown" : null,
						blockedRecheckAt,
						initialStatus === "blocked" && body.blockedNeedsHuman ? 1 : 0,
					],
				);
			});

			transaction();
		};

		const generateSequentialTaskId = (): string => {
			const maxIdResult = db
				.query(
					"SELECT MAX(CAST(SUBSTR(id, 6) AS INTEGER)) as max_num FROM tasks WHERE id LIKE 'task-%'",
				)
				.get() as { max_num: number | null };
			const nextNum = (maxIdResult?.max_num ?? 0) + 1;
			return `task-${nextNum}`;
		};

		let id = providedId || generateSequentialTaskId();
		if (providedId) {
			try {
				insertTask(id);
			} catch (err) {
				if (isTaskIdUniqueConstraintError(err)) {
					const existingRow = getTaskRowById(db, id);
					if (!existingRow) {
						throw HttpError.internal(
							`Task ${id} already exists but could not be retrieved`,
						);
					}
					return c.json({ task: parseTaskRow(existingRow) });
				}
				throw err;
			}
		} else {
			const maxAttempts = 5;
			let inserted = false;
			let lastError: unknown;

			for (let attempt = 0; attempt < maxAttempts; attempt++) {
				try {
					insertTask(id);
					inserted = true;
					break;
				} catch (err) {
					if (isTaskIdUniqueConstraintError(err)) {
						id = generateSequentialTaskId();
						lastError = err;
						continue;
					}
					throw err;
				}
			}

			if (!inserted) {
				throw HttpError.internal(
					`Failed to create task after ${maxAttempts} attempts: ${
						lastError instanceof Error ? lastError.message : "ID collision"
					}`,
				);
			}
		}

		logActivity(db, "api", "task_created", id, {
			subject: body.subject,
			priority: body.priority,
			domain: body.domain,
		});

		// Broadcast task created
		broadcast("tasks", "task.created", { taskId: id, subject: body.subject });

		const row = getTaskRowById(db, id);
		if (!row) {
			throw HttpError.internal(`Failed to load task after creation: ${id}`);
		}

		return c.json({ task: parseTaskRow(row) }, 201);
	});

	/**
	 * Update a task
	 * PATCH /api/tasks/:id
	 */
	app.patch("/:id", async (c) => {
		const db = c.get("db");
		const id = c.req.param("id");
		const body = await c.req.json<{
			subject?: string;
			description?: string;
			status?: Task["status"];
			priority?: Task["priority"];
			domain?: string;
			classification?: string | null;
			phase?: string;
			assignedTo?: string | null;
			dependencyBlocked?: boolean;
			mailThreadId?: string | null;
			context?: Record<string, unknown>;
			orderKey?: string | null;
			dueDate?: string | null;
			progress?: number;
			artifacts?: string[];
			metadata?: Record<string, unknown>;
			blockedReason?: string;
			blockedCategory?: BlockedTaskCategory;
			blockedRecheckAt?: string | null;
			blockedLastCheckedAt?: string | null;
			blockedReviewCount?: number;
			blockedNeedsHuman?: boolean;
			blockedHumanNotifiedAt?: string | null;
			blockedReviewArmId?: string | null;
			blockedReviewStartedAt?: string | null;
		}>();

		// Check task exists
		const existing = db
			.query(
				`SELECT id, subject, status, domain, assigned_to, source_type, source_ref, plan_line_uid,
				        blocked_reason, blocked_category,
				        blocked_at, blocked_recheck_at, blocked_review_count
				 FROM tasks WHERE id = ?`,
			)
			.get(id) as {
				id: string;
				subject: string;
				status: TaskStatus;
				domain: string | null;
				assigned_to: string | null;
				source_type: string | null;
				source_ref: string | null;
				plan_line_uid: string | null;
				blocked_reason: string | null;
				blocked_category: string | null;
				blocked_at: string | null;
				blocked_recheck_at: string | null;
				blocked_review_count: number | null;
			} | null;
		if (!existing) {
			throw HttpError.notFound(`Task not found: ${id}`);
		}
		if (body.status !== undefined && !isTaskStatus(body.status)) {
			throw HttpError.badRequest(`status must be one of: ${TASK_STATUSES.join(", ")}`);
		}
		if (
			body.blockedCategory !== undefined &&
			!isBlockedTaskCategory(body.blockedCategory)
		) {
			throw HttpError.badRequest(
				`blockedCategory must be one of: ${BLOCKED_CATEGORIES.join(", ")}`,
			);
		}
		if (
			body.blockedReviewCount !== undefined &&
			(!Number.isInteger(body.blockedReviewCount) || body.blockedReviewCount < 0)
		) {
			throw HttpError.badRequest("blockedReviewCount must be a non-negative integer");
		}

		const updates: string[] = [];
		const values: unknown[] = [];
		const now = new Date().toISOString();
		const targetStatus = body.status ?? existing.status;
		const blockedFieldsProvided = [
			body.blockedReason,
			body.blockedCategory,
			body.blockedRecheckAt,
			body.blockedLastCheckedAt,
			body.blockedReviewCount,
			body.blockedNeedsHuman,
			body.blockedHumanNotifiedAt,
			body.blockedReviewArmId,
			body.blockedReviewStartedAt,
		].some((value) => value !== undefined);
		if (blockedFieldsProvided && targetStatus !== "blocked") {
			throw HttpError.badRequest("blocked task fields can only be set while status is blocked");
		}

		const releaseAssignment =
			body.status !== undefined &&
			["pending", "blocked", "completed", "failed", "cancelled"].includes(body.status) &&
			body.assignedTo == null;

		if (body.subject !== undefined) {
			updates.push("subject = ?");
			values.push(body.subject);
		}

		if (body.description !== undefined) {
			updates.push("description = ?");
			values.push(body.description);
		}

		if (body.status !== undefined) {
			updates.push("status = ?");
			values.push(body.status);

			// Set lifecycle timestamps based on status transitions.
			if (body.status === "claimed" && existing.status === "pending") {
				updates.push("claimed_at = ?");
				values.push(now);
			} else if (
				body.status === "in_progress" &&
				existing.status !== "in_progress"
			) {
				updates.push("started_at = ?");
				values.push(now);
			} else if (
				body.status === "completed" ||
				body.status === "failed" ||
				body.status === "cancelled"
			) {
				updates.push("completed_at = ?");
				values.push(now);
			} else if (["completed", "failed", "cancelled"].includes(existing.status)) {
				updates.push("completed_at = NULL");
			}

			if (existing.status === "blocked" && body.status !== "blocked") {
				updates.push(
					"blocked_at = NULL",
					"blocked_reason = NULL",
					"blocked_category = NULL",
					"blocked_recheck_at = NULL",
					"blocked_last_checked_at = NULL",
					"blocked_review_count = 0",
					"blocked_needs_human = 0",
					"blocked_human_notified_at = NULL",
					"blocked_review_arm_id = NULL",
					"blocked_review_started_at = NULL",
				);
			}

			if (body.status === "pending" && body.dependencyBlocked === undefined) {
				updates.push("dependency_blocked = 0");
			}
		}

		if (targetStatus === "blocked" && (body.status !== undefined || blockedFieldsProvided)) {
			const blockedReason = body.blockedReason?.trim() || existing.blocked_reason?.trim();
			if (!blockedReason) {
				throw HttpError.badRequest("blockedReason is required when status is blocked");
			}

			updates.push("blocked_reason = ?");
			values.push(blockedReason);

			if (existing.status !== "blocked") {
				updates.push("blocked_at = ?", "blocked_last_checked_at = NULL");
				values.push(now);
			}

			updates.push("blocked_category = ?");
			values.push(
				body.blockedCategory ||
					(isBlockedTaskCategory(existing.blocked_category)
						? existing.blocked_category
						: "unknown"),
			);

			const recheckAt = body.blockedRecheckAt
				? requireIsoDate(body.blockedRecheckAt, "blockedRecheckAt")
				: body.blockedRecheckAt === null
					? new Date(Date.now() + BLOCKED_RECHECK_DELAY_MS).toISOString()
					: existing.status === "blocked" && existing.blocked_recheck_at
						? existing.blocked_recheck_at
						: new Date(Date.now() + BLOCKED_RECHECK_DELAY_MS).toISOString();
			updates.push("blocked_recheck_at = ?");
			values.push(recheckAt);

			if (body.blockedLastCheckedAt !== undefined) {
				updates.push("blocked_last_checked_at = ?");
				values.push(
					body.blockedLastCheckedAt
						? requireIsoDate(body.blockedLastCheckedAt, "blockedLastCheckedAt")
						: null,
				);
			}
			if (body.blockedReviewCount !== undefined || existing.status !== "blocked") {
				updates.push("blocked_review_count = ?");
				values.push(body.blockedReviewCount ?? 0);
			}
			if (body.blockedNeedsHuman !== undefined || existing.status !== "blocked") {
				updates.push("blocked_needs_human = ?");
				values.push(body.blockedNeedsHuman ? 1 : 0);
			}
			if (body.blockedHumanNotifiedAt !== undefined) {
				updates.push("blocked_human_notified_at = ?");
				values.push(
					body.blockedHumanNotifiedAt
						? requireIsoDate(body.blockedHumanNotifiedAt, "blockedHumanNotifiedAt")
						: null,
				);
			}
			if (body.blockedReviewArmId !== undefined || existing.status !== "blocked") {
				updates.push("blocked_review_arm_id = ?");
				values.push(body.blockedReviewArmId ?? null);
			}
			if (body.blockedReviewStartedAt !== undefined || existing.status !== "blocked") {
				updates.push("blocked_review_started_at = ?");
				values.push(
					body.blockedReviewStartedAt
						? requireIsoDate(body.blockedReviewStartedAt, "blockedReviewStartedAt")
						: null,
				);
			}
		}

		if (body.priority !== undefined) {
			updates.push("priority = ?");
			values.push(body.priority);
		}

		if (body.domain !== undefined) {
			updates.push("domain = ?");
			values.push(body.domain);
		}

		if (body.classification !== undefined) {
			updates.push("classification = ?");
			values.push(body.classification);
		}

		if (body.phase !== undefined) {
			updates.push("phase = ?");
			values.push(body.phase);
		}

		if (releaseAssignment) {
			updates.push("assigned_to = NULL");
		} else if (body.assignedTo !== undefined) {
			updates.push("assigned_to = ?");
			values.push(body.assignedTo);
		}

		if (body.dependencyBlocked !== undefined) {
			updates.push("dependency_blocked = ?");
			values.push(body.dependencyBlocked ? 1 : 0);
		}

		if (body.mailThreadId !== undefined) {
			updates.push("mail_thread_id = ?");
			values.push(body.mailThreadId);
		}

		if (body.context !== undefined) {
			updates.push("context = ?");
			values.push(JSON.stringify(body.context));
		}

		if (body.orderKey !== undefined) {
			updates.push("order_key = ?");
			values.push(body.orderKey);
		}

		if (body.dueDate !== undefined) {
			updates.push("due_date = ?");
			values.push(body.dueDate);
		}

		if (body.progress !== undefined) {
			updates.push("progress = ?");
			values.push(Math.min(Math.max(body.progress, 0), 100));
		}

		if (body.artifacts !== undefined) {
			updates.push("artifacts = ?");
			values.push(JSON.stringify(body.artifacts));
		}

		if (body.metadata !== undefined) {
			updates.push("metadata = ?");
			values.push(JSON.stringify(body.metadata));
		}

		if (updates.length === 0) {
			throw HttpError.badRequest("No fields to update");
		}

		updates.push("updated_at = ?");
		values.push(now);
		values.push(id);

		db.run(
			`UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`,
			values as (string | number | null)[],
		);

		let planStatusSynced: boolean | null = null;
		const planStatus = body.status === "pending" || body.status === "completed" || body.status === "cancelled"
			? body.status
			: null;
		if (
			planStatus &&
			existing.source_type === "plan" &&
			existing.source_ref
		) {
			const sourceRefMatch = existing.source_ref.match(/^(.+):\d+$/);
			if (sourceRefMatch?.[1]) {
				try {
					const { updateTaskLineStatusInPlan } = await import("../../brain/plan-parser");
					planStatusSynced = await updateTaskLineStatusInPlan(
						sourceRefMatch[1],
						{
							taskId: existing.id,
							subject: existing.subject,
							planLineUid: existing.plan_line_uid,
						},
						planStatus,
						getServerWorkspaceAccess(),
					);
				} catch (err) {
					console.error(`Failed to synchronize task ${id} status to its plan:`, err);
					planStatusSynced = false;
				}
			}
		}

		if (releaseAssignment && existing.assigned_to) {
			db.run(
				`UPDATE arms
				 SET current_task_id = NULL,
				     current_task_subject = NULL,
				     status = CASE WHEN status IN ('busy', 'running') THEN 'idle' ELSE status END,
				     updated_at = ?
				 WHERE id = ? AND current_task_id = ?`,
				[now, existing.assigned_to, id],
			);
			try {
				db.run(
					`UPDATE arm_state_machine
					 SET current_task_id = NULL,
					     current_task_subject = NULL,
					     state = CASE
					       WHEN state IN ('task_assigned', 'working', 'completing', 'disconnected') THEN 'idle'
					       ELSE state
					     END
					 WHERE arm_id = ? AND current_task_id = ?`,
					[existing.assigned_to, id],
				);
			} catch {
				// Minimal and legacy schemas may not include the state-machine projection.
			}
		}

		logActivity(db, "api", "task_updated", id, {
			...body,
			...(planStatusSynced === null ? {} : { planStatusSynced }),
		});

		// Broadcast task updated
		broadcast("tasks", "task.updated", { taskId: id, changes: body });

		// Fetch updated task
		const row = db
			.query(`
      SELECT
        t.id, t.subject, t.description, t.status, t.priority,
        t.source_type, t.source_ref, t.phase, t.domain, t.classification,
        t.assigned_to, a.name as assigned_arm_name,
        t.dependency_blocked, t.consensus_status, t.plan_line_uid, t.sort_order, t.order_key,
        t.comment_count, t.last_comment_at,
        t.mail_thread_id, t.progress,
        t.created_at, t.updated_at, t.completed_at,
        t.claimed_at, t.started_at, t.blocked_at, t.blocked_reason, t.blocked_category,
        t.blocked_recheck_at, t.blocked_last_checked_at, t.blocked_review_count,
        t.blocked_needs_human, t.blocked_human_notified_at, t.blocked_review_arm_id,
        t.blocked_review_started_at, t.due_date,
        t.artifacts, t.context, t.metadata
      FROM tasks t
      LEFT JOIN arms a ON t.assigned_to = a.id
      WHERE t.id = ?
    `)
			.get(id) as TaskRow;

		// Mirror key task status changes into task + arm event streams
		if (
			body.status &&
			body.status !== existing.status &&
			eventStore.isInitialized()
		) {
			const statusToEventType: Record<Task["status"], string | undefined> = {
				pending: undefined,
				claimed: "task.claimed",
				in_progress: undefined,
				completing: undefined,
				completed: "task.completed",
				failed: "task.failed",
				blocked: "task.blocked",
				cancelled: undefined,
			};
			const eventType = statusToEventType[body.status];
			if (eventType) {
				const timestamp = new Date().toISOString();
				const data = {
					actor: "api",
					taskId: id,
					status: body.status,
					previousStatus: existing.status,
					reason: body.status === "blocked" ? row.blocked_reason : undefined,
					category: body.status === "blocked" ? row.blocked_category : undefined,
				};

				eventStore
					.publishEvent(`coleo.events.task.${id}.${eventType}`, {
						type: eventType,
						armId: row.assigned_to || existing.assigned_to || undefined,
						data,
						timestamp,
					})
					.catch(() => {
						// Best-effort
					});

				const eventArmId = row.assigned_to || existing.assigned_to;
				if (eventArmId) {
					eventStore
						.publishEvent(`coleo.events.arm.${eventArmId}.${eventType}`, {
							type: eventType,
							armId: eventArmId,
							data,
							timestamp,
						})
						.catch(() => {
							// Best-effort
						});
				}
			}
		}

		return c.json({ task: parseTaskRow(row) });
	});

	app.get("/:id/consensus", (c) => {
		const db = c.get("db");
		const id = c.req.param("id");

		const task = db
			.query("SELECT consensus_status FROM tasks WHERE id = ?")
			.get(id) as { consensus_status: string | null } | null;
		if (!task) {
			throw HttpError.notFound(`Task not found: ${id}`);
		}

		const entries = fetchConsensusEntries(db, id);
		const consensusStatus = determineConsensusStatus(entries);

		return c.json({
			taskId: id,
			consensusStatus,
			entries,
		});
	});

	app.post("/:id/consensus", async (c) => {
		const db = c.get("db");
		const id = c.req.param("id");
		const body = await c.req.json<{
			armId: string;
			role?: "primary" | "watcher";
			status: "pending" | "working" | "approved" | "rejected" | "watching";
			approval?: "approved" | "rejected";
			approvalReason?: string | null;
			report?: string | null;
		}>();

		const task = db
			.query("SELECT consensus_status FROM tasks WHERE id = ?")
			.get(id) as { consensus_status: string | null } | null;
		if (!task) {
			throw HttpError.notFound(`Task not found: ${id}`);
		}

		const armId = body.armId?.trim();
		if (!armId) {
			throw HttpError.badRequest("armId is required");
		}

		if (!body.status || !CONSENSUS_ENTRY_STATUSES.has(body.status)) {
			throw HttpError.badRequest(
				"status is required and must be a valid consensus status",
			);
		}

		if (body.role && !CONSENSUS_ROLES.has(body.role)) {
			throw HttpError.badRequest("role must be 'primary' or 'watcher'");
		}

		if (body.approval && !CONSENSUS_APPROVALS.has(body.approval)) {
			throw HttpError.badRequest("approval must be 'approved' or 'rejected'");
		}

		// Wrap consensus update in transaction for atomicity
		const result = await withTransaction(db, async (db) => {
			const arm = db.query("SELECT id FROM arms WHERE id = ?").get(armId) as {
				id: string;
			} | null;
			if (!arm) {
				throw HttpError.badRequest(`Arm not found: ${armId}`);
			}

			const now = new Date().toISOString();
			const existing = db
				.query(
					"SELECT id, role FROM task_arm_consensus WHERE task_id = ? AND arm_id = ?",
				)
				.get(id, armId) as { id: number; role: string } | null;
			const role = body.role || existing?.role || "watcher";
			const approval = body.approval || null;
			const approvalReason = body.approvalReason?.trim() || null;
			const hasReportField = Object.hasOwn(body, "report");
			const reportValue = body.report ?? null;
			const reportTimestamp = reportValue ? now : null;
			if (
				hasReportField &&
				reportValue !== null &&
				typeof reportValue !== "string"
			) {
				throw HttpError.badRequest("report must be a string");
			}
			if (existing) {
				const params: (string | number | null)[] = hasReportField
					? [
							role,
							body.status,
							approval,
							approvalReason,
							reportValue,
							reportTimestamp,
							now,
							existing.id,
						]
					: [role, body.status, approval, approvalReason, now, existing.id];

				db.run(
					`UPDATE task_arm_consensus
            SET role = ?, status = ?, approval = ?, approval_reason = ?,
                ${hasReportField ? "last_report = ?, last_report_at = ?," : ""}
                updated_at = ?
            WHERE id = ?`,
					params,
				);
			} else {
				db.run(
					`INSERT INTO task_arm_consensus (task_id, arm_id, role, status, approval, approval_reason, last_report, last_report_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						id,
						armId,
						role,
						body.status,
						approval,
						approvalReason,
						reportValue,
						reportTimestamp,
						now,
						now,
					],
				);
			}

			const entries = fetchConsensusEntries(db, id);
			const consensusStatus = determineConsensusStatus(entries);
			const currentStatus = task.consensus_status || "pending";

			if (consensusStatus !== currentStatus) {
				db.run(
					`UPDATE tasks SET consensus_status = ?, updated_at = ? WHERE id = ?`,
					[consensusStatus, now, id],
				);
			}

			logActivity(db, `arm:${armId}`, "task_consensus_update", id, {
				role,
				status: body.status,
				approval,
			});

			return { consensusStatus, entries };
		});

		if (!result.success) {
			throw HttpError.internal(`Failed to update consensus: ${result.error}`);
		}

		const { consensusStatus, entries } = result.data!;
		broadcast("tasks", "task.consensus", { taskId: id, consensusStatus });

		return c.json({
			taskId: id,
			consensusStatus,
			entries,
		});
	});

	/**
	 * Delete a task and remove from project plan
	 * DELETE /api/tasks/:id
	 */
	app.delete("/:id", async (c) => {
		const db = c.get("db");
		const id = c.req.param("id");

		// Get the task to find its plan_line_uid before deleting
		const taskRow = db
			.query("SELECT id, subject, source_ref, plan_line_uid FROM tasks WHERE id = ?")
			.get(id) as TaskRow | undefined;

		if (!taskRow) {
			throw HttpError.notFound(`Task not found: ${id}`);
		}

		// Remove from plan.md if the task has a plan_line_uid
		const planLineUidValue = taskRow.plan_line_uid;
		let removedFromPlan = false;
		if (typeof planLineUidValue === "string" && taskRow.source_ref) {
			// Extract file path from source_ref (format: "/path/to/file:lineNumber")
			const sourceRefMatch = taskRow.source_ref.match(/^(.+):\d+$/);
			if (sourceRefMatch?.[1]) {
				const planFilePath = sourceRefMatch[1];
				try {
					const mod = await import("../../brain/plan-parser");
					removedFromPlan = await mod.removeTaskLineFromPlan(
						planFilePath,
						planLineUidValue,
						getServerWorkspaceAccess(),
					);
				} catch (err) {
					console.error(`Failed to remove line from plan file: ${err}`);
					// Continue with deletion even if plan file removal fails
				}
			}
		}

		// Delete the task from database
		const result = db.run("DELETE FROM tasks WHERE id = ?", [id]);
		if (result.changes === 0) {
			throw HttpError.notFound(`Task not found: ${id}`);
		}

		logActivity(db, "api", "task_deleted", id, {
			subject: taskRow.subject,
			removedFromPlan,
			planLineUid: planLineUidValue,
		});

		// Notify brain about task deletion with plan cleanup info
		try {
			// Queue a message to the brain for plan cleanup
			const messagePayload = {
				taskId: id,
				projectId: taskRow.source_ref || "default",
				featureId: planLineUidValue || id,
				deletedBy: "user",
				timestamp: new Date().toISOString(),
			};

			// Import brain inbox validation
			const { isBrainInboxMessageType, validateBrainInboxPayload } = await import("../../types/brain-inbox");
			const { queueMessage } = await import("../../db/state");

			const messageType = "task_deleted";
			if (!isBrainInboxMessageType(messageType)) {
				console.error(`[DELETE TASK] Invalid message type: ${messageType}`);
			} else {
				const validationError = validateBrainInboxPayload(messageType, messagePayload);
				if (validationError) {
					console.error(`[DELETE TASK] Message validation failed: ${validationError}`);
				} else {
					// Queue the message directly
					const messageId = `task-deleted-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
					queueMessage(db, {
						id: messageId,
						from: "api",
						to: "brain",
						type: messageType,
						payload: messagePayload,
					});
					console.log(`[DELETE TASK] Queued task_deleted message to brain: ${messageId}`);
				}
			}
		} catch (err) {
			console.error(`[DELETE TASK] Failed to notify brain about task deletion: ${err}`);
			// Continue even if notification fails
		}

		// Broadcast task deleted
		broadcast("tasks", "task.deleted", { taskId: id, removedFromPlan });

		return c.json({ deleted: true, removedFromPlan });
	});

	/**
	 * Remove a task from plan.md and delete it
	 * POST /api/tasks/:id/remove-from-plan
	 */
	app.post("/:id/remove-from-plan", async (c) => {
		const db = c.get("db");
		const id = c.req.param("id");

		// Get the task to find its plan_line_uid
		const taskRow = db
			.query("SELECT id, source_ref, plan_line_uid FROM tasks WHERE id = ?")
			.get(id) as TaskRow | undefined;
		if (!taskRow) {
			throw HttpError.notFound(`Task not found: ${id}`);
		}

		// Remove from plan.md if the task has a plan_line_uid
		const planLineUidValue = taskRow.plan_line_uid;
		if (typeof planLineUidValue === "string" && taskRow.source_ref) {
			// Extract file path from source_ref (format: "/path/to/file:lineNumber")
			const sourceRefMatch = taskRow.source_ref.match(/^(.+):\d+$/);
			if (sourceRefMatch?.[1]) {
				const planFilePath = sourceRefMatch[1];
				try {
					const mod = await import("../../brain/plan-parser");
					await mod.removeTaskLineFromPlan(
						planFilePath,
						planLineUidValue,
						getServerWorkspaceAccess(),
					);
				} catch (err) {
					console.error(`Failed to remove line from plan file: ${err}`);
					// Continue with deletion even if plan file removal fails
				}
			}
		}

		// Delete the task from database
		db.run("DELETE FROM tasks WHERE id = ?", [id]);

		logActivity(db, "api", "task_removed_from_plan", id);

		// Broadcast task deleted
		broadcast("tasks", "task.deleted", { taskId: id });

		return c.json({ deleted: true, removedFromPlan: true });
	});

	/**
	 * Reorder a task to a specific position using fractional indexing
	 * POST /api/tasks/reorder
	 * Body: { taskId: string, toIndex: number, prevTaskId?: string, nextTaskId?: string }
	 *
	 * Supports two modes:
	 * 1. Legacy: { taskId, toIndex } - moves to 0-based position
	 * 2. Drag-and-drop: { taskId, prevTaskId?, nextTaskId? } - moves between neighbors
	 */
	app.post("/reorder", async (c) => {
		const db = c.get("db");
		const body = await c.req.json<{
			taskId: string;
			toIndex?: number;
			prevTaskId?: string | null;
			nextTaskId?: string | null;
		}>();
		const { taskId, toIndex, prevTaskId, nextTaskId } = body;

		// Check if task exists
		const taskExists = db
			.query("SELECT 1 FROM tasks WHERE id = ?")
			.get(taskId) as { "1": number } | null;
		if (!taskExists) {
			throw HttpError.notFound(`Task not found: ${taskId}`);
		}

		let prevKey: string | null = null;
		let nextKey: string | null = null;

		// Mode 1: Drag-and-drop with neighbor IDs
		if (prevTaskId !== undefined || nextTaskId !== undefined) {
			// Get order_key of previous task
			if (prevTaskId) {
				const prevRow = db
					.query("SELECT order_key FROM tasks WHERE id = ?")
					.get(prevTaskId) as { order_key: string | null } | null;
				if (!prevRow) {
					throw HttpError.notFound(`Previous task not found: ${prevTaskId}`);
				}
				prevKey = prevRow.order_key;
			}

			// Get order_key of next task
			if (nextTaskId) {
				const nextRow = db
					.query("SELECT order_key FROM tasks WHERE id = ?")
					.get(nextTaskId) as { order_key: string | null } | null;
				if (!nextRow) {
					throw HttpError.notFound(`Next task not found: ${nextTaskId}`);
				}
				nextKey = nextRow.order_key;
			}
		}
		// Mode 2: Legacy index-based reordering
		else if (toIndex !== undefined) {
			// Get tasks ordered by order_key
			const tasks = db
				.query(
					"SELECT id, order_key FROM tasks WHERE id != ? ORDER BY order_key ASC NULLS LAST, created_at DESC",
				)
				.all(taskId) as Array<{ id: string; order_key: string | null }>;

			const targetIndex = toIndex < 0 ? tasks.length : Math.min(toIndex, tasks.length);

			// Get keys of neighbors at target position
			if (targetIndex > 0) {
				prevKey = tasks[targetIndex - 1]?.order_key ?? null;
			}
			if (targetIndex < tasks.length) {
				nextKey = tasks[targetIndex]?.order_key ?? null;
			}
		}
		else {
			throw HttpError.badRequest("Either toIndex or prevTaskId/nextTaskId must be provided");
		}

		// Generate new order_key between neighbors
		const newOrderKey = generateKeyBetween(prevKey, nextKey);

		console.log(
			`[REORDER] Moving task ${taskId} between keys: prev=${prevKey}, next=${nextKey}, new=${newOrderKey}`,
		);

		// Update only the moved task's order_key (single-row update!)
		db.run("UPDATE tasks SET order_key = ? WHERE id = ?", [newOrderKey, taskId]);

		// Note: We intentionally do NOT update sort_order here.
		// sort_order is deprecated - we only use order_key (fractional indexing) for ordering.
		// Updating sort_order for all 300+ tasks was causing 2-3 second delays on every reorder.

		logActivity(db, "api", "task_reordered", taskId, {
			newOrderKey,
			prevTaskId,
			nextTaskId,
			toIndex
		});

		// Broadcast task updated
		broadcast("tasks", "task.updated", {
			taskId,
			changes: { order_key: newOrderKey },
		});

		return c.json({ success: true, orderKey: newOrderKey });
	});

	/**
	 * Get task statistics for progress visualization
	 * GET /api/tasks/stats
	 */
	app.get("/stats", async (c) => {
		const db = c.get("db");

		const totalResult = db
			.query("SELECT COUNT(*) as count FROM tasks")
			.get() as { count: number };

		const statusRows = db
			.query("SELECT status, COUNT(*) as count FROM tasks GROUP BY status")
			.all() as Array<{ status: string; count: number }>;

		const byStatus: Record<string, number> = {};
		for (const row of statusRows) {
			byStatus[row.status] = row.count;
		}

		const completed = byStatus["completed"] ?? 0;
		const failed = byStatus["failed"] ?? 0;
		const total = totalResult.count;
		const completionRate = total > 0 ? Math.round(((completed + failed) / total) * 100) : 0;

		return c.json({
			total,
			byStatus,
			completionRate,
			active: (byStatus["claimed"] ?? 0) + (byStatus["in_progress"] ?? 0) + (byStatus["completing"] ?? 0),
			blocked: byStatus["blocked"] ?? 0,
		});
	});

	/**
	 * Get blocking bugs for a task
	 * GET /api/tasks/:id/blocking-bugs
	 */
	app.get("/:id/blocking-bugs", async (c) => {
		const db = c.get("db");
		const id = c.req.param("id");

		// Check if task exists
		const taskExists = db
			.query("SELECT 1 FROM tasks WHERE id = ?")
			.get(id) as { "1": number } | null;
		if (!taskExists) {
			throw HttpError.notFound(`Task not found: ${id}`);
		}

		// Find unresolved bugs that block this task
		const rows = db
			.query(`
				SELECT id, title, description, source, source_arm_id, source_task_id,
				       status, priority, assignee_arm_id, blockers, error_details,
				       resolution, created_at, updated_at, resolved_at
				FROM bugs
				WHERE status IN ('open', 'investigating', 'fixing', 'verifying')
				  AND blockers LIKE ?
			`)
			.all(`%${id}%`) as Array<{
				id: string;
				title: string;
				description: string;
				source: string;
				source_arm_id: string | null;
				source_task_id: string | null;
				status: string;
				priority: string;
				assignee_arm_id: string | null;
				blockers: string;
				error_details: string | null;
				resolution: string | null;
				created_at: string;
				updated_at: string;
				resolved_at: string | null;
			}>;

		// Filter to only bugs that actually have this task in their blockers
		const blockingBugs = rows
			.filter((row) => {
				try {
					const blockers = JSON.parse(row.blockers || "[]") as string[];
					return blockers.includes(id);
				} catch {
					return false;
				}
			})
			.map((row) => ({
				id: row.id,
				title: row.title,
				description: row.description,
				source: row.source,
				status: row.status,
				priority: row.priority,
				assigneeArmId: row.assignee_arm_id || undefined,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
			}));

		return c.json({
			taskId: id,
			blockingBugs,
			count: blockingBugs.length,
		});
	});

	return app;
}
