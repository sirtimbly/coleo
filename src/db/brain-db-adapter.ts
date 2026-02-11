import type { Database } from "bun:sqlite";

import type {
	ArmStateRecord,
	ArmStateStore,
	ArmStateUpsertInput,
	BrainArmListFilters,
	BrainArmRecord,
	BrainBugListFilters,
	BrainBugRecord,
	BrainDb,
	BrainDiscoveryListFilters,
	BrainDiscoveryRecord,
	BrainStatusReportListFilters,
	BrainStatusReportRecord,
	BrainTaskCreateInput,
	BrainTaskDependencyRecord,
	BrainTaskDependencyUpsertInput,
	BrainTaskListFilters,
	BrainTaskPatchInput,
	BrainTaskRecord,
} from "../brain/db-client";

function getTableColumns(db: Database, table: string): Set<string> {
	try {
		const rows = db
			.query(`PRAGMA table_info(${table})`)
			.all() as Array<{ name: string }>;
		return new Set(rows.map((row) => row.name));
	} catch {
		return new Set<string>();
	}
}

function hasColumn(columns: Set<string>, name: string): boolean {
	return columns.has(name);
}

function mapTaskRows(rows: Array<Record<string, unknown>>): BrainTaskRecord[] {
	return rows.map((row) => ({
		id: String(row.id || ""),
		subject: String(row.subject || ""),
		description: String(row.description || ""),
		status: String(row.status || "pending"),
		priority: String(row.priority || "normal"),
		sourceType: String(row.source_type || "manual"),
		sourceRef: (row.source_ref as string | null) ?? null,
		phase: (row.phase as string | null) ?? null,
		domain: (row.domain as string | null) ?? null,
		classification: (row.classification as string | null) ?? null,
		assignedTo: (row.assigned_to as string | null) ?? null,
		dependencyBlocked:
			Number(row.dependency_blocked || 0) === 1 || row.dependency_blocked === true,
		consensusStatus: (row.consensus_status as string | null) ?? null,
		sortOrder:
			row.sort_order === null || row.sort_order === undefined
				? null
				: Number(row.sort_order),
		createdAt: String(row.created_at || new Date(0).toISOString()),
		updatedAt: String(row.updated_at || row.created_at || new Date(0).toISOString()),
		completedAt: (row.completed_at as string | null) ?? null,
	}));
}

function sortTasks(
	rows: BrainTaskRecord[],
	sort: NonNullable<BrainTaskListFilters["sort"]>,
): BrainTaskRecord[] {
	const tasks = [...rows];
	switch (sort) {
		case "created_asc":
			tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
			return tasks;
		case "updated_desc":
			tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
			return tasks;
		case "completed_desc":
			tasks.sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || ""));
			return tasks;
		case "priority_then_created_asc":
			tasks.sort((a, b) => {
				const rank = (priority: string): number => {
					switch (priority) {
						case "critical":
							return 1;
						case "high":
							return 2;
						case "normal":
							return 3;
						case "low":
							return 4;
						default:
							return 5;
					}
				};
				const diff = rank(a.priority) - rank(b.priority);
				if (diff !== 0) {
					return diff;
				}
				return a.createdAt.localeCompare(b.createdAt);
			});
			return tasks;
		case "sort_order_asc":
			tasks.sort((a, b) => {
				const left = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
				const right = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
				if (left !== right) {
					return left - right;
				}
				return a.createdAt.localeCompare(b.createdAt);
			});
			return tasks;
		case "created_desc":
		default:
			tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
			return tasks;
	}
}

