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

interface TasksContext {
	Variables: {
		db: Database;
	};
}

export interface Task {
	id: string;
	subject: string;
	description: string;
	status:
		| "pending"
		| "claimed"
		| "in_progress"
		| "completing"
		| "completed"
		| "failed"
		| "blocked"
		| "cancelled";
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
	commentCount?: number;
	lastCommentAt?: string | null;
	mailThreadId?: string | null;
	progress?: number;
	createdAt: string;
	updatedAt: string;
	completedAt: string | null;
	claimedAt: string | null;
	startedAt: string | null;
	dueDate: string | null;
	artifacts: string[];
	context: Record<string, unknown>;
	metadata: Record<string, unknown>;
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
	comment_count: number | null;
	last_comment_at: string | null;
	mail_thread_id: string | null;
	progress: number | null;
	created_at: string;
	updated_at: string;
	completed_at: string | null;
	claimed_at: string | null;
	started_at: string | null;
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
		commentCount: row.comment_count ?? 0,
		lastCommentAt: row.last_comment_at,
		mailThreadId: row.mail_thread_id,
		progress: row.progress ?? undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		completedAt: row.completed_at,
		claimedAt: row.claimed_at,
		startedAt: row.started_at,
		dueDate: row.due_date,
		artifacts: JSON.parse(row.artifacts || "[]"),
		context: JSON.parse(row.context || "{}"),
		metadata: JSON.parse(row.metadata || "{}"),
	};
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
        t.dependency_blocked, t.consensus_status, t.plan_line_uid, t.sort_order,
        t.comment_count, t.last_comment_at,
        t.mail_thread_id, t.progress,
        t.created_at, t.updated_at, t.completed_at,
        t.claimed_at, t.started_at, t.due_date,
        t.artifacts, t.context, t.metadata
      FROM tasks t
      LEFT JOIN arms a ON t.assigned_to = a.id
      ${whereClause}
      ORDER BY
        t.sort_order ASC,
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

		const row = db
			.query(`
      SELECT
        t.id, t.subject, t.description, t.status, t.priority,
        t.source_type, t.source_ref, t.phase, t.domain, t.classification,
        t.assigned_to, a.name as assigned_arm_name,
        t.dependency_blocked, t.consensus_status, t.plan_line_uid, t.sort_order,
        t.comment_count, t.last_comment_at,
        t.mail_thread_id, t.progress,
        t.created_at, t.updated_at, t.completed_at,
        t.claimed_at, t.started_at, t.due_date,
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
		}>();

		if (!body.subject?.trim()) {
			throw HttpError.badRequest("subject is required");
		}

		if (!body.description?.trim()) {
			throw HttpError.badRequest("description is required");
		}

		const providedId = body.id?.trim();
		let id: string;
		if (providedId) {
			id = providedId;
		} else {
			// Generate sequential task ID
			const maxIdResult = db
				.query(
					"SELECT MAX(CAST(SUBSTR(id, 6) AS INTEGER)) as max_num FROM tasks WHERE id LIKE 'task-%'",
				)
				.get() as { max_num: number | null };
			const nextNum = (maxIdResult?.max_num ?? 0) + 1;
			id = `task-${nextNum}`;
		}

		// Get current max sort_order to place new task at the end
		const maxSortOrder = db
			.query("SELECT COALESCE(MAX(sort_order), -1) as max_sort FROM tasks")
			.get() as { max_sort: number };
		const newSortOrder = body.sortOrder ?? (maxSortOrder?.max_sort ?? -1) + 1;

		const now = new Date().toISOString();

		db.run(
			`
      INSERT INTO tasks (id, subject, description, status, priority, source_type, source_ref, phase, domain, classification, mail_thread_id, context, due_date, sort_order, progress, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
			[
				id,
				body.subject.trim(),
				body.description.trim(),
				body.status || "pending",
				body.priority || "normal",
				body.sourceType || "manual",
				body.sourceRef || null,
				body.phase || null,
				body.domain || null,
				body.classification || null,
				body.mailThreadId || null,
				JSON.stringify(body.context || {}),
				body.dueDate || null,
				newSortOrder, // Place at the end of the list
				Math.min(Math.max(body.progress ?? 0, 0), 100), // Clamp between 0-100
				JSON.stringify(body.metadata || {}),
				now,
				now,
			],
		);

		logActivity(db, "api", "task_created", id, {
			subject: body.subject,
			priority: body.priority,
			domain: body.domain,
		});

		// Broadcast task created
		broadcast("tasks", "task.created", { taskId: id, subject: body.subject });

		const row = db
			.query(`
      SELECT
        t.id, t.subject, t.description, t.status, t.priority,
        t.source_type, t.source_ref, t.phase, t.domain, t.classification,
        t.assigned_to, NULL as assigned_arm_name,
        t.dependency_blocked, t.consensus_status, t.plan_line_uid, t.sort_order,
        t.comment_count, t.last_comment_at,
        t.mail_thread_id, t.progress, t.created_at, t.updated_at, t.completed_at,
        t.claimed_at, t.started_at, t.due_date,
        t.artifacts, t.context, t.metadata
      FROM tasks t
      WHERE t.id = ?
    `)
			.get(id) as TaskRow;

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
			sortOrder?: number | null;
			dueDate?: string | null;
			progress?: number;
			artifacts?: string[];
			metadata?: Record<string, unknown>;
		}>();

		// Check task exists
		const existing = db
			.query("SELECT id, status, domain FROM tasks WHERE id = ?")
			.get(id) as { id: string; status: string; domain: string | null } | null;
		if (!existing) {
			throw HttpError.notFound(`Task not found: ${id}`);
		}

		const updates: string[] = [];
		const values: unknown[] = [];
		const now = new Date().toISOString();

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

			// Set timestamp fields based on status change
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

		if (body.assignedTo !== undefined) {
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

		if (body.sortOrder !== undefined) {
			updates.push("sort_order = ?");
			values.push(body.sortOrder);
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

		logActivity(db, "api", "task_updated", id, body);

		// Broadcast task updated
		broadcast("tasks", "task.updated", { taskId: id, changes: body });

		// Fetch updated task
		const row = db
			.query(`
      SELECT
        t.id, t.subject, t.description, t.status, t.priority,
        t.source_type, t.source_ref, t.phase, t.domain, t.classification,
        t.assigned_to, a.name as assigned_arm_name,
        t.dependency_blocked, t.consensus_status, t.plan_line_uid, t.sort_order,
        t.comment_count, t.last_comment_at,
        t.mail_thread_id, t.progress,
        t.created_at, t.updated_at, t.completed_at,
        t.claimed_at, t.started_at, t.due_date,
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
				};

				eventStore
					.publishEvent(`coleo.events.task.${id}.${eventType}`, {
						type: eventType,
						armId: row.assigned_to || undefined,
						data,
						timestamp,
					})
					.catch(() => {
						// Best-effort
					});

				if (row.assigned_to) {
					eventStore
						.publishEvent(`coleo.events.arm.${row.assigned_to}.${eventType}`, {
							type: eventType,
							armId: row.assigned_to,
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
	 * Delete a task
	 * DELETE /api/tasks/:id
	 */
	app.delete("/:id", (c) => {
		const db = c.get("db");
		const id = c.req.param("id");

		const result = db.run("DELETE FROM tasks WHERE id = ?", [id]);
		if (result.changes === 0) {
			throw HttpError.notFound(`Task not found: ${id}`);
		}

		logActivity(db, "api", "task_deleted", id);

		// Broadcast task deleted
		broadcast("tasks", "task.deleted", { taskId: id });

		return c.json({ deleted: true });
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
			if (sourceRefMatch) {
				const planFilePath = sourceRefMatch[1];
				try {
					const mod = await import("../../brain/plan-parser");
					const removeFn: (path: string, uid: string) => Promise<boolean> =
						mod.removeTaskLineFromPlan;
					// @ts-expect-error - TypeScript doesn't properly narrow the type here
					await removeFn(planFilePath, planLineUidValue);
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
	 * Reorder a task to a specific position
	 * POST /api/tasks/reorder
	 * Body: { taskId: string, toSortOrder: number }
	 * toSortOrder: 0-based position in the full task list (0 = top, -1 = bottom)
	 */
	app.post("/reorder", async (c) => {
		const db = c.get("db");
		const body = await c.req.json<{ taskId: string; toSortOrder: number }>();
		const { taskId, toSortOrder } = body;

		// Get current task order (sort_order ASC means lower values appear first)
		const tasks = db
			.query(
				"SELECT id, sort_order FROM tasks ORDER BY sort_order ASC, created_at DESC",
			)
			.all() as Array<{ id: string; sort_order: number | null }>;

		// Find the task in the list
		const taskIndex = tasks.findIndex((t) => t.id === taskId);
		if (taskIndex === -1) {
			throw HttpError.notFound(`Task not found: ${taskId}`);
		}

		// Remove task from current position
		const movedTask = tasks.splice(taskIndex, 1)[0];
		if (!movedTask) {
			throw HttpError.notFound(`Task not found: ${taskId}`);
		}

		// Insert at new position (handle -1 for "move to bottom")
		const finalIndex =
			toSortOrder < 0 ? tasks.length : Math.min(toSortOrder, tasks.length);
		tasks.splice(finalIndex, 0, movedTask);

		console.log(
			`[REORDER] Moving task ${taskId} from index ${taskIndex} to index ${finalIndex}, total tasks: ${tasks.length}`,
		);

		// Update sort_order for all affected tasks
		// Index 0 (top) = sort_order 0, Index 1 = sort_order 1, etc.
		for (let i = 0; i < tasks.length; i++) {
			const sortOrder = i; // Lower sort_order = appears first
			const taskIdAtIndex = tasks[i]?.id;
			if (taskIdAtIndex) {
				console.log(
					`[REORDER] Updating task ${taskIdAtIndex} to sort_order ${sortOrder}`,
				);
				db.run("UPDATE tasks SET sort_order = ? WHERE id = ?", [
					sortOrder,
					taskIdAtIndex,
				]);
			}
		}

		logActivity(db, "api", "task_reordered", taskId, { toSortOrder });

		// Broadcast task updated
		const updatedTask = tasks.find((t) => t.id === taskId);
		broadcast("tasks", "task.updated", {
			taskId,
			changes: { sort_order: updatedTask?.sort_order },
		});

		return c.json({ success: true });
	});

	return app;
}
