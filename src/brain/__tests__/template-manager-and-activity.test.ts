import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { Brain } from "../brain";
import { BrainTemplateManager } from "../template-manager";

describe("Brain template manager", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join("/tmp", `coleo-brain-template-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const templateDir = join(testDir, "src", "brain", "templates");
    await mkdir(templateDir, { recursive: true });
    await writeFile(join(templateDir, "test-template.jinja"), "Hello {{ name }}!", "utf-8");
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("renders a nunjucks template with context", async () => {
    const templates = new BrainTemplateManager(testDir, () => {});
    const result = await templates.renderTemplate("test-template.jinja", { name: "Octopai" });

    expect(result).toBe("Hello Octopai!");
  });

  it("copies every packaged Brain prompt without overwriting local edits", async () => {
    const templates = new BrainTemplateManager(testDir, () => {});
    const promptPath = join(testDir, "src", "brain", "templates", "arm-prompt-complete-task.jinja");

    await templates.ensureTemplatesExist();
    expect((await readFile(promptPath, "utf-8")).length).toBeGreaterThan(0);

    await writeFile(promptPath, "custom prompt", "utf-8");
    await templates.ensureTemplatesExist();
    expect(await readFile(promptPath, "utf-8")).toBe("custom prompt");
  });
});

describe("Brain activity API reads", () => {
  let testDir: string;
  let calls: Array<{ actor: string; limit: number }> = [];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    testDir = join("/tmp", `coleo-brain-nats-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    calls = [];

    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const parsed = new URL(url);
      if (parsed.pathname === "/api/activity") {
        const actor = parsed.searchParams.get("actor") || "";
        const limit = Number(parsed.searchParams.get("limit") || "0");
        calls.push({ actor, limit });

        const now = Date.now();
        return new Response(JSON.stringify({
          activity: [
            {
              timestamp: new Date(now - 2 * 60 * 1000).toISOString(),
              actor,
              action: "heartbeat",
              details: { ok: true },
            },
            {
              timestamp: new Date(now - 30 * 1000).toISOString(),
              actor,
              action: "tool_call",
              details: { tool: "rg" },
            },
            {
              timestamp: new Date(now - 90 * 1000).toISOString(),
              actor,
              action: "file_changed",
              details: { path: "src/a.ts" },
            },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("reads recent arm events from the API and transforms them", async () => {
    const brain = new Brain({
      coleoDir: testDir,
      pollIntervalMs: 1000,
      verbose: false,
      apiBaseUrl: "http://localhost:8080",
      apiKey: "test-key",
    });

    const result = await (brain as unknown as { getRecentArmActivity: (armId: string, minutes: number) => Promise<Array<{timestamp: string; action: string; details: string}> | null> })
      .getRecentArmActivity("arm-1", 5);

    expect(calls).toEqual([{ actor: "arm-1", limit: 100 }]);
    expect(result).toBeTruthy();
    expect(result!.length).toBe(3);

    // Sorted descending by timestamp
    expect(result![0]?.action).toBe("tool_call");
    expect(result![1]?.action).toBe("file_changed");
    expect(result![2]?.action).toBe("heartbeat");

    // Data serialized to details
    expect(result![0]?.details).toContain("\"tool\":\"rg\"");

    brain.stop();
  });
});
