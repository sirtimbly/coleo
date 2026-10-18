import { describe, expect, it } from "bun:test";

import {
  buildActivityMetricBuckets,
  classifyActivityMetric,
  parseTelemetryRange,
} from "../routes/events";

describe("activity metric classification", () => {
  it("ignores lifecycle telemetry instead of counting it as tool activity", () => {
    expect(classifyActivityMetric("arm.heartbeat", {})).toBeNull();
    expect(classifyActivityMetric("session.status", {})).toBeNull();
    expect(classifyActivityMetric("message.updated", {})).toBeNull();
  });

  it("counts explicit activity categories", () => {
    expect(classifyActivityMetric("file.edited", {})).toBe("write");
    expect(classifyActivityMetric("message.part.updated", { part: { type: "reasoning" } })).toBe("think");
    expect(classifyActivityMetric("message.part.updated", { part: { type: "tool" } })).toBe("tool");
    expect(classifyActivityMetric("task.completed", {})).toBe("complete");
  });
});

describe("all-arm telemetry ranges", () => {
  it("uses adaptive buckets for explicit ranges", () => {
    const range = parseTelemetryRange(
      "2026-07-27T00:00:00.000Z",
      "2026-07-28T00:00:00.000Z",
    );
    expect(range.bucketMs).toBe(12 * 60 * 1000);
  });

  it("rejects invalid and oversized ranges", () => {
    expect(() => parseTelemetryRange("invalid", "2026-07-28T00:00:00.000Z")).toThrow();
    expect(() => parseTelemetryRange(
      "2026-07-01T00:00:00.000Z",
      "2026-07-28T00:00:00.000Z",
    )).toThrow("Telemetry ranges cannot exceed 7 days");
  });

  it("combines classified activity from every arm within the range", () => {
    const start = new Date("2026-07-28T10:00:00.000Z");
    const end = new Date("2026-07-28T10:02:00.000Z");
    const result = buildActivityMetricBuckets([
      {
        armId: "arm-1",
        type: "file.edited",
        timestamp: "2026-07-28T10:00:10.000Z",
        data: {},
      },
      {
        armId: "arm-2",
        type: "tool.call",
        timestamp: "2026-07-28T10:01:10.000Z",
        data: {},
      },
      {
        armId: "arm-3",
        type: "file.edited",
        timestamp: "2026-07-28T09:59:59.000Z",
        data: {},
      },
    ], start, end, 60_000);

    expect(result.totalEvents).toBe(2);
    expect(result.buckets[0]?.counts.write).toBe(1);
    expect(result.buckets[1]?.counts.tool).toBe(1);
  });
});
