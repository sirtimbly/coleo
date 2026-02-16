import { describe, expect, it } from "bun:test";
import { ArmHealthMonitor, type HealthMonitorCallbacks } from "../health-monitor";
import type { ArmAnalysis } from "../activity-analyzer";

function createIdleAnalysis(overrides?: Partial<ArmAnalysis>): ArmAnalysis {
  return {
    armId: "arm-1",
    state: "idle",
    confidence: "medium",
    reason: "No productive activity detected",
    recommendedAction: "prompt",
    metrics: {
      eventCount: 0,
      silentDurationMs: 10 * 60 * 1000,
      lastEventAt: null,
      recentMessageCount: 0,
      recentToolCount: 0,
      recentFileEditCount: 0,
    },
    unknownEventTypes: [],
    ...overrides,
  };
}

describe("ArmHealthMonitor", () => {
  it("suppresses silent prompt for newly seen arm with no events", async () => {
    let promptCount = 0;

    const callbacks: HealthMonitorCallbacks = {
      getActiveArmIds: async () => ["arm-1"],
      sendPromptToArm: async () => {
        promptCount++;
      },
      interruptArm: async () => {},
      killArm: async () => {},
      notifyHuman: async () => {},
      replyToPermission: async () => {},
    };

    const monitor = new ArmHealthMonitor(callbacks, {
      eventWindow: {
        getWindowsForAllArms: async () =>
          new Map([["arm-1", { armId: "arm-1", events: [] }]]),
      } as any,
      analyzer: {
        analyzeAll: () =>
          new Map([
            [
              "arm-1",
              {
                ...createIdleAnalysis(),
                state: "silent",
                reason: "No events for 600s",
              },
            ],
          ]),
      } as any,
      log: () => {},
      config: {
        autoInterventionEnabled: true,
        startupGracePeriodMs: 10 * 60 * 1000,
      },
    });

    const result = await monitor.runHealthCheck();

    expect(promptCount).toBe(0);
    expect(result.interventions.length).toBe(0);
  });

  it("suppresses idle prompt when runtime state is processing", async () => {
    let promptCount = 0;

    const callbacks: HealthMonitorCallbacks = {
      getActiveArmIds: async () => ["arm-1"],
      sendPromptToArm: async () => {
        promptCount++;
      },
      interruptArm: async () => {},
      killArm: async () => {},
      notifyHuman: async () => {},
      replyToPermission: async () => {},
      getArmRuntimeState: async () => ({ state: "processing", hasSession: true }),
    };

    const monitor = new ArmHealthMonitor(callbacks, {
      eventWindow: {
        getWindowsForAllArms: async () =>
          new Map([["arm-1", { armId: "arm-1", events: [] }]]),
      } as any,
      analyzer: {
        analyzeAll: () =>
          new Map([
            [
              "arm-1",
              createIdleAnalysis({
                metrics: {
                  eventCount: 1,
                  silentDurationMs: 30_000,
                  lastEventAt: new Date(Date.now() - 30_000),
                  recentMessageCount: 0,
                  recentToolCount: 0,
                  recentFileEditCount: 0,
                },
              }),
            ],
          ]),
      } as any,
      log: () => {},
      config: {
        autoInterventionEnabled: true,
      },
    });

    const result = await monitor.runHealthCheck();

    expect(promptCount).toBe(0);
    expect(result.interventions.length).toBe(0);
  });

  it("does not suppress prompt when runtime processing appears stale", async () => {
    let promptCount = 0;

    const callbacks: HealthMonitorCallbacks = {
      getActiveArmIds: async () => ["arm-1"],
      sendPromptToArm: async () => {
        promptCount++;
      },
      interruptArm: async () => {},
      killArm: async () => {},
      notifyHuman: async () => {},
      replyToPermission: async () => {},
      getArmRuntimeState: async () => ({ state: "processing", hasSession: true }),
    };

    const monitor = new ArmHealthMonitor(callbacks, {
      eventWindow: {
        getWindowsForAllArms: async () =>
          new Map([["arm-1", { armId: "arm-1", events: [] }]]),
      } as any,
      analyzer: {
        analyzeAll: () =>
          new Map([
            [
              "arm-1",
              createIdleAnalysis({
                state: "silent",
                reason: "No events for 600s",
                metrics: {
                  eventCount: 0,
                  silentDurationMs: 10 * 60 * 1000,
                  lastEventAt: null,
                  recentMessageCount: 0,
                  recentToolCount: 0,
                  recentFileEditCount: 0,
                },
              }),
            ],
          ]),
      } as any,
      log: () => {},
      config: {
        autoInterventionEnabled: true,
        startupGracePeriodMs: 0,
      },
    });

    const result = await monitor.runHealthCheck();

    expect(promptCount).toBe(1);
    expect(result.interventions.length).toBe(1);
    expect(result.interventions[0]?.type).toBe("prompt");
  });

  it("suppresses idle prompt when last event is within idle prompt delay", async () => {
    let promptCount = 0;

    const callbacks: HealthMonitorCallbacks = {
      getActiveArmIds: async () => ["arm-1"],
      sendPromptToArm: async () => {
        promptCount++;
      },
      interruptArm: async () => {},
      killArm: async () => {},
      notifyHuman: async () => {},
      replyToPermission: async () => {},
    };

    const monitor = new ArmHealthMonitor(callbacks, {
      eventWindow: {
        getWindowsForAllArms: async () =>
          new Map([["arm-1", { armId: "arm-1", events: [] }]]),
      } as any,
      analyzer: {
        analyzeAll: () =>
          new Map([
            [
              "arm-1",
              createIdleAnalysis({
                metrics: {
                  eventCount: 1,
                  silentDurationMs: 5_000,
                  lastEventAt: new Date(Date.now() - 5_000),
                  recentMessageCount: 0,
                  recentToolCount: 0,
                  recentFileEditCount: 0,
                },
              }),
            ],
          ]),
      } as any,
      log: () => {},
      config: {
        autoInterventionEnabled: true,
      },
    });

    const result = await monitor.runHealthCheck();

    expect(promptCount).toBe(0);
    expect(result.interventions.length).toBe(0);
  });

  it("sends prompt when arm is truly idle", async () => {
    let promptCount = 0;

    const callbacks: HealthMonitorCallbacks = {
      getActiveArmIds: async () => ["arm-1"],
      sendPromptToArm: async () => {
        promptCount++;
      },
      interruptArm: async () => {},
      killArm: async () => {},
      notifyHuman: async () => {},
      replyToPermission: async () => {},
      getArmRuntimeState: async () => ({ state: "idle", hasSession: true }),
    };

    const monitor = new ArmHealthMonitor(callbacks, {
      eventWindow: {
        getWindowsForAllArms: async () =>
          new Map([["arm-1", { armId: "arm-1", events: [] }]]),
      } as any,
      analyzer: {
        analyzeAll: () =>
          new Map([
            [
              "arm-1",
              createIdleAnalysis({
                metrics: {
                  eventCount: 0,
                  silentDurationMs: 15 * 60 * 1000,
                  lastEventAt: new Date(Date.now() - 15 * 60 * 1000),
                  recentMessageCount: 0,
                  recentToolCount: 0,
                  recentFileEditCount: 0,
                },
              }),
            ],
          ]),
      } as any,
      log: () => {},
      config: {
        autoInterventionEnabled: true,
      },
    });

    const result = await monitor.runHealthCheck();

    expect(promptCount).toBe(1);
    expect(result.interventions.length).toBe(1);
    expect(result.interventions[0]?.type).toBe("prompt");
  });
});
