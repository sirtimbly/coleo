import { spawnSync } from "child_process";
import { Database } from "bun:sqlite";
import { join } from "path";
import { getColeoDir } from "../config";

export interface McpDbRunResult {
	changes: number;
	lastInsertRowid: number | null;
}

export interface McpDbQueryHandle {
	get: (...params: unknown[]) => unknown;
	all: (...params: unknown[]) => unknown[];
}

export interface McpDb {
	run: (sql: string, ...bindings: unknown[]) => McpDbRunResult;
	query: (sql: string) => McpDbQueryHandle;
	transaction?: <T>(fn: () => T) => () => T;
	close?: () => void;
}

export class ApiDatabase implements McpDb {
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
		return this.request<McpDbRunResult>("run", sql, params);
	}

	query(sql: string): McpDbQueryHandle {
		return {
			get: (...params: unknown[]) => this.request<unknown | null>("get", sql, params),
			all: (...params: unknown[]) => this.request<unknown[]>("all", sql, params),
		};
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

	private request<T>(
		operation: "run" | "get" | "all",
		sql: string,
		params: unknown[],
	): T {
		const url = `${this.baseUrl}/api/brain/internal/sql/${operation}`;
		const payload = JSON.stringify({ sql, params });

		const result = spawnSync(
			"curl",
			[
				"-sS",
				"--globoff",
				"-X",
				"POST",
				url,
				"-H",
				"Content-Type: application/json",
				"-H",
				`X-API-Key: ${this.apiKey}`,
				"--data",
				payload,
				"-w",
				"\\n__HTTP_STATUS__:%{http_code}",
			],
			{ encoding: "utf8" },
		);

		if (result.status !== 0) {
			if (this.allowLocalFallback) {
				return this.localRequest<T>(operation, sql, params);
			}
			throw new Error(
				`MCP API DB request failed (${operation}): ${result.stderr || "unknown error"}`,
			);
		}

		const output = result.stdout || "";
		const marker = "\n__HTTP_STATUS__:";
		const markerIndex = output.lastIndexOf(marker);

		if (markerIndex === -1) {
			throw new Error(
				`MCP API DB request failed (${operation}): malformed response`,
			);
		}

		const body = output.slice(0, markerIndex).trim();
		const statusCode = Number(output.slice(markerIndex + marker.length).trim());

		if (!Number.isFinite(statusCode)) {
			throw new Error(
				`MCP API DB request failed (${operation}): invalid status code`,
			);
		}

		if (statusCode >= 400) {
			throw new Error(
				`MCP API DB request failed (${operation}) [${statusCode}]: ${body || "no response body"}`,
			);
		}

		if (!body) {
			throw new Error(
				`MCP API DB request failed (${operation}): empty response body`,
			);
		}

		let parsed: { data?: T };
		try {
			parsed = JSON.parse(body) as { data?: T };
		} catch (err) {
			throw new Error(
				`MCP API DB request failed (${operation}): invalid JSON response (${String(err)})`,
			);
		}

		if (!("data" in parsed)) {
			throw new Error(
				`MCP API DB request failed (${operation}): missing data field`,
			);
		}

		return parsed.data as T;
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