export function createSqliteBrainDb(db: Database): BrainDb {
	return {
		listTasks(filters = {}): BrainTaskRecord[] {
			const columns = getTableColumns(db, "tasks");
			if (!hasColumn(columns, "id")) {
				return [];
			}

			const select = [
				"id",
				"subject",
				hasColumn(columns, "description") ? "description" : "'' as description",
				hasColumn(columns, "status") ? "status" : "'pending' as status",
				hasColumn(columns, "priority") ? "priority" : "'normal' as priority",
				hasColumn(columns, "source_type") ? "source_type" : "'manual' as source_type",
				hasColumn(columns, "source_ref") ? "source_ref" : "NULL as source_ref",
				hasColumn(columns, "phase") ? "phase" : "NULL as phase",
				hasColumn(columns, "domain") ? "domain" : "NULL as domain",
				hasColumn(columns, "classification")
					? "classification"
					: "NULL as classification",
				hasColumn(columns, "assigned_to") ? "assigned_to" : "NULL as assigned_to",
				hasColumn(columns, "dependency_blocked")
					? "dependency_blocked"
					: "0 as dependency_blocked",
				hasColumn(columns, "consensus_status")
					? "consensus_status"
					: "NULL as consensus_status",
				hasColumn(columns, "sort_order") ? "sort_order" : "NULL as sort_order",
				hasColumn(columns, "created_at")
					? "created_at"
					: "datetime('now') as created_at",
				hasColumn(columns, "updated_at")
					? "updated_at"
					: hasColumn(columns, "created_at")
						? "created_at as updated_at"
						: "datetime('now') as updated_at",
				hasColumn(columns, "completed_at")
					? "completed_at"
					: "NULL as completed_at",
			].join(", ");

			let rows = mapTaskRows(
				db.query(`SELECT ${select} FROM tasks`).all() as Array<Record<string, unknown>>,
			);

			if (filters.statuses && filters.statuses.length > 0) {
				const allowed = new Set(filters.statuses);
				rows = rows.filter((row) => allowed.has(row.status));
			}
			if (filters.excludeStatuses && filters.excludeStatuses.length > 0) {
				const excluded = new Set(filters.excludeStatuses);
				rows = rows.filter((row) => !excluded.has(row.status));
			}
			if (filters.priority) {
				rows = rows.filter((row) => row.priority === filters.priority);
			}
			if (filters.domain) {
				rows = rows.filter((row) => row.domain === filters.domain);
			}
			if (filters.phase) {
				rows = rows.filter((row) => row.phase === filters.phase);
			}
			if (filters.assignedTo === null || filters.unassignedOnly) {
				rows = rows.filter((row) => !row.assignedTo);
			} else if (typeof filters.assignedTo === "string") {
				rows = rows.filter((row) => row.assignedTo === filters.assignedTo);
			}
			if (filters.dependencyBlocked !== undefined) {
				rows = rows.filter(
					(row) => row.dependencyBlocked === filters.dependencyBlocked,
				);
			}
			if (filters.includeSubject) {
				const needle = filters.includeSubject.toLowerCase();
				rows = rows.filter((row) => row.subject.toLowerCase().includes(needle));
			}
			if (filters.excludeSubjectPrefix) {
				rows = rows.filter(
					(row) => !row.subject.startsWith(filters.excludeSubjectPrefix!),
				);
			}

			rows = sortTasks(rows, filters.sort || "created_desc");
			const offset = filters.offset ?? 0;
			const limit = filters.limit ?? rows.length;
			return rows.slice(offset, offset + limit);
		},

		getTask(taskId: string): BrainTaskRecord | null {
			return (
				this.listTasks({ limit: 2000 }).find((task) => task.id === taskId) || null
			);
		},

		createTask(input: BrainTaskCreateInput): BrainTaskRecord {
			const columns = getTableColumns(db, "tasks");
			const now = new Date().toISOString();
			const values: Array<[string, unknown]> = [];

			values.push(["id", input.id || `task-${Date.now()}`]);
			values.push(["subject", input.subject]);
			if (hasColumn(columns, "description")) {
				values.push(["description", input.description]);
			}
			if (hasColumn(columns, "status")) {
				values.push(["status", input.status || "pending"]);
			}
			if (hasColumn(columns, "priority")) {
				values.push(["priority", input.priority || "normal"]);
			}
			if (hasColumn(columns, "source_type")) {
				values.push(["source_type", input.sourceType || "manual"]);
			}
			if (hasColumn(columns, "source_ref")) {
				values.push(["source_ref", input.sourceRef ?? null]);
			}
			if (hasColumn(columns, "phase")) {
				values.push(["phase", input.phase ?? null]);
			}
			if (hasColumn(columns, "domain")) {
				values.push(["domain", input.domain ?? null]);
			}
			if (hasColumn(columns, "classification")) {
				values.push(["classification", input.classification ?? null]);
			}
			if (hasColumn(columns, "assigned_to")) {
				values.push(["assigned_to", input.assignedTo ?? null]);
			}
			if (hasColumn(columns, "dependency_blocked")) {
				values.push(["dependency_blocked", input.dependencyBlocked ? 1 : 0]);
			}
			if (hasColumn(columns, "sort_order") && input.sortOrder !== undefined) {
				values.push(["sort_order", input.sortOrder]);
			}
			if (hasColumn(columns, "created_at")) {
				values.push(["created_at", now]);
			}
			if (hasColumn(columns, "updated_at")) {
				values.push(["updated_at", now]);
			}

			const fields = values.map(([field]) => field).join(", ");
			const placeholders = values.map(() => "?").join(", ");
			const createdTaskId = String(values[0]?.[1] || input.id || "");
			db.run(
				`INSERT INTO tasks (${fields}) VALUES (${placeholders})`,
				values.map(([, value]) => value) as any[],
			);

			const created = this.getTask(createdTaskId);
			if (!created) {
				throw new Error("Failed to create task");
			}
			return created;
		},

		updateTask(taskId: string, patch: BrainTaskPatchInput): BrainTaskRecord {
			const columns = getTableColumns(db, "tasks");
			const updates: string[] = [];
			const values: unknown[] = [];
			const now = new Date().toISOString();
			const maybeSet = (column: string, value: unknown): void => {
				if (!hasColumn(columns, column)) {
					return;
				}
				updates.push(`${column} = ?`);
				values.push(value);
			};

			if (patch.subject !== undefined) maybeSet("subject", patch.subject);
			if (patch.description !== undefined)
				maybeSet("description", patch.description);
			if (patch.status !== undefined) maybeSet("status", patch.status);
			if (patch.priority !== undefined) maybeSet("priority", patch.priority);
			if (patch.phase !== undefined) maybeSet("phase", patch.phase);
			if (patch.domain !== undefined) maybeSet("domain", patch.domain);
			if (patch.classification !== undefined)
				maybeSet("classification", patch.classification);
			if (patch.assignedTo !== undefined) maybeSet("assigned_to", patch.assignedTo);
			if (patch.dependencyBlocked !== undefined)
				maybeSet("dependency_blocked", patch.dependencyBlocked ? 1 : 0);
			if (patch.sortOrder !== undefined) maybeSet("sort_order", patch.sortOrder);
			if (hasColumn(columns, "updated_at")) {
				updates.push("updated_at = ?");
				values.push(now);
			}

			if (updates.length > 0) {
				values.push(taskId);
				db.run(
					`UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`,
					values as (string | number | null)[],
				);
			}

			const updated = this.getTask(taskId);
			if (!updated) {
				throw new Error(`Task not found: ${taskId}`);
			}
			return updated;
		},

		listBugs(filters: BrainBugListFilters = {}): BrainBugRecord[] {
			try {
				const rows = db
					.query(
						`SELECT id, title, description, source, status, priority, assignee_arm_id, error_details, created_at, updated_at
             FROM bugs`,
					)
					.all() as Array<{
					id: string;
					title: string;
					description: string;
					source: string;
					status: string;
					priority: string;
					assignee_arm_id: string | null;
					error_details: string | null;
					created_at: string;
					updated_at: string;
				}>;

				let bugs = rows.map((row) => ({
					id: row.id,
					title: row.title,
					description: row.description,
					source: row.source,
					status: row.status,
					priority: row.priority,
					assigneeArmId: row.assignee_arm_id,
					errorDetails: row.error_details,
					createdAt: row.created_at,
					updatedAt: row.updated_at,
				}));

				if (filters.statuses && filters.statuses.length > 0) {
					const allowed = new Set(filters.statuses);
					bugs = bugs.filter((bug) => allowed.has(bug.status));
				}
				if (filters.priority) {
					bugs = bugs.filter((bug) => bug.priority === filters.priority);
				}
				if (filters.unassignedOnly || filters.assigneeArmId === null) {
					bugs = bugs.filter((bug) => !bug.assigneeArmId);
				} else if (typeof filters.assigneeArmId === "string") {
					bugs = bugs.filter((bug) => bug.assigneeArmId === filters.assigneeArmId);
				}
				if (filters.includeTitle) {
					const needle = filters.includeTitle.toLowerCase();
					bugs = bugs.filter((bug) => bug.title.toLowerCase().includes(needle));
				}
				return bugs.slice(0, filters.limit ?? bugs.length);
			} catch {
				return [];
			}
		},

		getBug(bugId: string): BrainBugRecord | null {
			return this.listBugs({ limit: 500 }).find((bug) => bug.id === bugId) || null;
		},

		listDiscoveries(filters: BrainDiscoveryListFilters = {}): BrainDiscoveryRecord[] {
			try {
				const columns = getTableColumns(db, "discoveries");
				const select = [
					"id",
					hasColumn(columns, "arm_id") ? "arm_id" : "NULL as arm_id",
					hasColumn(columns, "arm_name") ? "arm_name" : "NULL as arm_name",
					"kind",
					"title",
					"details",
					hasColumn(columns, "file_path") ? "file_path" : "NULL as file_path",
					hasColumn(columns, "line_number")
						? "line_number"
						: "NULL as line_number",
					hasColumn(columns, "severity") ? "severity" : "'info' as severity",
					hasColumn(columns, "status") ? "status" : "'open' as status",
					hasColumn(columns, "task_id") ? "task_id" : "NULL as task_id",
					hasColumn(columns, "phase") ? "phase" : "NULL as phase",
					hasColumn(columns, "created_at")
						? "created_at"
						: "datetime('now') as created_at",
					hasColumn(columns, "updated_at")
						? "updated_at"
						: hasColumn(columns, "created_at")
							? "created_at as updated_at"
							: "datetime('now') as updated_at",
				].join(", ");

				const rows = db
					.query(`SELECT ${select} FROM discoveries`)
					.all() as Array<{
					id: string;
					arm_id: string | null;
					arm_name: string | null;
					kind: string;
					title: string;
					details: string;
					file_path: string | null;
					line_number: number | null;
					severity: string;
					status: string;
					task_id: string | null;
					phase: string | null;
					created_at: string;
					updated_at: string;
				}>;

				let discoveries = rows.map((row) => ({
					id: row.id,
					armId: row.arm_id || "",
					armName: row.arm_name || row.arm_id || "",
					kind: row.kind,
					title: row.title,
					details: row.details,
					filePath: row.file_path,
					lineNumber: row.line_number,
					severity: row.severity,
					status: row.status,
					taskId: row.task_id,
					phase: row.phase,
					createdAt: row.created_at,
					updatedAt: row.updated_at,
				}));

				if (filters.status) {
					discoveries = discoveries.filter(
						(discovery) => discovery.status === filters.status,
					);
				}
				if (filters.armId) {
					discoveries = discoveries.filter(
						(discovery) => discovery.armId === filters.armId,
					);
				}
				if (filters.kind) {
					discoveries = discoveries.filter(
						(discovery) => discovery.kind === filters.kind,
					);
				}
				if (filters.severities && filters.severities.length > 0) {
					const allowed = new Set(filters.severities);
					discoveries = discoveries.filter((discovery) =>
						allowed.has(discovery.severity),
					);
				}
				if (filters.taskId) {
					discoveries = discoveries.filter(
						(discovery) => discovery.taskId === filters.taskId,
					);
				}

				discoveries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
				return discoveries.slice(0, filters.limit ?? discoveries.length);
			} catch {
				return [];
			}
		},

		listStatusReports(
			filters: BrainStatusReportListFilters = {},
		): BrainStatusReportRecord[] {
			try {
				const rows = db
					.query(
						`SELECT id, task_id, arm_id, status, summary, issues, blockers, next_steps, files_changed, tests_status, created_at
             FROM status_reports`,
					)
					.all() as Array<{
					id: string;
					task_id: string;
					arm_id: string;
					status: string;
					summary: string;
					issues: string | null;
					blockers: string | null;
					next_steps: string | null;
					files_changed: string | null;
					tests_status: "passing" | "failing" | "not_run" | null;
					created_at: string;
				}>;

				let reports = rows.map((row) => ({
					id: row.id,
					taskId: row.task_id,
					armId: row.arm_id,
					status: row.status,
					summary: row.summary,
					issues: row.issues ? (JSON.parse(row.issues) as string[]) : [],
					blockers: row.blockers ? (JSON.parse(row.blockers) as string[]) : [],
					nextSteps: row.next_steps || undefined,
					filesChanged: row.files_changed
						? (JSON.parse(row.files_changed) as string[])
						: [],
					testsStatus: row.tests_status || undefined,
					createdAt: row.created_at,
				}));

				if (filters.taskId) {
					reports = reports.filter((report) => report.taskId === filters.taskId);
				}
				if (filters.armId) {
					reports = reports.filter((report) => report.armId === filters.armId);
				}
				if (filters.status) {
					reports = reports.filter((report) => report.status === filters.status);
				}
				if (filters.since) {
					reports = reports.filter((report) => report.createdAt > filters.since!);
				}

				reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
				const offset = filters.offset ?? 0;
				const limit = filters.limit ?? reports.length;
				return reports.slice(offset, offset + limit);
			} catch {
				return [];
			}
		},

		listTaskDependencies(taskId: string): BrainTaskDependencyRecord[] {
			try {
				const rows = db
					.query(
						`SELECT task_id, depends_on_task_id, dependency_type, auto_detected, reason
             FROM task_dependencies
             WHERE task_id = ?`,
					)
					.all(taskId) as Array<{
					task_id: string;
					depends_on_task_id: string;
					dependency_type:
						| "finish_to_start"
						| "start_to_start"
						| "finish_to_finish"
						| "start_to_finish"
						| null;
					auto_detected: number | null;
					reason: string | null;
				}>;
				return rows.map((row) => ({
					taskId: row.task_id,
					dependsOnTaskId: row.depends_on_task_id,
					dependencyType: (row.dependency_type ||
						"finish_to_start") as BrainTaskDependencyRecord["dependencyType"],
					autoDetected: Number(row.auto_detected || 0) === 1,
					reason: row.reason,
				}));
			} catch {
				return [];
			}
		},

		upsertTaskDependency(input: BrainTaskDependencyUpsertInput): void {
			try {
				db.run(
					`INSERT INTO task_dependencies (task_id, depends_on_task_id, dependency_type, auto_detected, reason)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(task_id, depends_on_task_id) DO UPDATE SET
             dependency_type = excluded.dependency_type,
             auto_detected = excluded.auto_detected,
             reason = excluded.reason`,
					[
						input.taskId,
						input.dependsOnTaskId,
						input.dependencyType || "finish_to_start",
						input.autoDetected === false ? 0 : 1,
						input.reason || null,
					],
				);
			} catch {
				try {
					const existing = db
						.query(
							"SELECT id FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?",
						)
						.get(input.taskId, input.dependsOnTaskId) as
						| { id: number }
						| null;

					if (existing) {
						db.run(
							`UPDATE task_dependencies
               SET dependency_type = ?, auto_detected = ?, reason = ?
               WHERE id = ?`,
							[
								input.dependencyType || "finish_to_start",
								input.autoDetected === false ? 0 : 1,
								input.reason || null,
								existing.id,
							],
						);
					} else {
						db.run(
							`INSERT INTO task_dependencies (task_id, depends_on_task_id, dependency_type, auto_detected, reason)
               VALUES (?, ?, ?, ?, ?)`,
							[
								input.taskId,
								input.dependsOnTaskId,
								input.dependencyType || "finish_to_start",
								input.autoDetected === false ? 0 : 1,
								input.reason || null,
							],
						);
					}
				} catch {
					// ignore for tests that do not include dependency tables
				}
			}
		},

		listArms(filters: BrainArmListFilters = {}): BrainArmRecord[] {
			try {
				const columns = getTableColumns(db, "arms");
				const select = [
					"id",
					"name",
					hasColumn(columns, "status") ? "status" : "'idle' as status",
					hasColumn(columns, "current_task_subject")
						? "current_task_subject"
						: "NULL as current_task_subject",
					hasColumn(columns, "last_activity_at")
						? "last_activity_at"
						: "NULL as last_activity_at",
				].join(", ");
				let rows = db.query(`SELECT ${select} FROM arms`).all() as Array<{
					id: string;
					name: string;
					status: string;
					current_task_subject: string | null;
					last_activity_at: string | null;
				}>;

				if (!filters.includeStopped) {
					rows = rows.filter((row) => row.status !== "stopped");
				}
				if (filters.armId) {
					rows = rows.filter((row) => row.id === filters.armId);
				}

				return rows.map((row) => ({
					id: row.id,
					name: row.name,
					status: row.status,
					currentTaskSubject: row.current_task_subject,
					lastActivityAt: row.last_activity_at,
				}));
			} catch {
				return [];
			}
		},
	};
}

