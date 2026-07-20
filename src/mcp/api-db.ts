import { spawnSync } from "child_process";
import { Database } from "bun:sqlite";
import { join } from "path";
import { getColeoDir } from "../config";
import { compareKeys } from "../lib/fractional-indexing";
import type {
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
import type {
	McpDb,
	McpDbRunResult,
	McpDbQueryHandle,
	ApiTask,
	ApiBug,
	ApiDiscovery,
	ApiStatusReport,
	ApiArm,
	CurlResult,
} from "./api-db-types";

export type {
	McpDb,
	McpDbRunResult,
	McpDbQueryHandle,
	ApiTask,
	ApiBug,
	ApiDiscovery,
	ApiStatusReport,
	ApiArm,
	CurlResult,
} from "./api-db-types";

export class ApiDatabase implements McpDb, BrainDb {
	private readonly baseUrl: string;
	private readonly apiKey: string;
	private readonly allowLocalFallback: boolean;
	private fallbackDb: Database | null = null;

	constructor(baseUrl: string, apiKey: string) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.apiKey = apiKey;
		this.allowLocalFallback = process.env.COLEO_MCP_SQLITE_FALLBACK === "1";
	}

	run(sql: string, ...bindings: unknown[]): McpDbRunResult {
		const params =
			Array.isArray(bindings[0]) && bindings.length === 1
				? (bindings[0] as unknown[])
				: bindings;
		return this.requestSql<McpDbRunResult>("run", sql, params);
	}

	query(sql: string): McpDbQueryHandle {
		return {
			get: (...params: unknown[]) =>
				this.requestSql<unknown | null>("get", sql, params),
			all: (...params: unknown[]) => this.requestSql<unknown[]>("all", sql, params),
		};
	}

	listTasks(filters: BrainTaskListFilters = {}): BrainTaskRecord[] {
		const params = new URLSearchParams();
		if (filters.statuses && filters.statuses.length > 0) {
			params.set("status", filters.statuses.join(","));
		}
		if (filters.priority) {
			params.set("priority", filters.priority);
		}
		if (filters.domain) {
			params.set("domain", filters.domain);
		}
		if (filters.phase) {
			params.set("phase", filters.phase);
		}
		if (typeof filters.assignedTo === "string" && filters.assignedTo.trim()) {
			params.set("assignedTo", filters.assignedTo);
		}

		const fetchLimit = Math.min(
			500,
			Math.max((filters.limit ?? 200) + (filters.offset ?? 0), 100),
		);
		params.set("limit", String(fetchLimit));
		params.set("offset", "0");

		const response = this.requestJson<{ tasks: ApiTask[] }>(
			"GET",
			`/api/tasks?${params.toString()}`,
		);
		let rows = (response?.tasks || []).map((task) => this.parseTask(task));

		if (filters.excludeStatuses && filters.excludeStatuses.length > 0) {
			const excluded = new Set(filters.excludeStatuses);
			rows = rows.filter((task) => !excluded.has(task.status));
		}

		if (filters.unassignedOnly) {
			rows = rows.filter((task) => !task.assignedTo);
		}

		if (filters.assignedTo === null) {
			rows = rows.filter((task) => !task.assignedTo);
		}

		if (filters.dependencyBlocked !== undefined) {
			rows = rows.filter(
				(task) => task.dependencyBlocked === filters.dependencyBlocked,
			);
		}

		if (filters.includeSubject) {
			const needle = filters.includeSubject.toLowerCase();
			rows = rows.filter((task) => task.subject.toLowerCase().includes(needle));
		}

		if (filters.excludeSubjectPrefix) {
			rows = rows.filter(
				(task) => !task.subject.startsWith(filters.excludeSubjectPrefix!),
			);
		}

		const sortMode = filters.sort || "created_desc";
		rows = this.sortTasks(rows, sortMode);

		const offset = filters.offset ?? 0;
		const limit = filters.limit ?? rows.length;
		return rows.slice(offset, offset + limit);
	}

	getTask(taskId: string): BrainTaskRecord | null {
		const response = this.requestJson<{ task: ApiTask }>(
			"GET",
			`/api/tasks/${encodeURIComponent(taskId)}`,
			undefined,
			true,
		);
		return response?.task ? this.parseTask(response.task) : null;
	}

	createTask(input: BrainTaskCreateInput): BrainTaskRecord {
		const response = this.requestJson<{ task: ApiTask }>("POST", "/api/tasks", {
			id: input.id,
			subject: input.subject,
			description: input.description,
			status: input.status,
			priority: input.priority,
			sourceType: input.sourceType,
			sourceRef: input.sourceRef,
			phase: input.phase,
			domain: input.domain,
			classification: input.classification,
			assignedTo: input.assignedTo,
			dependencyBlocked: input.dependencyBlocked,
			sortOrder: input.sortOrder,
			context: input.context,
		});
		if (!response?.task) {
			throw new Error("Task creation response missing task");
		}
		return this.parseTask(response.task);
	}

	updateTask(taskId: string, patch: BrainTaskPatchInput): BrainTaskRecord {
		const response = this.requestJson<{ task: ApiTask }>(
			"PATCH",
			`/api/tasks/${encodeURIComponent(taskId)}`,
			patch,
		);
		if (!response?.task) {
			throw new Error(`Task update response missing task for ${taskId}`);
		}
		return this.parseTask(response.task);
	}

	listBugs(filters: BrainBugListFilters = {}): BrainBugRecord[] {
		const params = new URLSearchParams();
		if (filters.priority) {
			params.set("priority", filters.priority);
		}
		if (
			filters.statuses &&
			filters.statuses.length === 1 &&
			filters.statuses[0]
		) {
			params.set("status", filters.statuses[0]);
		}
		if (typeof filters.assigneeArmId === "string" && filters.assigneeArmId.trim()) {
			params.set("assignee", filters.assigneeArmId);
		}
		params.set("limit", String(Math.min(filters.limit ?? 100, 100)));

		const response = this.requestJson<{ bugs: ApiBug[] }>(
			"GET",
			`/api/bugs?${params.toString()}`,
		);
		let bugs = (response?.bugs || []).map((bug) => this.parseBug(bug));

		if (filters.statuses && filters.statuses.length > 0) {
			const allowed = new Set(filters.statuses);
			bugs = bugs.filter((bug) => allowed.has(bug.status));
		}

		if (filters.unassignedOnly) {
			bugs = bugs.filter((bug) => !bug.assigneeArmId);
		}

		if (filters.assigneeArmId === null) {
			bugs = bugs.filter((bug) => !bug.assigneeArmId);
		}

		if (filters.includeTitle) {
			const needle = filters.includeTitle.toLowerCase();
			bugs = bugs.filter((bug) => bug.title.toLowerCase().includes(needle));
		}

		const limit = filters.limit ?? bugs.length;
		return bugs.slice(0, limit);
	}

	getBug(bugId: string): BrainBugRecord | null {
		const response = this.requestJson<{ bug: ApiBug }>(
			"GET",
			`/api/bugs/${encodeURIComponent(bugId)}`,
			undefined,
			true,
		);
		return response?.bug ? this.parseBug(response.bug) : null;
	}

	listDiscoveries(filters: BrainDiscoveryListFilters = {}): BrainDiscoveryRecord[] {
		const params = new URLSearchParams();
		if (filters.armId) {
			params.set("armId", filters.armId);
		}
		if (filters.kind) {
			params.set("kind", filters.kind);
		}
		if (filters.status) {
			params.set("status", filters.status);
		}
		if (
			filters.severities &&
			filters.severities.length === 1 &&
			filters.severities[0]
		) {
			params.set("severity", filters.severities[0]);
		}
		params.set("limit", String(Math.min(filters.limit ?? 100, 100)));

		const response = this.requestJson<{ discoveries: ApiDiscovery[] }>(
			"GET",
			`/api/discoveries?${params.toString()}`,
		);
		let discoveries = (response?.discoveries || []).map((d) => this.parseDiscovery(d));

		if (filters.severities && filters.severities.length > 1) {
			const allowed = new Set(filters.severities);
			discoveries = discoveries.filter((d) => allowed.has(d.severity));
		}

		if (filters.taskId) {
			discoveries = discoveries.filter((d) => d.taskId === filters.taskId);
		}

		const limit = filters.limit ?? discoveries.length;
		return discoveries.slice(0, limit);
	}

	listStatusReports(
		filters: BrainStatusReportListFilters = {},
	): BrainStatusReportRecord[] {
		const params = new URLSearchParams();
		if (filters.taskId) {
			params.set("taskId", filters.taskId);
		}
		if (filters.armId) {
			params.set("armId", filters.armId);
		}
		if (filters.status) {
			params.set("status", filters.status);
		}
		if (filters.since) {
			params.set("since", filters.since);
		}
		params.set("limit", String(Math.min(filters.limit ?? 100, 100)));
		params.set("offset", String(filters.offset ?? 0));

		const response = this.requestJson<{ reports: ApiStatusReport[] }>(
			"GET",
			`/api/status-reports?${params.toString()}`,
		);

		return (response?.reports || []).map((report) => this.parseStatusReport(report));
	}

	listTaskDependencies(taskId: string): BrainTaskDependencyRecord[] {
		const response = this.requestJson<{
			dependencies: Array<{
				taskId: string;
				dependsOnTaskId: string;
				dependencyType: BrainTaskDependencyRecord["dependencyType"];
				autoDetected: boolean;
				reason: string | null;
			}>;
		}>("GET", `/api/tasks/${encodeURIComponent(taskId)}/dependencies`, undefined, true);
		return response?.dependencies || [];
	}

	upsertTaskDependency(input: BrainTaskDependencyUpsertInput): void {
		this.requestJson<{ dependency: BrainTaskDependencyRecord }>(
			"PUT",
			`/api/tasks/${encodeURIComponent(input.taskId)}/dependencies/${encodeURIComponent(input.dependsOnTaskId)}`,
			{
				dependencyType: input.dependencyType,
				autoDetected: input.autoDetected,
				reason: input.reason,
			},
		);
	}

	listArms(filters: BrainArmListFilters = {}): BrainArmRecord[] {
		const params = new URLSearchParams({ includeAll: "true" });
		const response = this.requestJson<{ arms: ApiArm[] }>(
			"GET",
			`/api/arms?${params.toString()}`,
		);

		let arms = (response?.arms || []).map((arm) => ({
			id: arm.id,
			name: arm.name,
			status: arm.status,
			currentTaskSubject: arm.currentTaskSubject || null,
			lastActivityAt: arm.lastActivityAt || null,
		}));

		if (!filters.includeStopped) {
			arms = arms.filter((arm) => arm.status !== "stopped");
		}
		if (filters.armId) {
			arms = arms.filter((arm) => arm.id === filters.armId);
		}

		return arms;
	}

	transaction<T>(fn: () => T): () => T {
		return () => fn();
	}

	close(): void {
		if (this.fallbackDb) {
			this.fallbackDb.close();
			this.fallbackDb = null;
		}
	}

	private parseTask(task: ApiTask): BrainTaskRecord {
		return {
			id: task.id,
			subject: task.subject,
			description: task.description,
			status: task.status,
			priority: task.priority,
			sourceType: task.sourceType,
			sourceRef: task.sourceRef ?? null,
			phase: task.phase ?? null,
			domain: task.domain ?? null,
			classification: task.classification ?? null,
			assignedTo: task.assignedTo ?? null,
			dependencyBlocked: task.dependencyBlocked === true,
		consensusStatus: task.consensusStatus ?? null,
		sortOrder: task.sortOrder ?? null,
		orderKey: task.orderKey ?? null,
		createdAt: task.createdAt,
			updatedAt: task.updatedAt,
			completedAt: task.completedAt ?? null,
			context: task.context,
		};
	}

	private parseBug(bug: ApiBug): BrainBugRecord {
		return {
			id: bug.id,
			title: bug.title,
			description: bug.description,
			source: bug.source,
			status: bug.status,
			priority: bug.priority,
			assigneeArmId: bug.assigneeArmId || null,
			errorDetails: bug.errorDetails || null,
			createdAt: bug.createdAt,
			updatedAt: bug.updatedAt,
		};
	}

	private parseDiscovery(discovery: ApiDiscovery): BrainDiscoveryRecord {
		return {
			id: discovery.id,
			armId: discovery.armId,
			armName: discovery.armName,
			kind: discovery.kind,
			title: discovery.title,
			details: discovery.details,
			filePath: discovery.filePath,
			lineNumber: discovery.lineNumber,
			severity: discovery.severity,
			status: discovery.status,
			taskId: discovery.taskId ?? null,
			phase: discovery.phase ?? null,
			createdAt: discovery.createdAt,
			updatedAt: discovery.updatedAt,
		};
	}

	private parseStatusReport(report: ApiStatusReport): BrainStatusReportRecord {
		return {
			id: report.id,
			taskId: report.taskId,
			armId: report.armId,
			status: report.status,
			summary: report.summary,
			issues: report.issues || [],
			blockers: report.blockers || [],
			nextSteps: report.nextSteps,
			filesChanged: report.filesChanged || [],
			testsStatus: report.testsStatus,
			createdAt: report.createdAt,
		};
	}

	private sortTasks(
		tasks: BrainTaskRecord[],
		sort: NonNullable<BrainTaskListFilters["sort"]>,
	): BrainTaskRecord[] {
		const rows = [...tasks];
		switch (sort) {
			case "created_asc":
				rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
				return rows;
			case "updated_desc":
				rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
				return rows;
			case "completed_desc":
				rows.sort((a, b) => {
					const left = a.completedAt || "";
					const right = b.completedAt || "";
					return right.localeCompare(left);
				});
				return rows;
			case "priority_then_created_asc":
				rows.sort((a, b) => {
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
				return rows;
		case "sort_order_asc":
			rows.sort((a, b) => {
				const left = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
				const right = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
				if (left !== right) {
					return left - right;
				}
				return a.createdAt.localeCompare(b.createdAt);
			});
			return rows;
		case "order_key_asc":
			rows.sort((a, b) => {
				if (a.orderKey === null && b.orderKey === null) {
					return a.createdAt.localeCompare(b.createdAt);
				}
				if (a.orderKey === null) {
					return 1;
				}
				if (b.orderKey === null) {
					return -1;
				}
				const diff = compareKeys(a.orderKey, b.orderKey);
				if (diff !== 0) {
					return diff;
				}
				return a.createdAt.localeCompare(b.createdAt);
			});
			return rows;
			case "created_desc":
			default:
				rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
				return rows;
		}
	}

	private requestSql<T>(
		operation: "run" | "get" | "all",
		sql: string,
		params: unknown[],
	): T {
		let result: CurlResult;
		try {
			result = this.curlRequest("POST", `/api/brain/internal/sql/${operation}`, {
				sql,
				params,
			});
		} catch (err) {
			if (this.allowLocalFallback) {
				return this.localRequest<T>(operation, sql, params);
			}
			throw err;
		}

		if (result.statusCode >= 400) {
			if (this.allowLocalFallback) {
				return this.localRequest<T>(operation, sql, params);
			}
			throw new Error(
				`MCP API DB request failed (${operation}) [${result.statusCode}]: ${result.body || "no response body"}`,
			);
		}

		if (!result.body) {
			throw new Error(
				`MCP API DB request failed (${operation}): empty response body`,
			);
		}

		let parsed: { data?: T };
		try {
			parsed = JSON.parse(result.body) as { data?: T };
		} catch (err) {
			if (this.allowLocalFallback) {
				return this.localRequest<T>(operation, sql, params);
			}
			throw new Error(
				`MCP API DB request failed (${operation}): invalid JSON response (${String(err)})`,
			);
		}

		if (!("data" in parsed)) {
			if (this.allowLocalFallback) {
				return this.localRequest<T>(operation, sql, params);
			}
			throw new Error(
				`MCP API DB request failed (${operation}): missing data field`,
			);
		}

		return parsed.data as T;
	}

	private requestJson<T>(
		method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
		path: string,
		body?: unknown,
		allowNotFound = false,
	): T | null {
		const result = this.curlRequest(method, path, body);
		if (allowNotFound && result.statusCode === 404) {
			return null;
		}
		if (result.statusCode >= 400) {
			throw new Error(
				`MCP API request failed (${method} ${path}) [${result.statusCode}]: ${result.body || "no response body"}`,
			);
		}
		if (!result.body) {
			throw new Error(
				`MCP API request failed (${method} ${path}): empty response body`,
			);
		}
		try {
			return JSON.parse(result.body) as T;
		} catch (err) {
			throw new Error(
				`MCP API request failed (${method} ${path}): invalid JSON (${String(err)})`,
			);
		}
	}

	private curlRequest(
		method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
		path: string,
		body?: unknown,
	): CurlResult {
		const url = `${this.baseUrl}${path}`;
		const args = [
			"-sS",
			"--globoff",
			"-X",
			method,
			url,
			"-H",
			"Content-Type: application/json",
			"-H",
			`X-API-Key: ${this.apiKey}`,
			"-w",
			"\\n__HTTP_STATUS__:%{http_code}",
		];

		if (body !== undefined) {
			args.push("--data", JSON.stringify(body));
		}

		const result = spawnSync("curl", args, { encoding: "utf8" });
		if (result.status !== 0) {
			throw new Error(
				`MCP API request failed (${method} ${path}): ${result.stderr || "unknown error"}`,
			);
		}

		const output = result.stdout || "";
		const marker = "\n__HTTP_STATUS__:";
		const markerIndex = output.lastIndexOf(marker);
		if (markerIndex === -1) {
			throw new Error(
				`MCP API request failed (${method} ${path}): malformed response`,
			);
		}

		const responseBody = output.slice(0, markerIndex).trim();
		const statusCode = Number(output.slice(markerIndex + marker.length).trim());
		if (!Number.isFinite(statusCode)) {
			throw new Error(
				`MCP API request failed (${method} ${path}): invalid status code`,
			);
		}

		return { statusCode, body: responseBody };
	}

	private localRequest<T>(
		operation: "run" | "get" | "all",
		sql: string,
		params: unknown[],
	): T {
		const db = this.getFallbackDb();
		if (operation === "run") {
			const result = db.run(sql, params as never[]);
			return {
				changes: result.changes,
				lastInsertRowid:
					typeof result.lastInsertRowid === "bigint"
						? Number(result.lastInsertRowid)
						: (result.lastInsertRowid ?? null),
			} as T;
		}

		if (operation === "get") {
			const bindings = params as any[];
			return (db.query(sql).get(...bindings) ?? null) as T;
		}

		const bindings = params as any[];
		return db.query(sql).all(...bindings) as T;
	}

	private getFallbackDb(): Database {
		if (!this.fallbackDb) {
			const dbPath = process.env.COLEO_DB_PATH || join(getColeoDir(), "coleo.db");
			this.fallbackDb = new Database(dbPath);
		}
		return this.fallbackDb;
	}
}

export function createApiDatabase(baseUrl: string, apiKey: string): ApiDatabase {
	return new ApiDatabase(baseUrl, apiKey);
}
