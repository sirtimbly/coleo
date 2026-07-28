import { describe, expect, it } from "bun:test";
import {
  classifyActivity,
  CATEGORY_STYLES,
  type ActivityCategory,
} from "../src/components/arm-activity-classify";
import type { ViewerActivityItem } from "../src/pages/arm-viewer-activity";

function item(
  type: ViewerActivityItem["type"],
  status: ViewerActivityItem["status"] = "info",
  details?: ViewerActivityItem["details"],
  title = type,
): ViewerActivityItem {
  return {
    id: `${type}-${status}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    title,
    status,
    timestamp: Date.now(),
    details,
  };
}

describe("ArmActivityChart classifier", () => {
  it("exposes the four spec categories with the spec colors", () => {
    const keys = CATEGORY_STYLES.map((style) => style.key);
    expect(keys).toEqual(["write", "think", "tool", "complete"]);

    const colors = Object.fromEntries(
      CATEGORY_STYLES.map((style) => [style.key, style.color]),
    );
    expect(colors.write).toBe("#3b82f6");
    expect(colors.think).toBe("#eab308");
    expect(colors.tool).toBe("#22c55e");
    expect(colors.complete).toBe("#a855f7");
  });

  it("classifies file-edited events as blue writes", () => {
    expect(classifyActivity(item("file", "completed"))).toBe<ActivityCategory>("write");
  });

  it("classifies assistant message events as yellow thinking", () => {
    const message = item(
      "message",
      "running",
      { role: "assistant" } as ViewerActivityItem["details"],
      "Assistant message",
    );
    expect(classifyActivity(message)).toBe<ActivityCategory>("think");
  });

  it("classifies tool events as green tool calls", () => {
    expect(classifyActivity(item("tool", "running"))).toBe<ActivityCategory>("tool");
  });

  it("classifies step-finish activity as purple completion", () => {
    expect(classifyActivity(item("step", "completed"))).toBe<ActivityCategory>("complete");
  });

  it("classifies completed todo updates as purple completion", () => {
    expect(classifyActivity(item("todo", "completed"))).toBe<ActivityCategory>("complete");
  });

  it("keeps a running session out of the completion bar", () => {
    expect(classifyActivity(item("session", "running"))).toBe<ActivityCategory>("think");
  });
});
