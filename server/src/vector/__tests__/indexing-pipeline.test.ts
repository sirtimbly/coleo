import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { qdrantStore } from "../../qdrant";
import { embeddingService } from "../../embedding";
import type { StatusHistoryEvent } from "../status-history";
import { STATUS_HISTORY_CONFIG } from "../status-history";
import { indexStatusHistoryEvent, searchStatusHistory } from "../indexing-pipeline";
import { getProjectScope } from "../../project-scope";

describe("status-history indexing pipeline", () => {
  const sampleEvent: StatusHistoryEvent = {
    id: "evt-abc",
    type: "status_report",
    timestamp: "2026-07-20T10:00:00.000Z",
    source: "arm-1",
    title: "Status update",
    content: "Indexing event complete payload",
    taskId: "task-88",
    armId: "arm-1",
    status: "blocked",
    priority: "medium",
    classification: "engineering",
    metadata: {
      sourceEventId: "task-88",
      nested: {
        stage: "search",
        details: "full context",
      },
    },
  };

  let embedSpy: ReturnType<typeof spyOn> | null = null;
  let upsertSpy: ReturnType<typeof spyOn> | null = null;
  let searchSpy: ReturnType<typeof spyOn> | null = null;

  afterEach(() => {
    embedSpy?.mockRestore();
    upsertSpy?.mockRestore();
    searchSpy?.mockRestore();
    embedSpy = null;
    upsertSpy = null;
    searchSpy = null;
  });

  it("stores a complete event object in Qdrant payload", async () => {
    embedSpy = spyOn(embeddingService, "embed").mockImplementation(async () => ({
      embedding: [0.01, 0.02, 0.03],
      model: "mock-model",
    }));
    upsertSpy = spyOn(qdrantStore, "upsertPoints").mockImplementation(async () => {});

    await indexStatusHistoryEvent(sampleEvent);

    expect(embedSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    const payload = upsertSpy.mock.calls[0]?.[1]?.[0]?.payload;
    expect(payload?.type).toBe(sampleEvent.type);
    expect(payload?.timestamp).toBe(sampleEvent.timestamp);
    expect(payload?.event).toMatchObject({
      ...sampleEvent,
      projectDir: getProjectScope().projectDir,
      projectKey: getProjectScope().projectKey,
    });
    expect(payload?.metadata).toEqual(sampleEvent.metadata);
    expect(payload?.projectDir).toBe(getProjectScope().projectDir);
    expect(payload?.projectKey).toBe(getProjectScope().projectKey);
    expect(upsertSpy.mock.calls[0]?.[0]).toBe(STATUS_HISTORY_CONFIG.collectionName);
  });

  it("reconstructs events from stored embedded payload", async () => {
    embedSpy = spyOn(embeddingService, "embed").mockImplementation(async () => ({
      embedding: [0.2, 0.3],
      model: "mock-model",
    }));
    searchSpy = spyOn(qdrantStore, "search").mockImplementation(async () => [
      {
        id: sampleEvent.id,
        score: 0.91,
        payload: {
          event: sampleEvent,
          type: "status_report",
          timestamp: "2026-07-20T10:00:00.000Z",
          source: "arm-1",
          title: "should not be used",
          content: "fallback text",
        },
      },
    ]);

    const results = await searchStatusHistory("search payload");

    expect(embedSpy).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0]?.event).toEqual(sampleEvent);
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy.mock.calls[0]?.[0]).toBe(STATUS_HISTORY_CONFIG.collectionName);
  });

  it("uses fallback id when embedded event omits id", async () => {
    const { id: _id, ...fallbackEvent } = sampleEvent;

    embedSpy = spyOn(embeddingService, "embed").mockImplementation(async () => ({
      embedding: [0.2, 0.3],
      model: "mock-model",
    }));
    searchSpy = spyOn(qdrantStore, "search").mockImplementation(async () => [
      {
        id: sampleEvent.id,
        score: 0.91,
        payload: {
          event: fallbackEvent,
          type: "status_report",
          timestamp: "2026-07-20T10:00:00.000Z",
          source: "arm-1",
          title: "should not be used",
          content: "fallback text",
        },
      },
    ]);

    const results = await searchStatusHistory("search payload");

    expect(results[0]?.event.id).toBe(sampleEvent.id);
  });

  it("falls back to flattened payload fields when complete event is missing", async () => {
    embedSpy = spyOn(embeddingService, "embed").mockImplementation(async () => ({
      embedding: [0.2, 0.3],
      model: "mock-model",
    }));
    searchSpy = spyOn(qdrantStore, "search").mockImplementation(async () => [
      {
        id: sampleEvent.id,
        score: 0.75,
        payload: {
          type: "bug_report",
          timestamp: "2026-07-20T10:00:00.000Z",
          source: "arm-1",
          title: "Fallback title",
          content: "Fallback content",
          bugId: "bug-7",
          metadata: { severity: "high" },
        },
      },
    ]);

    const results = await searchStatusHistory("search payload");

    expect(results[0]?.event).toMatchObject({
      id: sampleEvent.id,
      type: "bug_report",
      title: "Fallback title",
      content: "Fallback content",
      bugId: "bug-7",
      metadata: { severity: "high" },
    });
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(embedSpy).toHaveBeenCalledTimes(1);
  });
});
