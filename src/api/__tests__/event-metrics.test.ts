import { describe, expect, it } from "bun:test";

import { classifyActivityMetric } from "../routes/events";

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
