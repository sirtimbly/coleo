/**
 * DocUpdateTracker Tests
 *
 * Tests API-backed doc tracking behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { DocUpdateTracker } from "../doc-tracker";
import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";

type TriggerType = "phase_complete" | "threshold" | "human_request" | "periodic";
type UpdateStatus = "pending" | "in_progress" | "completed" | "failed";

interface FileChangeRow {
  filePath: string;
  changeType: string;
  changedAt: string;
}

interface DocUpdateRow {
  id: string;
  taskId: string | null;
  triggerType: TriggerType;
  filesReviewed: number;
  docsUpdated: number;
  futureWorkNotesAdded: number;
  status: UpdateStatus;
  startedAt: string;
  completedAt?: string;
  metadata?: Record<string, unknown>;
}

describe("DocUpdateTracker", () => {
  let tracker: DocUpdateTracker;
  let testDir: string;
  let coleoDir: string;
  let fileChanges: FileChangeRow[];
  let docUpdates: DocUpdateRow[];
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    testDir = join("/tmp", `coleo-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    coleoDir = join(testDir, ".coleo");
    await mkdir(coleoDir, { recursive: true });

    await writeFile(
      join(coleoDir, "config.toml"),
      [
        "version = 1",
        "",
        "[docs]",
        "update_file_threshold = 10",
        "update_poll_interval = 10",
        "update_enabled = true",
        "",
      ].join("\n"),
      "utf-8",
    );

    fileChanges = [];
    docUpdates = [];

    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const requestUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const url = new URL(requestUrl);
      const method = (init?.method || "GET").toUpperCase();
      const path = url.pathname;

      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "Content-Type": "application/json" },
        });

      if (method === "GET" && path === "/api/brain/internal/doc-updates/last-completed") {
        const completed = docUpdates
          .filter((row) => row.status === "completed" && row.completedAt)
          .sort((a, b) => (a.completedAt! < b.completedAt! ? 1 : -1))[0];
        return json({ completedAt: completed?.completedAt || null });
      }

      if (method === "GET" && path === "/api/brain/internal/file-changes/count") {
        const since = url.searchParams.get("since");
        if (!since) return json({ error: "since is required" }, 400);
        const count = fileChanges.filter((row) => row.changedAt > since).length;
        return json({ count });
      }

      if (method === "GET" && path === "/api/brain/internal/file-changes/since") {
        const since = url.searchParams.get("since");
        const limit = Number(url.searchParams.get("limit") || "1000");
        if (!since) return json({ error: "since is required" }, 400);

        const files = fileChanges
          .filter((row) => row.changedAt > since)
          .sort((a, b) => (a.changedAt < b.changedAt ? 1 : -1))
          .map((row) => row.filePath)
          .filter((value, index, arr) => arr.indexOf(value) === index)
          .slice(0, limit);
        return json({ files });
      }

      if (method === "POST" && path === "/api/brain/internal/doc-updates") {
        const body = JSON.parse(String(init?.body || "{}")) as {
          id: string;
          taskId: string;
          triggerType: TriggerType;
        };
        docUpdates.push({
          id: body.id,
          taskId: body.taskId || null,
          triggerType: body.triggerType,
          filesReviewed: 0,
          docsUpdated: 0,
          futureWorkNotesAdded: 0,
          status: "pending",
          startedAt: new Date().toISOString(),
        });
        return json({ created: true, id: body.id });
      }

      if (method === "POST" && path.endsWith("/start")) {
        const id = decodeURIComponent(path.split("/").at(-2) || "");
        const row = docUpdates.find((update) => update.id === id);
        if (!row) return json({ error: "not found" }, 404);
        row.status = "in_progress";
        return json({ success: true });
      }

      if (method === "POST" && path.endsWith("/complete")) {
        const id = decodeURIComponent(path.split("/").at(-2) || "");
        const row = docUpdates.find((update) => update.id === id);
        if (!row) return json({ error: "not found" }, 404);
        const body = JSON.parse(String(init?.body || "{}")) as {
          filesReviewed: number;
          docsUpdated: number;
          futureWorkNotesAdded: number;
        };
        row.status = "completed";
        row.completedAt = new Date().toISOString();
        row.filesReviewed = body.filesReviewed;
        row.docsUpdated = body.docsUpdated;
        row.futureWorkNotesAdded = body.futureWorkNotesAdded;
        return json({ success: true });
      }

      if (method === "POST" && path.endsWith("/fail")) {
        const id = decodeURIComponent(path.split("/").at(-2) || "");
        const row = docUpdates.find((update) => update.id === id);
        if (!row) return json({ error: "not found" }, 404);
        const body = JSON.parse(String(init?.body || "{}")) as { error?: string };
        row.status = "failed";
        row.completedAt = new Date().toISOString();
        row.metadata = { error: body.error || "Unknown error" };
        return json({ success: true });
      }

      if (method === "GET" && path === "/api/brain/internal/doc-updates/recent") {
        const limit = Number(url.searchParams.get("limit") || "10");
        const updates = [...docUpdates]
          .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
          .slice(0, limit)
          .map((row) => ({
            id: row.id,
            triggerType: row.triggerType,
            status: row.status,
            startedAt: row.startedAt,
            completedAt: row.completedAt,
          }));
        return json({ updates });
      }

      return json({ error: `Unhandled route: ${method} ${path}` }, 404);
    }) as unknown as typeof fetch;

    tracker = new DocUpdateTracker("http://127.0.0.1:18082", "test-key", coleoDir, testDir);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("getLastDocUpdateTime", () => {
    it("returns null when no doc updates exist", async () => {
      const result = await tracker.getLastDocUpdateTime();
      expect(result).toBeNull();
    });

    it("returns the completion time of the most recent completed update", async () => {
      docUpdates.push({
        id: "doc-1",
        taskId: "task-1",
        triggerType: "threshold",
        filesReviewed: 0,
        docsUpdated: 0,
        futureWorkNotesAdded: 0,
        status: "completed",
        startedAt: "2026-01-15T10:00:00Z",
        completedAt: "2026-01-15T10:30:00Z",
      });

      const result = await tracker.getLastDocUpdateTime();
      expect(result).not.toBeNull();
      expect(result!.toISOString()).toBe("2026-01-15T10:30:00.000Z");
    });

    it("ignores in-progress updates", async () => {
      docUpdates.push({
        id: "doc-1",
        taskId: "task-1",
        triggerType: "threshold",
        filesReviewed: 0,
        docsUpdated: 0,
        futureWorkNotesAdded: 0,
        status: "in_progress",
        startedAt: "2026-01-15T10:00:00Z",
      });

      const result = await tracker.getLastDocUpdateTime();
      expect(result).toBeNull();
    });
  });

  describe("countChangedFilesSince", () => {
    it("returns 0 when no files changed", async () => {
      const since = new Date("2026-01-01T00:00:00Z");
      const result = await tracker.countChangedFilesSince(since);
      expect(result).toBe(0);
    });

    it("counts files changed after the given time", async () => {
      fileChanges.push(
        { filePath: "src/a.ts", changeType: "modified", changedAt: "2026-01-15T10:00:00Z" },
        { filePath: "src/b.ts", changeType: "modified", changedAt: "2026-01-15T11:00:00Z" },
        { filePath: "src/c.ts", changeType: "created", changedAt: "2026-01-15T12:00:00Z" },
      );

      const since = new Date("2026-01-15T09:00:00Z");
      const result = await tracker.countChangedFilesSince(since);
      expect(result).toBe(3);
    });
  });

  describe("getChangedFilesSince", () => {
    it("returns empty array when no files changed", async () => {
      const since = new Date("2026-01-01T00:00:00Z");
      const result = await tracker.getChangedFilesSince(since);
      expect(result).toEqual([]);
    });

    it("returns list of changed files sorted by time descending", async () => {
      fileChanges.push(
        { filePath: "src/a.ts", changeType: "modified", changedAt: "2026-01-15T10:00:00Z" },
        { filePath: "src/b.ts", changeType: "modified", changedAt: "2026-01-15T11:00:00Z" },
        { filePath: "src/c.ts", changeType: "created", changedAt: "2026-01-15T12:00:00Z" },
      );

      const since = new Date("2026-01-15T09:00:00Z");
      const result = await tracker.getChangedFilesSince(since);
      expect(result).toEqual(["src/c.ts", "src/b.ts", "src/a.ts"]);
    });
  });

  describe("checkDocUpdateTrigger", () => {
    it("returns null when doc updates are disabled", async () => {
      await writeFile(
        join(coleoDir, "config.toml"),
        [
          "version = 1",
          "",
          "[docs]",
          "update_file_threshold = 10",
          "update_poll_interval = 10",
          "update_enabled = false",
          "",
        ].join("\n"),
        "utf-8",
      );

      const result = await tracker.checkDocUpdateTrigger();
      expect(result).toBeNull();
    });

    it("returns null when no previous update exists", async () => {
      const result = await tracker.checkDocUpdateTrigger();
      expect(result).toBeNull();
    });

    it("returns threshold trigger when enough files changed", async () => {
      for (let i = 0; i < 10; i++) {
        fileChanges.push({
          filePath: `src/file${i}.ts`,
          changeType: "modified",
          changedAt: "2026-01-15T10:00:00Z",
        });
      }

      docUpdates.push({
        id: "doc-1",
        taskId: "task-1",
        triggerType: "threshold",
        filesReviewed: 0,
        docsUpdated: 0,
        futureWorkNotesAdded: 0,
        status: "completed",
        startedAt: "2026-01-15T09:00:00Z",
        completedAt: "2026-01-15T09:30:00Z",
      });

      const result = await tracker.checkDocUpdateTrigger();
      expect(result).not.toBeNull();
      expect(result!.trigger).toBe("threshold");
      expect(result!.reason).toContain("10 files changed");
    });
  });

  describe("createDocUpdate", () => {
    it("creates a new doc update record", async () => {
      const id = await tracker.createDocUpdate("task-123", "threshold");
      expect(id).toMatch(/^doc-\d+-[a-z0-9]+$/);

      const row = docUpdates.find((update) => update.id === id);
      expect(row).toBeDefined();
      expect(row?.taskId).toBe("task-123");
      expect(row?.triggerType).toBe("threshold");
      expect(row?.status).toBe("pending");
    });
  });

  describe("startDocUpdate", () => {
    it("updates status to in_progress", async () => {
      const id = await tracker.createDocUpdate("task-123", "threshold");
      await tracker.startDocUpdate(id);

      const row = docUpdates.find((update) => update.id === id);
      expect(row?.status).toBe("in_progress");
    });
  });

  describe("completeDocUpdate", () => {
    it("updates status to completed with stats", async () => {
      const id = await tracker.createDocUpdate("task-123", "threshold");
      await tracker.startDocUpdate(id);

      await tracker.completeDocUpdate(id, 15, 3, 2);

      const row = docUpdates.find((update) => update.id === id);
      expect(row?.status).toBe("completed");
      expect(row?.filesReviewed).toBe(15);
      expect(row?.docsUpdated).toBe(3);
      expect(row?.futureWorkNotesAdded).toBe(2);
      expect(row?.completedAt).toBeDefined();
    });
  });

  describe("getRecentDocUpdates", () => {
    it("returns empty array when no updates", async () => {
      const result = await tracker.getRecentDocUpdates(10);
      expect(result).toEqual([]);
    });

    it("returns recent updates sorted by start time", async () => {
      docUpdates.push(
        {
          id: "doc-1",
          taskId: "task-1",
          triggerType: "periodic",
          filesReviewed: 0,
          docsUpdated: 0,
          futureWorkNotesAdded: 0,
          status: "completed",
          startedAt: "2026-01-15T10:00:00Z",
        },
        {
          id: "doc-2",
          taskId: "task-2",
          triggerType: "threshold",
          filesReviewed: 0,
          docsUpdated: 0,
          futureWorkNotesAdded: 0,
          status: "in_progress",
          startedAt: "2026-01-15T11:00:00Z",
        },
        {
          id: "doc-3",
          taskId: "task-3",
          triggerType: "human_request",
          filesReviewed: 0,
          docsUpdated: 0,
          futureWorkNotesAdded: 0,
          status: "pending",
          startedAt: "2026-01-15T12:00:00Z",
        },
      );

      const result = await tracker.getRecentDocUpdates(10);
      expect(result.length).toBe(3);
      expect(result[0]?.triggerType).toBe("human_request");
      expect(result[1]?.triggerType).toBe("threshold");
      expect(result[2]?.triggerType).toBe("periodic");
    });

    it("limits results by count", async () => {
      docUpdates.push(
        {
          id: "doc-1",
          taskId: "task-1",
          triggerType: "periodic",
          filesReviewed: 0,
          docsUpdated: 0,
          futureWorkNotesAdded: 0,
          status: "completed",
          startedAt: "2026-01-15T10:00:00Z",
        },
        {
          id: "doc-2",
          taskId: "task-2",
          triggerType: "threshold",
          filesReviewed: 0,
          docsUpdated: 0,
          futureWorkNotesAdded: 0,
          status: "completed",
          startedAt: "2026-01-15T11:00:00Z",
        },
        {
          id: "doc-3",
          taskId: "task-3",
          triggerType: "human_request",
          filesReviewed: 0,
          docsUpdated: 0,
          futureWorkNotesAdded: 0,
          status: "completed",
          startedAt: "2026-01-15T12:00:00Z",
        },
      );

      const result = await tracker.getRecentDocUpdates(2);
      expect(result.length).toBe(2);
    });
  });

  describe("generateFutureWorkNote", () => {
    it("generates a complete future work note", () => {
      const note = tracker.generateFutureWorkNote("OAuth2 Authentication", "Implement OAuth2 provider with GitHub and Google", "Phase 3");

      expect(note).toContain("## OAuth2 Authentication");
      expect(note).toContain("**Status**: Planned for Phase 3");
      expect(note).toContain("**Details**: Implement OAuth2 provider with GitHub and Google");
      expect(note).toContain("not yet implemented");
    });

    it("handles missing phase gracefully", () => {
      const note = tracker.generateFutureWorkNote("Feature X", "Description here");

      expect(note).toContain("**Status**: Planned");
      expect(note).not.toContain("Phase");
    });
  });

  describe("generatePartialImplementationNote", () => {
    it("generates a partial implementation note", () => {
      const note = tracker.generatePartialImplementationNote(
        "User API",
        ["GET /users", "POST /users"],
        ["PUT /users/:id", "DELETE /users/:id"],
      );

      expect(note).toContain("## User API");
      expect(note).toContain("**Status**: Partial Implementation");
      expect(note).toContain("**Implemented**: GET /users, POST /users");
      expect(note).toContain("**Pending**: PUT /users/:id, DELETE /users/:id");
    });
  });
});
