import { spawnSync } from "child_process";
import type { BrainDb, DbQueryHandle } from "./db-client";

export interface ApiRunResult {
  changes: number;
  lastInsertRowid: number | null;
}

export interface ApiQueryHandle {
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
}

export class ApiDatabase implements BrainDb {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  run(sql: string, ...bindings: unknown[]): ApiRunResult {
    const params = Array.isArray(bindings[0]) && bindings.length === 1
      ? (bindings[0] as unknown[])
      : bindings;
    return this.request<ApiRunResult>("run", sql, params);
  }

  query(sql: string): DbQueryHandle {
    return {
      get: (...params: unknown[]) => this.request<unknown | null>("get", sql, params),
      all: (...params: unknown[]) => this.request<unknown[]>("all", sql, params),
    };
  }

  // Compatibility with bun:sqlite transaction() usage in helper utilities.
  transaction<T>(fn: () => T): () => T {
    return () => fn();
  }

  close(): void {
    // No-op: API-backed database has no local handle.
  }

  private request<T>(operation: "run" | "get" | "all", sql: string, params: unknown[]): T {
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
      throw new Error(`API DB request failed (${operation}): ${result.stderr || "unknown error"}`);
    }

    const output = result.stdout || "";
    const marker = "\n__HTTP_STATUS__:";
    const markerIndex = output.lastIndexOf(marker);

    if (markerIndex === -1) {
      throw new Error(`API DB request failed (${operation}): malformed response`);
    }

    const body = output.slice(0, markerIndex).trim();
    const statusCode = Number(output.slice(markerIndex + marker.length).trim());

    if (!Number.isFinite(statusCode)) {
      throw new Error(`API DB request failed (${operation}): invalid status code`);
    }

    if (statusCode >= 400) {
      throw new Error(`API DB request failed (${operation}) [${statusCode}]: ${body || "no response body"}`);
    }

    if (!body) {
      throw new Error(`API DB request failed (${operation}): empty response body`);
    }

    let parsed: { data?: T };
    try {
      parsed = JSON.parse(body) as { data?: T };
    } catch (err) {
      throw new Error(`API DB request failed (${operation}): invalid JSON response (${String(err)})`);
    }

    if (!("data" in parsed)) {
      throw new Error(`API DB request failed (${operation}): missing data field`);
    }

    return parsed.data as T;
  }
}

export function createApiDatabase(baseUrl: string, apiKey: string): ApiDatabase {
  return new ApiDatabase(baseUrl, apiKey);
}
