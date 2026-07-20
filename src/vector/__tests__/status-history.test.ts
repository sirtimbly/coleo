import { describe, expect, it } from "bun:test";
import {
  type StatusHistoryEvent,
  STATUS_HISTORY_CONFIG,
  eventToText,
  createEventId,
} from "../status-history";

describe("status-history", () => {
  describe("STATUS_HISTORY_CONFIG", () => {
    it("should have correct collection name", () => {
      expect(STATUS_HISTORY_CONFIG.collectionName).toBe("status-history");
    });

    it("should have correct vector size for OpenAI embeddings", () => {
      expect(STATUS_HISTORY_CONFIG.vectorSize).toBe(1536);
    });

    it("should use Cosine distance", () => {
      expect(STATUS_HISTORY_CONFIG.distance).toBe("Cosine");
    });

    it("should have filter fields defined", () => {
      expect(STATUS_HISTORY_CONFIG.filterFields).toContain("type");
      expect(STATUS_HISTORY_CONFIG.filterFields).toContain("source");
      expect(STATUS_HISTORY_CONFIG.filterFields).toContain("timestamp");
    });
  });

  describe("eventToText", () => {
    it("should combine title and content", () => {
      const event: StatusHistoryEvent = {
        id: "test-1",
        type: "status_report",
        timestamp: new Date().toISOString(),
        source: "arm-1",
        title: "Task Progress",
        content: "Completed 50% of the work",
        metadata: {},
      };

      const text = eventToText(event);
      expect(text).toContain("Task Progress");
      expect(text).toContain("Completed 50% of the work");
      expect(text).toContain("status_report");
      expect(text).toContain("arm-1");
    });

    it("should include status if present", () => {
      const event: StatusHistoryEvent = {
        id: "test-2",
        type: "status_report",
        timestamp: new Date().toISOString(),
        source: "arm-1",
        title: "Progress Update",
        content: "Working on feature X",
        status: "on_track",
        metadata: {},
      };

      const text = eventToText(event);
      expect(text).toContain("Status: on_track");
    });

    it("should include priority if present", () => {
      const event: StatusHistoryEvent = {
        id: "test-3",
        type: "task_completion",
        timestamp: new Date().toISOString(),
        source: "system",
        title: "Task Done",
        content: "Completed the task",
        priority: "high",
        metadata: {},
      };

      const text = eventToText(event);
      expect(text).toContain("Priority: high");
    });

    it("should serialize the complete event deterministically", () => {
      const event: StatusHistoryEvent = {
        id: "event-1",
        type: "bug_report",
        timestamp: "2026-07-20T18:00:00.000Z",
        source: "arm-1",
        title: "Indexer failed",
        content: "Qdrant rejected the point",
        taskId: "task-1",
        bugId: "bug-1",
        armId: "arm-1",
        classification: "bug_fix",
        metadata: {
          originalEvent: {
            type: "report_bug",
            data: { errorDetails: "dimension mismatch", title: "Indexer failed" },
          },
          stream: { subject: "coleo.events.bug", streamSequence: 42 },
        },
      };

      const text = eventToText(event);

      expect(text).toContain('\"classification\":\"bug_fix\"');
      expect(text).toContain('\"taskId\":\"task-1\"');
      expect(text).toContain('\"bugId\":\"bug-1\"');
      expect(text).toContain('\"errorDetails\":\"dimension mismatch\"');
      expect(text).toContain('\"streamSequence\":42');
      expect(eventToText({ ...event, metadata: { ...event.metadata } })).toBe(text);
      expect(text).not.toContain('\"vector\"');
    });
  });

  describe("createEventId", () => {
    it("should create unique ID with type, source, and timestamp", () => {
      const timestamp = "2024-01-15T10:30:00.000Z";
      const id = createEventId("status_report", "arm-1", timestamp);

      expect(id).toContain("status_report");
      expect(id).toContain("arm-1");
      expect(id).toContain(timestamp);
    });

    it("should handle Date objects", () => {
      const date = new Date("2024-01-15T10:30:00.000Z");
      const id = createEventId("discovery", "arm-2", date);

      expect(id).toContain("discovery");
      expect(id).toContain("arm-2");
      expect(id).toContain(date.toISOString());
    });
  });
});
