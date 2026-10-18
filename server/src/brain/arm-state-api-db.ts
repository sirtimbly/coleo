import { spawnSync } from "child_process";

import type { ArmStateRecord, ArmStateStore, ArmStateUpsertInput } from "./db-client";

interface ArmStateByIdResponse {
  state: ArmStateRecord | null;
}

interface ArmStatesResponse {
  states: ArmStateRecord[];
}

export class ArmStateApiDatabase implements ArmStateStore {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  getArmState(armId: string): ArmStateRecord | null {
    const response = this.request<ArmStateByIdResponse>(
      "GET",
      `/api/brain/internal/arm-state/${encodeURIComponent(armId)}`,
    );
    return response.state;
  }

  listArmStatesByState(state: string): ArmStateRecord[] {
    const params = new URLSearchParams({ state });
    const response = this.request<ArmStatesResponse>(
      "GET",
      `/api/brain/internal/arm-state?${params.toString()}`,
    );
    return response.states ?? [];
  }

  upsertArmState(armId: string, input: ArmStateUpsertInput): void {
    this.request<{ stored?: boolean }>(
      "PUT",
      `/api/brain/internal/arm-state/${encodeURIComponent(armId)}`,
      input,
    );
  }

  deleteArmState(armId: string): void {
    this.request<{ deleted?: boolean }>(
      "DELETE",
      `/api/brain/internal/arm-state/${encodeURIComponent(armId)}`,
    );
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
    body?: unknown,
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

export function createArmStateApiDatabase(
  baseUrl: string,
  apiKey: string,
): ArmStateApiDatabase {
  return new ArmStateApiDatabase(baseUrl, apiKey);
}
