import { describe, expect, it } from "bun:test";
import {
  COST_POLL_INTERVAL_MS,
  COST_RATE_WINDOW_MS,
  COST_WINDOW_MS,
  buildCostSamplesFromMessages,
  computeCostRatePerHour,
  mergeCostSamples,
  parseMessageTimestamp,
  withCumulativeCost,
  type CostSample,
} from "../src/components/arm-cost-usage-helpers";

describe("ArmCostUsageChart helpers", () => {
  it("exposes cost constants matching the spec cadence", () => {
    expect(COST_WINDOW_MS).toBe(30 * 60 * 1000);
    expect(COST_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(10_000);
    expect(COST_POLL_INTERVAL_MS).toBeLessThanOrEqual(15_000);
    expect(COST_RATE_WINDOW_MS).toBeGreaterThan(0);
  });

  it("parses numeric, ISO string, and object message timestamps", () => {
    expect(parseMessageTimestamp(1_700_000_000)).toBe(1_700_000_000_000);
    expect(parseMessageTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(parseMessageTimestamp("1700000000")).toBe(1_700_000_000_000);
    expect(parseMessageTimestamp("2026-07-27T21:00:00Z")).toBeGreaterThan(0);
    expect(parseMessageTimestamp({ completed: 1_700_000_000 } as never)).toBe(1_700_000_000_000);
    expect(parseMessageTimestamp(undefined)).toBeNull();
    expect(parseMessageTimestamp(null)).toBeNull();
  });

  it("builds cumulative-cost samples from messages, oldest first", () => {
    const messages = [
      { info: { id: "m1", cost: 0.001, time: 1_700_000_000_000 } },
      { info: { id: "m2", cost: 0.002, time: 1_700_000_001_000 } },
      { info: { id: "m3", cost: 0.004, time: 1_700_000_002_000 } },
    ];
    const samples = buildCostSamplesFromMessages(messages);
    expect(samples).toHaveLength(3);
    const cumulative = withCumulativeCost(samples);
    expect(cumulative[0]!.cumulativeCost).toBeCloseTo(0.001, 6);
    expect(cumulative[1]!.cumulativeCost).toBeCloseTo(0.003, 6);
    expect(cumulative[2]!.cumulativeCost).toBeCloseTo(0.007, 6);
  });

  it("skips messages with zero or undefined cost", () => {
    const messages = [
      { info: { id: "m1", cost: 0, time: 1_700_000_000_000 } },
      { info: { id: "m2", cost: undefined, time: 1_700_000_001_000 } },
      { info: { id: "m3", cost: 0.003, time: 1_700_000_002_000 } },
    ];
    const samples = buildCostSamplesFromMessages(messages);
    expect(samples).toHaveLength(1);
    const cumulative = withCumulativeCost(samples);
    expect(cumulative[0]!.cumulativeCost).toBeCloseTo(0.003, 6);
  });

  it("computes a positive cost rate when spend is increasing", () => {
    const now = Date.now();
    const samples: CostSample[] = [
      { messageId: "m1", timestamp: now - 60_000, messageCost: 0.05, inputTokens: 1, outputTokens: 0 },
      { messageId: "m2", timestamp: now, messageCost: 0.2, inputTokens: 10, outputTokens: 5 },
    ];
    const cumulative = withCumulativeCost(samples);
    const rate = computeCostRatePerHour(cumulative, now);
    expect(rate).toBeGreaterThan(0);
  });

  it("returns zero rate when there are fewer than two qualifying samples", () => {
    const now = Date.now();
    expect(computeCostRatePerHour([], now)).toBe(0);
    const single: CostSample[] = [
      { messageId: "m1", timestamp: now, messageCost: 0.1, inputTokens: 1, outputTokens: 1 },
    ];
    expect(computeCostRatePerHour(withCumulativeCost(single), now)).toBe(0);
  });

  it("returns zero rate when no samples are within the recent window", () => {
    const now = Date.now();
    const samples: CostSample[] = [
      {
        messageId: "m1",
        timestamp: now - COST_RATE_WINDOW_MS - 60_000,
        messageCost: 0.05,
        inputTokens: 1,
        outputTokens: 0,
      },
      {
        messageId: "m2",
        timestamp: now - COST_RATE_WINDOW_MS - 30_000,
        messageCost: 0.2,
        inputTokens: 10,
        outputTokens: 5,
      },
    ];
    expect(computeCostRatePerHour(withCumulativeCost(samples), now)).toBe(0);
  });

  it("withCumulativeCost totals spend across all samples", () => {
    const now = Date.now();
    const samples: CostSample[] = [
      { messageId: "a", timestamp: now - 2000, messageCost: 0.1, inputTokens: 1, outputTokens: 0 },
      { messageId: "b", timestamp: now - 1000, messageCost: 0.2, inputTokens: 2, outputTokens: 1 },
      { messageId: "c", timestamp: now, messageCost: 0.4, inputTokens: 4, outputTokens: 2 },
    ];
    const cumulative = withCumulativeCost(samples);
    expect(cumulative).toHaveLength(3);
    expect(cumulative[0]!.cumulativeCost).toBeCloseTo(0.1, 6);
    expect(cumulative[1]!.cumulativeCost).toBeCloseTo(0.3, 6);
    expect(cumulative[2]!.cumulativeCost).toBeCloseTo(0.7, 6);
  });

  it("withCumulativeCost orders samples by timestamp before totalling", () => {
    const now = Date.now();
    const samples: CostSample[] = [
      { messageId: "later", timestamp: now + 1000, messageCost: 0.5, inputTokens: 0, outputTokens: 0 },
      { messageId: "earlier", timestamp: now - 1000, messageCost: 0.1, inputTokens: 0, outputTokens: 0 },
    ];
    const cumulative = withCumulativeCost(samples);
    expect(cumulative[0]!.messageId).toBe("earlier");
    expect(cumulative[1]!.messageId).toBe("later");
    expect(cumulative[1]!.cumulativeCost).toBeCloseTo(0.6, 6);
  });

  it("mergeCostSamples dedups by messageId, favouring the fresh batch", () => {
    const stored: CostSample[] = [
      { messageId: "m1", timestamp: 1000, messageCost: 0.05, inputTokens: 1, outputTokens: 0 },
      { messageId: "m2", timestamp: 2000, messageCost: 0.05, inputTokens: 1, outputTokens: 0 },
    ];
    const fresh: CostSample[] = [
      { messageId: "m2", timestamp: 2000, messageCost: 0.08, inputTokens: 2, outputTokens: 1 },
      { messageId: "m3", timestamp: 3000, messageCost: 0.04, inputTokens: 1, outputTokens: 0 },
    ];
    const merged = mergeCostSamples(stored, fresh);
    expect(merged).toHaveLength(3);
    const m2 = merged.find((s) => s.messageId === "m2")!;
    expect(m2.messageCost).toBe(0.08);
    expect(merged.some((s) => s.messageId === "m3")).toBe(true);
  });
});