export function createSqliteArmStateStore(db: Database): ArmStateStore {
	return {
		getArmState(armId: string): ArmStateRecord | null {
			const row = db
				.query(
					`SELECT arm_id, state, previous_state, current_task_id, current_task_subject, last_event_type,
                last_event_at, state_entered_at, task_assigned_at, disconnected_at, last_error,
                error_count, last_heartbeat, consecutive_missed_heartbeats
         FROM arm_state_machine WHERE arm_id = ?`,
				)
				.get(armId) as ArmStateRecord | null;
			return row;
		},
		listArmStatesByState(state: string): ArmStateRecord[] {
			return db
				.query(
					`SELECT arm_id, state, previous_state, current_task_id, current_task_subject, last_event_type,
                last_event_at, state_entered_at, task_assigned_at, disconnected_at, last_error,
                error_count, last_heartbeat, consecutive_missed_heartbeats
         FROM arm_state_machine WHERE state = ?`,
				)
				.all(state) as ArmStateRecord[];
		},
		upsertArmState(armId: string, input: ArmStateUpsertInput): void {
			const now = new Date().toISOString();
			db.run(
				`INSERT INTO arm_state_machine (
           arm_id, state, previous_state, current_task_id, current_task_subject, last_event_type,
           last_event_at, state_entered_at, task_assigned_at, disconnected_at, last_error,
           error_count, last_heartbeat, consecutive_missed_heartbeats
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(arm_id) DO UPDATE SET
           state = excluded.state,
           previous_state = excluded.previous_state,
           current_task_id = excluded.current_task_id,
           current_task_subject = excluded.current_task_subject,
           last_event_type = excluded.last_event_type,
           last_event_at = excluded.last_event_at,
           state_entered_at = excluded.state_entered_at,
           task_assigned_at = excluded.task_assigned_at,
           disconnected_at = excluded.disconnected_at,
           last_error = excluded.last_error,
           error_count = excluded.error_count,
           last_heartbeat = excluded.last_heartbeat,
           consecutive_missed_heartbeats = excluded.consecutive_missed_heartbeats`,
				[
					armId,
					input.state || "spawning",
					input.previousState ?? null,
					input.currentTaskId ?? null,
					input.currentTaskSubject ?? null,
					input.lastEventType ?? null,
					input.lastEventAt || now,
					input.stateEnteredAt || now,
					input.taskAssignedAt ?? null,
					input.disconnectedAt ?? null,
					input.lastError ?? null,
					input.errorCount ?? 0,
					input.lastHeartbeat ?? null,
					input.consecutiveMissedHeartbeats ?? 0,
				],
			);
		},
		deleteArmState(armId: string): void {
			db.run("DELETE FROM arm_state_machine WHERE arm_id = ?", [armId]);
		},
		transaction<T>(fn: () => T): () => T {
			return () => fn();
		},
	};
}
