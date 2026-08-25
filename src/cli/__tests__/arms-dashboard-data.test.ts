import { describe, expect, it } from "bun:test";
import {
  isDashboardHeartbeatActivity,
  type DashboardActivityEntry,
} from "../tui/arms-dashboard-data";

function activity(action: string, eventType?: string): DashboardActivityEntry {
  return {
    timestamp: "2026-08-20T00:00:00.000Z",
    actor: "arm-a",
    action,
    target: "arm-a",
    details: eventType ? { eventType } : {},
  };
}

describe("arms dashboard activity filtering", () => {
  it("identifies heartbeat actions and event types", () => {
    expect(isDashboardHeartbeatActivity(activity("arm.heartbeat"))).toBe(true);
    expect(isDashboardHeartbeatActivity(activity("event", "server-heartbeat"))).toBe(true);
    expect(isDashboardHeartbeatActivity(activity("arm.status_changed"))).toBe(false);
  });
});
