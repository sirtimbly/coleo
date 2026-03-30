import { describe, expect, it } from "bun:test";

import { Brain } from "../brain";
import type { Arm } from "../../types";
import type { StuckAnalysis } from "../activity-types";

describe("Brain manual stuck requests", () => {
  it("turns a manual stuck request into a prompt-style intervention on the next poll", async () => {
    const brain = new Brain({
      coleoDir: "/tmp",
      pollIntervalMs: 1000,
      verbose: false,
    });

    const arm: Arm = {
      id: "arm-alpha",
      name: "arm-alpha",
      agent: "opencode-api",
      status: "busy",
      startedAt: new Date(),
    };

    (brain as unknown as { arms: Map<string, Arm> }).arms = new Map([
      [arm.id, arm],
    ]);
    (brain as unknown as { tasks: Array<{ id: string; subject: string }> }).tasks = [];

    const apiCalls: string[] = [];
    (brain as unknown as {
      apiRequest: <T>(path: string, options?: RequestInit, timeoutMs?: number) => Promise<T>;
    }).apiRequest = async <T>(path: string) => {
      apiCalls.push(path);
      if (path === "/api/arms/stuck-requests") {
        return {
          requests: [
            {
              id: 42,
              armId: "arm-alpha",
              reason: "Waiting around with no visible progress",
              requestedBy: "watch",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        } as T;
      }
      if (path === "/api/arms/stuck-requests/42/resolve") {
        return { success: true } as T;
      }
      if (path === "/api/activity") {
        return {} as T;
      }
      throw new Error(`Unexpected apiRequest path: ${path}`);
    };

    (brain as unknown as {
      readArmLogs: (armName: string, lines?: number) => Promise<string>;
    }).readArmLogs = async () => "";

    (brain as unknown as {
      stuckArmAnalyzer: { analyze: () => Promise<StuckAnalysis> };
    }).stuckArmAnalyzer = {
      analyze: async () => ({
        isStuck: false,
        reasoning: "No clear stuck signal",
        confidence: 0.1,
      }),
    };

    let handled: StuckAnalysis | null = null;
    (brain as unknown as {
      handleStuckArm: (targetArm: Arm, analysis: StuckAnalysis) => Promise<void>;
    }).handleStuckArm = async (_targetArm, analysis) => {
      handled = analysis;
    };

    await (
      brain as unknown as { processManualStuckRequests: () => Promise<void> }
    ).processManualStuckRequests();

    expect(handled).not.toBeNull();
    if (!handled) {
      throw new Error("Expected manual stuck request to produce an analysis");
    }
    const handledAnalysis: StuckAnalysis = handled;
    expect(handledAnalysis.isStuck).toBe(true);
    expect(handledAnalysis.suggestedAction).toBe("prompt");
    expect(handledAnalysis.suggestedResponse).toContain("Human operator marked this arm as stuck");
    expect(apiCalls).toContain("/api/arms/stuck-requests/42/resolve");
  });
});
