import { spawnSync } from "child_process";
import type { BrainDb, DbQueryHandle, DbRunResult } from "./db-client";

interface ArmStateRow {
  arm_id: string;
  state: string;
  previous_state: string | null;
  current_task_id: string | null;
  current_task_subject: string | null;
  last_event_type: string | null;
  last_event_at: string;
  state_entered_at: string;
  task_assigned_at: string | null;
  disconnected_at: string | null;
  last_error: string | null;
  error_count: number;
  last_heartbeat: string | null;
  consecutive_missed_heartbeats: number;
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toUpperCase();
}

function toParams(bindings: unknown[]): unknown[] {
  if (Array.isArray(bindings[0]) && bindings.length === 1) {
    return bindings[0] as unknown[];
  }
  return bindings;
}

export class ArmStateApiDatabase implements BrainDb {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  run(sql: string, ...bindings: unknown[]): DbRunResult {
    const normalized = normalizeSql(sql);
    const params = toParams(bindings);

    if (normalized.startsWith("INSERT INTO ARM_STATE_MACHINE")) {
      const [armId, state, lastEventAt, stateEnteredAt] = params;
      this.request<{ stored?: boolean }>(
        "PUT",
        `/api/brain/internal/arm-state/${encodeURIComponent(String(armId ?? ""))}`,
        {
          state: String(state ?? "spawning"),
          lastEventAt: String(lastEventAt ?? new Date().toISOString()),
          stateEnteredAt: String(stateEnteredAt ?? new Date().toISOString()),
          errorCount: 0,
          consecutiveMissedHeartbeats: 0,
          currentTaskId: null,
          currentTaskSubject: null,
          lastError: null,
        },
      );
      return { changes: 1, lastInsertRowid: null };
    }

    if (normalized.startsWith("UPDATE ARM_STATE_MACHINE SET")) {
      const [
        state,
        previousState,
        currentTaskId,
        currentTaskSubject,
        lastEventType,
        lastEventAt,
        stateEnteredAt,
        taskAssignedAt,
        disconnectedAt,
        lastError,
        errorCount,
        lastHeartbeat,
        consecutiveMissedHeartbeats,
        armId,
      ] = params;

      this.request<{ stored?: boolean }>(
        "PUT",
        `/api/brain/internal/arm-state/${encodeURIComponent(String(armId ?? ""))}`,
        {
          state,
          previousState,
          currentTaskId,
          currentTaskSubject,
          lastEventType,
          lastEventAt,
          stateEnteredAt,
          taskAssignedAt,
          disconnectedAt,
          lastError,
          errorCount,
          lastHeartbeat,
          consecutiveMissedHeartbeats,
        },
      );
      return { changes: 1, lastInsertRowid: null };
    }

    if (normalized === "DELETE FROM ARM_STATE_MACHINE WHERE ARM_ID = ?") {
      const [armId] = params;
      this.request<{ deleted?: boolean }>(
        "DELETE",
        `/api/brain/internal/arm-state/${encodeURIComponent(String(armId ?? ""))}`,
      );
      return { changes: 1, lastInsertRowid: null };
    }

    throw new Error(`Unsupported run SQL in ArmStateApiDatabase: ${sql}`);
  }

  query(sql: string): DbQueryHandle {
    const normalized = normalizeSql(sql);

    if (normalized === "SELECT * FROM ARM_STATE_MACHINE WHERE ARM_ID = ?") {
      return {
        get: (...bindings: unknown[]) => {
          const [armId] = toParams(bindings);
          const response = this.request<{ state: ArmStateRow | null }>(
            "GET",
            `/api/brain/internal/arm-state/${encodeURIComponent(String(armId ?? ""))}`,
          );
          return response.state;
        },
        all: () => {
          throw new Error("Unsupported all() for arm_id query");
        },
      };
    }

    if (normalized === "SELECT * FROM ARM_STATE_MACHINE WHERE STATE = ?") {
      return {
        get: () => {
          throw new Error("Unsupported get() for state query");
        },
        all: (...bindings: unknown[]) => {
          const [state] = toParams(bindings);
          const params = new URLSearchParams({ state: String(state ?? "") });
          const response = this.request<{ states: ArmStateRow[] }>(
            "GET",
            `/api/brain/internal/arm-state?${params.toString()}`,
          );
          return response.states ?? [];
        },
      };
    }

    throw new Error(`Unsupported query SQL in ArmStateApiDatabase: ${sql}`);
  }

  transaction<T>(fn: () => T): () => T {
    return () => fn();
  }

  close(): void {
    // No-op
  }

  private request<T>(
    method: "GET" | "PUT" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
  ): T {
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
      throw new Error(`Arm state API request failed: ${result.stderr || "unknown error"}`);
    }

    const output = result.stdout || "";
    const marker = "\n__HTTP_STATUS__:";
    const markerIndex = output.lastIndexOf(marker);
    if (markerIndex === -1) {
      throw new Error("Arm state API request failed: malformed response");
    }

    const bodyText = output.slice(0, markerIndex).trim();
    const statusCode = Number(output.slice(markerIndex + marker.length).trim());

    if (!Number.isFinite(statusCode)) {
      throw new Error("Arm state API request failed: invalid status");
    }
    if (statusCode >= 400) {
      throw new Error(`Arm state API request failed [${statusCode}]: ${bodyText || "no response body"}`);
    }

    if (!bodyText) {
      throw new Error("Arm state API request failed: empty response body");
    }

    return JSON.parse(bodyText) as T;
  }
}

export function createArmStateApiDatabase(baseUrl: string, apiKey: string): ArmStateApiDatabase {
  return new ArmStateApiDatabase(baseUrl, apiKey);
}
